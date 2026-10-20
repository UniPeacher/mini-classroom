import { isNotNull } from 'drizzle-orm';
import { CORE_FORMS, EXPLAIN_FORMS, FORM_INFO, QUESTION_FORMS, STAGE_QUESTION_FORMS } from '../domain/forms';
import { enqueue } from '../jobs/queue';
import { type UserSettings, readUserSettings, writeUserSettings } from '../settings';
import type { Db } from '../store/db';
import { sessions } from '../store/schema';
import { dayFormatter, timeFormatter } from './views';

export interface PreferencesDeps {
  db: Db;
}

/** 提醒时段前这么多分钟内已完成一节，就视为这个时段已学完 */
const SLOT_LEAD_MINUTES = 60;

const STAGE_LABELS = { understand: '理解（讲解后的小题）', recall: '回忆', apply: '应用', retain: '保持' } as const;

/** 设置与今天的学习安排（提醒时段、每日节数上限） */
export function createPreferences({ db }: PreferencesDeps) {
  /** 设置及形式目录：设置页据此列出可屏蔽、可调高的形式，核心检验形式标为不可屏蔽 */
  function getSettings() {
    return {
      settings: readUserSettings(db),
      forms: {
        explain: EXPLAIN_FORMS.map((f) => ({ id: f, label: FORM_INFO[f].label, mobile: FORM_INFO[f].mobile })),
        question: QUESTION_FORMS.map((f) => ({
          id: f,
          label: FORM_INFO[f].label,
          mobile: FORM_INFO[f].mobile,
          core: CORE_FORMS.includes(f),
          stages: Object.entries(STAGE_QUESTION_FORMS)
            .filter(([, s]) => s.forms.includes(f))
            .map(([stage, s]) => ({ stage: STAGE_LABELS[stage as keyof typeof STAGE_LABELS], core: s.core === f })),
        })),
      },
    };
  }

  /** 保存设置；形式偏好或节奏变了，候选池按新设置补充 */
  function updateSettings(patch: Partial<UserSettings>, now: Date) {
    const saved = writeUserSettings(db, patch, now);
    enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return saved;
  }

  /**
   * 今天的学习安排：已完成几节、上限，以及每个提醒时段是否已学完。
   * 某时段前 60 分钟起到下一个时段之前完成过一节，这个时段就算学完，到点不再提醒。
   */
  function today(now: Date, timeZone: string) {
    const settings = readUserSettings(db);
    const dayOf = dayFormatter(timeZone);
    const timeOf = timeFormatter(timeZone);
    const todayKey = dayOf(now);
    const finishedTimes = db
      .select({ finishedAt: sessions.finishedAt })
      .from(sessions)
      .where(isNotNull(sessions.finishedAt))
      .all()
      .filter((s) => dayOf(s.finishedAt!) === todayKey)
      .map((s) => minutesOf(timeOf(s.finishedAt!)));
    const slots = [...settings.reminderTimes].sort();
    return {
      date: todayKey,
      now: timeOf(now),
      sessionsToday: finishedTimes.length,
      dailySessionCap: settings.dailySessionCap,
      slots: slots.map((time, i) => {
        const from = minutesOf(time) - SLOT_LEAD_MINUTES;
        const to = i + 1 < slots.length ? minutesOf(slots[i + 1]!) - SLOT_LEAD_MINUTES : 24 * 60;
        return { time, done: finishedTimes.some((m) => m >= from && m < to) };
      }),
    };
  }

  return { getSettings, updateSettings, today };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

export type Preferences = ReturnType<typeof createPreferences>;
