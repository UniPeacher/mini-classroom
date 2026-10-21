import { FORM_INFO, type Form } from '../domain/forms';
import { type MemoryState, reviveCard } from '../domain/memory';
import type { ConnectionContent, LessonContent, Question, ReviewContent } from '../shared/content';
import type { attempts, items } from '../store/schema';

export type ItemRow = typeof items.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;

/** 作答：选择题、点选错误行提交序号（摸底选"不知道"为 -1），其余提交文字 */
export type Answer = { choice: number } | { text: string };

/** 申诉记录 */
export interface Appeal {
  reason: string;
  outcome: 'accepted' | 'void' | 'rejected';
  feedback: string;
  at: string;
}

/** 业务错误：由接口层转成 4xx */
export class LearningError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export function formLabel(form: string): string {
  if (form === 'connection') return '联结练习';
  return FORM_INFO[form as Form]?.label ?? form;
}

export function questionOf(item: ItemRow): Question | null {
  if (item.kind === 'lesson') return (item.content as LessonContent).check;
  if (item.kind === 'review') return (item.content as ReviewContent).question;
  return null;
}

/** 给前端看的题目：作答前不包含答案 */
export function hideAnswer(question: Question) {
  switch (question.type) {
    case 'mcq':
      return { type: question.type, stem: question.stem, material: question.material ?? null, options: question.options.map((o) => o.text) };
    case 'short_answer':
      return { type: question.type, prompt: question.prompt, material: question.material ?? null };
    case 'pick_line':
      return { type: question.type, prompt: question.prompt, language: question.language, lines: question.lines };
    case 'complete':
      return { type: question.type, prompt: question.prompt, language: question.language, template: question.template };
    case 'fix':
      return { type: question.type, prompt: question.prompt, language: question.language, flawed: question.flawed };
  }
}

export type HiddenQuestion = ReturnType<typeof hideAnswer>;

/** 作答后展示的参考答案 */
export function reveal(question: Question) {
  if (question.type === 'mcq' || question.type === 'pick_line') {
    return { answerIndex: question.answerIndex, explanation: question.explanation };
  }
  return { referenceAnswer: question.referenceAnswer, keyPoints: question.keyPoints };
}

/** 一节里一项内容的展示部分：讲解、分步、预测、题目或联结练习 */
export function itemBody(item: ItemRow) {
  if (item.kind === 'connection') {
    const content = item.content as ConnectionContent;
    return { explanation: null, steps: null, predict: null, question: null, connection: { prompt: content.prompt, partner: content.partner.title } };
  }
  const question = questionOf(item)!;
  const lesson = item.kind === 'lesson' ? (item.content as LessonContent) : null;
  return {
    explanation: lesson?.explanation ?? null,
    steps: lesson?.steps ?? null,
    predict: lesson?.predict ?? null,
    question: hideAnswer(question),
    connection: null,
  };
}

/** 一次作答的完整留档：作答过的题目连同答案一起给出 */
export function toRecord({ attempt, item }: { attempt: AttemptRow; item: ItemRow }) {
  const lesson = item.kind === 'lesson' ? (item.content as LessonContent) : null;
  return {
    attemptId: attempt.id,
    at: attempt.createdAt,
    kind: item.kind,
    form: item.form,
    formLabel: formLabel(item.form),
    explanation: lesson?.explanation ?? null,
    steps: lesson?.steps ?? null,
    question: questionOf(item),
    connection: item.kind === 'connection' ? (item.content as ConnectionContent) : null,
    answer: attempt.answer as Answer,
    correct: attempt.correct,
    errorType: attempt.errorType,
    feedback: attempt.feedback,
    selfRating: attempt.selfRating,
    appeal: (attempt.appeal as Appeal | null) ?? null,
    voided: attempt.voided,
  };
}

/** 从数据库 JSON 还原记忆状态快照（申诉改判时使用） */
export function stateFromJson(raw: unknown): MemoryState | null {
  if (raw === null || raw === undefined) return null;
  const state = raw as MemoryState;
  return { ...state, card: reviveCard(state.card) };
}

const HOUR_MS = 3600 * 1000;

/** 把时间换算成某个时区的日期（YYYY-MM-DD）；时区名不合法时报 400 */
export function dayFormatter(timeZone: string): (date: Date) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new LearningError(`不认识的时区：${timeZone}`, 400);
  }
  return (date) => format.format(date);
}

/** 某时区的"那一天"在 UTC 上一定落在这个范围里（前后各放宽 14 小时，覆盖所有时区），用于先粗筛 */
export function dayRange(day: string): { from: Date; to: Date } {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  return { from: new Date(dayStart - 14 * HOUR_MS), to: new Date(dayStart + 38 * HOUR_MS) };
}

/** 某时区里一天中的时刻（HH:MM） */
export function timeFormatter(timeZone: string): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (date) => format.format(date);
}

export const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
