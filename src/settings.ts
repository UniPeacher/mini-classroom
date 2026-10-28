import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CORE_FORMS, EXPLAIN_FORMS, type FormPrefs, QUESTION_FORMS } from './domain/forms';
import {
  type ContentGuidance,
  DEFAULT_CONTENT_GUIDANCE,
  GUIDANCE_MAX_LENGTH,
  resolveContentGuidance,
} from './shared/content-guidance';
import type { Executor } from './store/db';
import { appSettings } from './store/schema';

/**
 * 用户在设置页可调整的学习参数。
 *
 * 学科归属与内容风格已移到"学科 → 课程 → 学习主题"的独立组织模型：
 * 这里只保留共用表达规则（教程/配图引导词）与学习节奏，不再有分组、逐标签风格或扁平映射。
 */
export const UserSettingsSchema = z.object({
  /** 一节微课堂的时长（分钟） */
  sessionMinutes: z.number().int().min(5, '一节至少 5 分钟').max(30, '一节最多 30 分钟'),
  /** 每节最多引入的新知识点数 */
  maxNewPerSession: z.number().int().min(1, '每节至少 1 个新知识点').max(5, '每节最多 5 个新知识点'),
  /** 每天的提醒时段，如 "13:30" */
  reminderTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')).max(6, '最多 6 个提醒时段'),
  /** 每日节数上限；null 表示不限 */
  dailySessionCap: z.number().int().min(1).max(20).nullable(),
  /** 主题回访间隔（天） */
  revisitIntervalDays: z.number().int().min(1).max(90),
  /** 屏蔽的形式：核心检验形式不能屏蔽 */
  blockedForms: z
    .array(z.enum([...EXPLAIN_FORMS, ...QUESTION_FORMS]))
    .refine((forms) => forms.every((f) => !(CORE_FORMS as readonly string[]).includes(f)), '核心检验形式不能屏蔽'),
  /** 调高偏好的讲解形式 */
  boostedExplainForms: z.array(z.enum(EXPLAIN_FORMS)),
  /** null 表示采用默认教程引导词。 */
  tutorialGuidance: z.string().trim().max(GUIDANCE_MAX_LENGTH, `教程引导词不超过 ${GUIDANCE_MAX_LENGTH} 字`).nullable(),
  /** null 表示采用默认配图引导词。 */
  figureGuidance: z.string().trim().max(GUIDANCE_MAX_LENGTH, `配图引导词不超过 ${GUIDANCE_MAX_LENGTH} 字`).nullable(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  sessionMinutes: 10,
  maxNewPerSession: 2,
  reminderTimes: [],
  dailySessionCap: null,
  revisitIntervalDays: 14,
  blockedForms: [],
  boostedExplainForms: [],
  tutorialGuidance: null,
  figureGuidance: null,
};

/**
 * 已停用的旧分类字段：分组、逐标签风格、扁平映射。
 * 它们只作为升级迁移的来源保留在已存储的原始 JSON 里，不再参与运行期解析。
 */
export const DEPRECATED_SETTING_KEYS = ['subjectGroups', 'tagStyles', 'subjectStyles'] as const;

/** 学习流程实际使用的参数：用户设置 + 部署配置 */
export interface Settings {
  /** 一节微课堂的时间预算（秒） */
  budgetSeconds: number;
  /** 每节最多引入的新知识点数 */
  maxNewPerSession: number;
  /** 补候选池时同时向模型发起的请求数（部署配置，来自环境变量） */
  generationConcurrency: number;
  reminderTimes: string[];
  dailySessionCap: number | null;
  revisitIntervalDays: number;
  formPrefs: FormPrefs;
  /** 共用表达规则。学科预设的补充要求由 src/teaching.ts 在解析教学配置时追加 */
  contentGuidance: ContentGuidance;
}

type SettingsShape = typeof UserSettingsSchema.shape;

/** 去掉字段上的默认值再设为可选：带默认值的字段在部分更新时不能被补上默认值 */
function optionalField(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodDefault ? (schema as z.ZodDefault<z.ZodType>).unwrap().optional() : schema.optional();
}

/**
 * 部分更新用的 schema：从完整 schema 的字段定义派生，不重复维护约束。
 *
 * 直接 `partial()` 不会去掉字段上的默认值，缺省字段会被补上默认值（如空数组），
 * 合并时可能把已保存的配置冲掉。这里逐字段解包默认值后再设为可选。
 *
 * 保留未识别的键（catchall），由保存流程明确拒绝已停用的旧分类字段并给出可操作的提示，
 * 而不是悄悄忽略它们、让调用方以为旧配置仍在生效。
 */
export const UserSettingsPatchSchema = z
  .object(
    Object.fromEntries(
      (Object.keys(UserSettingsSchema.shape) as (keyof SettingsShape)[]).map((key) => [
        key,
        optionalField(UserSettingsSchema.shape[key]),
      ]),
    ) as { [K in keyof SettingsShape]: z.ZodType<z.infer<SettingsShape[K]> | undefined> },
  )
  .catchall(z.unknown());

/** 页面提交的修改：只校验传了的字段 */
export type UserSettingsPatch = z.infer<typeof UserSettingsPatchSchema>;

/** 存储的原始 JSON：可能含旧版字段、未知字段或被手工改坏的字段 */
export type StoredUserSettings = Record<string, unknown>;

/** 逐字段读取的结果：可用设置、原始存储、被跳过的字段 */
export interface UserSettingsRead {
  settings: UserSettings;
  /** 原始存储内容（含旧分类字段与未知字段），升级迁移与问题排查用 */
  raw: StoredUserSettings;
  /** 校验不通过、按默认值处理的字段，保留原始值供迁移快照 */
  invalidFields: StoredUserSettings;
}

const USER_SETTINGS_KEY = 'user_settings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultsWithEnv(env: NodeJS.ProcessEnv): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    sessionMinutes: env.SESSION_BUDGET_SECONDS ? Math.round(Number(env.SESSION_BUDGET_SECONDS) / 60) : DEFAULT_USER_SETTINGS.sessionMinutes,
    maxNewPerSession: env.MAX_NEW_PER_SESSION ? Number(env.MAX_NEW_PER_SESSION) : DEFAULT_USER_SETTINGS.maxNewPerSession,
  };
}

/**
 * 逐字段读取用户设置。
 *
 * 早期版本在同一个键下存了分组、逐标签风格等字段。这里只认当前字段，
 * 且每个字段单独校验：某个字段被改坏时只让这一项回到默认，不会把整份偏好重置；
 * 原始值仍完整保留在 raw / invalidFields 中，供升级迁移与问题排查使用。
 */
export function readUserSettingsRead(db: Executor, env: NodeJS.ProcessEnv = process.env): UserSettingsRead {
  const row = db.select().from(appSettings).where(eq(appSettings.key, USER_SETTINGS_KEY)).get();
  const raw = isRecord(row?.value) ? row.value : {};
  const settings = defaultsWithEnv(env);
  const invalidFields: StoredUserSettings = {};
  for (const [key, schema] of Object.entries(UserSettingsSchema.shape)) {
    if (!(key in raw)) continue;
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) {
      (settings as Record<string, unknown>)[key] = parsed.data;
    } else {
      invalidFields[key] = raw[key];
    }
  }
  return { settings, raw, invalidFields };
}

/** 读取用户设置：数据库里没有的项用默认值（环境变量可覆盖默认的时长和新知识点数） */
export function readUserSettings(db: Executor, env: NodeJS.ProcessEnv = process.env): UserSettings {
  return readUserSettingsRead(db, env).settings;
}

/** 旧的分类配置快照：升级迁移读取一次，运行期不再使用 */
export function readLegacySettingsSnapshot(db: Executor): StoredUserSettings {
  const { raw } = readUserSettingsRead(db);
  return Object.fromEntries(DEPRECATED_SETTING_KEYS.filter((key) => key in raw).map((key) => [key, raw[key]]));
}

/** 旧分类字段已不再接受写入；用它们做参数时报错，指向新的组织接口 */
function rejectDeprecatedFields(patch: Record<string, unknown>): void {
  const used = DEPRECATED_SETTING_KEYS.filter((key) => key in patch);
  if (used.length > 0) {
    throw new Error(`学科分组与内容风格已改为"学科与课程"管理（${used.join('、')} 不再支持在这里保存）`);
  }
}

/**
 * 保存用户设置：只改传入的项，校验不通过时抛出 ZodError。
 *
 * 存储时保留未被管理的字段（例如旧分类配置），这样升级迁移仍能读到原始快照，
 * 不会因为用户改了一次学习节奏就把旧配置抹掉。
 */
export function writeUserSettings(
  db: Executor,
  patch: Partial<UserSettings> | UserSettingsPatch,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): UserSettings {
  rejectDeprecatedFields(patch as Record<string, unknown>);
  // patch 已由调用方按 UserSettingsPatchSchema 校验；这里再校验合并结果，保证整体一致
  const merged: UserSettings = { ...readUserSettings(db, env), ...(patch as Partial<UserSettings>) };
  const next = UserSettingsSchema.parse(merged);
  if (!next.tutorialGuidance || next.tutorialGuidance === DEFAULT_CONTENT_GUIDANCE.tutorialGuidance) next.tutorialGuidance = null;
  if (!next.figureGuidance || next.figureGuidance === DEFAULT_CONTENT_GUIDANCE.figureGuidance) next.figureGuidance = null;
  const raw = readUserSettingsRead(db, env).raw;
  const value: StoredUserSettings = { ...raw, ...next };
  db.insert(appSettings)
    .values({ key: USER_SETTINGS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
  return next;
}

export function toSettings(user: UserSettings, env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    budgetSeconds: user.sessionMinutes * 60,
    maxNewPerSession: user.maxNewPerSession,
    generationConcurrency: Number(env.GENERATION_CONCURRENCY ?? 3),
    reminderTimes: user.reminderTimes,
    dailySessionCap: user.dailySessionCap,
    revisitIntervalDays: user.revisitIntervalDays,
    formPrefs: { blocked: user.blockedForms, boosted: user.boostedExplainForms },
    contentGuidance: resolveContentGuidance(user),
  };
}

/** 学习流程每次读取最新设置：设置页改动后立即生效 */
export function settingsSource(db: Executor, env: NodeJS.ProcessEnv = process.env): () => Settings {
  return () => toSettings(readUserSettings(db, env), env);
}

// ---------- 少量应用状态（如上次主题回访的时间） ----------

export function readState<T>(db: Executor, key: string): T | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

export function writeState(db: Executor, key: string, value: unknown, now: Date): void {
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
}
