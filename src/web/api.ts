import type { AiSettingsPatch } from '../ai-settings';
import type { Stage } from '../domain/memory';
import type { Services } from '../server/services';
import type { Answer } from '../server/views';

/** 经 JSON 传输后的形状：Date 变成 ISO 字符串，其余结构不变 */
export type Jsonify<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;

// 接口返回类型直接取自服务端实现，前后端只维护一份
type Learning = Services['learning'];
type Knowledge = Services['knowledge'];
type PlacementService = Services['placement'];
type Preferences = Services['preferences'];
type Asking = Services['asking'];
type TopicPlanning = Services['topicPlanning'];

export type Topic = Jsonify<ReturnType<Learning['listTopics']>[number]>;
type BaseTopicDraft = Jsonify<ReturnType<TopicPlanning['get']>>;
/** 新建草稿时可选指定专业课程；确认后主题归入这门课。后端尚未加这个字段时视为未归类 */
export type TopicDraft = Omit<BaseTopicDraft, 'courseId'> & { courseId?: string | null };
export type TopicDraftSummary = Jsonify<ReturnType<TopicPlanning['list']>[number]>;
/** 服务端返回的开放课堂范围；旧课堂没有这个字段 */
export type OpenScope = LearningScope & { label?: string };
/**
 * 预览的形状按前后端约定写在这里：范围相关字段可选，兼容尚未升级的服务端；
 * 其余字段与 Learning['previewNext'] 的返回一致。
 */
export interface PreviewItem {
  title: string;
  topicTitle: string;
  purpose: ItemPurpose;
  formLabel: string;
}
export interface OpenPreviewItem extends PreviewItem {
  excluded: boolean;
  done: boolean;
}
export interface Preview {
  open: {
    id: string;
    startedAt: string;
    items: OpenPreviewItem[];
    /** 这一节开始时的范围快照 */
    scope?: OpenScope;
  } | null;
  capped: boolean;
  sessionsToday: number;
  dailySessionCap: number | null;
  preparing: boolean;
  newPaused: boolean;
  dueCount: number;
  /** 当前查询范围 */
  scope?: OpenScope;
  /** 范围外到期的复习数量，只提示，不混入这一节 */
  outsideDueCount?: number;
  counts: { review: number; contrast: number; spotCheck: number; advance: number; new: number };
  estMinutes: number;
  budgetMinutes: number;
  items: PreviewItem[];
}
export type NextSession = Jsonify<Awaited<ReturnType<Learning['nextSession']>>>;
export type Session = NonNullable<NextSession['session']>;
export type SessionItem = Session['items'][number];
export type ItemPurpose = SessionItem['purpose'];
export type AttemptResult = Jsonify<Awaited<ReturnType<Learning['submitAttempt']>>>;
export type AppealResult = Jsonify<Awaited<ReturnType<Learning['appealAttempt']>>>;
export type FinishResult = Jsonify<ReturnType<Learning['finishSession']>>;
export type CognitiveMap = Jsonify<ReturnType<Knowledge['cognitiveMap']>>;
export type MapTopic = CognitiveMap['topics'][number];
export type MapPoint = CognitiveMap['points'][number];
export type MapConnection = CognitiveMap['connections'][number];
export type PointDetail = Jsonify<ReturnType<Knowledge['pointDetail']>>;
export type LearningRecord = PointDetail['records'][number];
export type ReviewDay = Jsonify<ReturnType<Knowledge['reviewDays']>[number]>;
export type DayReview = Jsonify<ReturnType<Knowledge['dayReview']>>;
export type CheatsheetSummary = Jsonify<ReturnType<Knowledge['listCheatsheets']>[number]>;
export type Cheatsheet = Jsonify<ReturnType<Knowledge['getCheatsheet']>>;
export type PlacementState = Jsonify<ReturnType<PlacementService['status']>>;
export type SettingsView = Jsonify<ReturnType<Preferences['getSettings']>> & {
  /** 后端稳定前可缺省；界面使用同源的本地预设目录兜底 */
  teachingPresets?: TeachingPreset[];
};
export type UserSettings = SettingsView['settings'];
export type Today = Jsonify<ReturnType<Preferences['today']>>;
export type AiSettingsView = Jsonify<ReturnType<Preferences['getAiSettings']>>;
export type AiTestResult = Awaited<ReturnType<Preferences['testAi']>>;
export type { AiSettingsPatch };
export type AskThread = Jsonify<ReturnType<Asking['listThreads']>[number]>;
export type Ask = AskThread['asks'][number];
export type AskSuggestions = Jsonify<Awaited<ReturnType<Asking['suggest']>>>;
export type KnowledgeSuggestion = AskSuggestions['suggestions'][number];
export type { Answer, Stage };

// ---------- 学科组织（学科大类 → 专业课程 → 学习主题） ----------
// 后端服务稳定前，这里先定义前后端共用的结构；字段与约定的一致，后续可直接换成服务端类型。

/** 课程只继承所属大类的教学预设，不再有课程级风格覆盖 */
export type PresetId = string;

export interface Discipline {
  id: string;
  name: string;
  presetId: PresetId;
  createdAt?: string;
  counts?: { courses?: number; topics?: number };
}

export interface Course {
  id: string;
  name: string;
  disciplineId: string;
  /** 右侧详情与首页共用同一份计数；后端未提供时按主题列表推导 */
  counts?: CourseCounts;
  disciplineName?: string | null;
  createdAt?: string;
}

export interface CourseCounts {
  topics: number;
  /** 知识点总数；后端给的是 points，界面只展示主题与学习进度 */
  points?: number;
  courses?: number;
  learned?: number;
  due?: number;
  edge?: number;
  excluded?: number;
}

/** 组织视图里的学习主题：只带归类与状态，不重复知识图谱详情 */
export interface OrganizationTopic {
  id: string;
  title: string;
  courseId: string | null;
  courseName?: string | null;
  disciplineId?: string | null;
  disciplineName?: string | null;
  graphStatus?: Topic['graphStatus'];
  placementStatus?: Topic['placementStatus'];
  status?: Topic['status'];
  priority?: number;
  createdAt?: string;
  counts?: CourseCounts;
}

export interface MigrationReport {
  [key: string]: unknown;
}

export interface Organization {
  disciplines: Discipline[];
  courses: Course[];
  topics: OrganizationTopic[];
  /** 未归类主题；旧接口可能作为单独字段给出 */
  unclassifiedTopics?: OrganizationTopic[];
  migrationReport: MigrationReport | null;
}

export interface TeachingPreset {
  id: PresetId;
  label: string;
  description: string;
  tutorial: string;
  figure: string;
  version?: number;
}

/**
 * 一门课程实际生效的教学配置：服务端在与生成端共用的解析函数里算好，
 * 前端原样展示，不再拼接或推导。未归类主题的 courseId / disciplineId 为 null。
 */
export interface CourseGuidance {
  courseId: string | null;
  courseName: string;
  disciplineId: string | null;
  disciplineName: string | null;
  presetId: PresetId;
  presetLabel: string;
  tutorialGuidance: string;
  figureGuidance: string;
  fingerprint: string;
}

/**
 * 保存前的影响评估（后端最终契约）：
 * 三个计数是数字，modelCalls 表示是否可能调用模型；
 * courseDetails / topicDetails 与 estimatedModelCalls 是可选的补充明细，界面不依赖它们。
 */
export interface OrganizationImpact {
  kind?: string;
  affectedCourses: number;
  affectedTopics: number;
  affectedItems: number;
  /** 是否可能调用模型；具体次数不承诺，界面只说"可能调用模型" */
  modelCalls: boolean;
  /** 可选明细：具体受影响的课程 */
  courseDetails?: { id: string; name?: string; disciplineId?: string | null }[];
  /** 可选明细：具体受影响的学习主题 */
  topicDetails?: { id: string; title?: string; courseId?: string | null }[];
  /** 可选估算：预期的模型调用次数，仅作参考，不作为承诺 */
  estimatedModelCalls?: number;
}

/**
 * 合并多次影响评估的结果。
 *
 * 主题集合互不重叠，主题数与待重备内容数可以直接相加。
 * 课程数不能用 max：新增和移出可能涉及完全不同的课程，max 会少报。
 * - 后端给了 courseDetails 时按 id 求并集，得到准确数量；
 * - 只有数字时无法去重，取相加作为保守估算（宁可多提示，不隐瞒影响）。
 */
export function combineImpacts(impacts: OrganizationImpact[]): OrganizationImpact {
  const courseIds = new Set<string>();
  let coursesWithoutDetails = 0;
  let affectedTopics = 0;
  let affectedItems = 0;
  let modelCalls = false;
  let kind: string | undefined;

  for (const item of impacts) {
    if (item.courseDetails?.length) {
      for (const course of item.courseDetails) courseIds.add(course.id);
    } else {
      // 没有明细的请求只能整体计入，无法与其它请求去重
      coursesWithoutDetails += item.affectedCourses;
    }
    affectedTopics += item.affectedTopics;
    affectedItems += item.affectedItems;
    modelCalls = modelCalls || item.modelCalls;
    kind = item.kind ?? kind;
  }

  return {
    kind,
    affectedCourses: courseIds.size + coursesWithoutDetails,
    affectedTopics,
    affectedItems,
    modelCalls,
  };
}

export type LearningScope = { kind: 'all' | 'discipline' | 'course'; id?: string };

export type ImpactRequest =
  | { kind: 'discipline'; id?: string; presetId?: PresetId }
  | { kind: 'course'; id?: string; disciplineId?: string }
  | { kind: 'topics'; topicIds: string[]; courseId?: string | null };

/** 接口错误带上状态与结构化信息，界面据此区分"需要确认"和普通失败 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

const DEV_NOW_KEY = 'weiketang.devNow';

/** 开发模式下的"模拟当前时间"，只存在本机浏览器里 */
export const devNow = {
  get(): string {
    try {
      return localStorage.getItem(DEV_NOW_KEY) ?? '';
    } catch {
      return '';
    }
  },
  set(value: string): void {
    try {
      if (value) localStorage.setItem(DEV_NOW_KEY, value);
      else localStorage.removeItem(DEV_NOW_KEY);
    } catch {
      // 浏览器禁用存储时忽略，只是不记住模拟时间
    }
  },
};

/** 浏览器所在时区："今天""哪一天"都按它划分 */
export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 当前设备：窄屏或触屏视为手机，只出适合手机的形式 */
export function currentDevice(): 'desktop' | 'mobile' {
  try {
    return window.matchMedia('(max-width: 640px), (pointer: coarse)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const simulated = devNow.get();
  if (simulated) headers['X-Dev-Now'] = new Date(simulated).toISOString();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = data as { error?: string; code?: string } & Record<string, unknown>;
    throw new ApiError(payload.error ?? `请求失败（${res.status}）`, res.status, payload.code, payload);
  }
  return data as T;
}

const query = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

/** 学习范围转成查询参数；all 不带 id */
const scopeQuery = (scope: LearningScope) => ({ scopeKind: scope.kind, scopeId: scope.kind === 'all' ? undefined : scope.id });

export const api = {
  health: () => request<{ ok: boolean; devMode: boolean }>('GET', '/api/health'),

  listTopics: () => request<{ topics: Topic[] }>('GET', '/api/topics'),
  topicDrafts: () => request<{ drafts: TopicDraftSummary[] }>('GET', '/api/topic-drafts'),
  createTopicDraft: (idea: string, courseId?: string | null) =>
    request<TopicDraft>('POST', '/api/topic-drafts', { idea, courseId: courseId ?? undefined }),
  topicDraft: (id: string) => request<TopicDraft>('GET', `/api/topic-drafts/${id}`),
  addTopicMessage: (id: string, message: string, revision: number) =>
    request<TopicDraft>('POST', `/api/topic-drafts/${id}/messages`, { message, revision }),
  replyTopicDraft: (id: string, revision: number) => request<TopicDraft>('POST', `/api/topic-drafts/${id}/reply`, { revision }),
  confirmTopicDraft: (id: string, revision: number) => request<{ topicId: string }>('POST', `/api/topic-drafts/${id}/confirm`, { revision }),
  /** 修改主题：暂停/恢复、优先级；课程归属走 organization 的 assignTopics */
  updateTopic: (topicId: string, patch: { status?: 'active' | 'paused'; priority?: number; confirmed?: true }) =>
    request<Topic>('PATCH', `/api/topics/${topicId}`, patch),

  // ---------- 学科组织 ----------
  organization: () => request<Organization>('GET', '/api/organization'),
  createDiscipline: (input: { name: string; presetId: PresetId }) =>
    request<Discipline>('POST', '/api/disciplines', input),
  updateDiscipline: (id: string, patch: { name?: string; presetId?: PresetId; confirmed?: true }) =>
    request<Discipline>('PATCH', `/api/disciplines/${id}`, patch),
  deleteDiscipline: (id: string) => request<{ ok: boolean }>('DELETE', `/api/disciplines/${id}`),
  createCourse: (input: { name: string; disciplineId: string }) => request<Course>('POST', '/api/courses', input),
  updateCourse: (id: string, patch: { name?: string; disciplineId?: string; confirmed?: true }) =>
    request<Course>('PATCH', `/api/courses/${id}`, patch),
  deleteCourse: (id: string) => request<{ ok: boolean }>('DELETE', `/api/courses/${id}`),
  assignCourseTopics: (courseId: string, topicIds: string[], options: { confirmed?: true } = {}) =>
    request<{ ok?: boolean; assigned?: number; skipped?: number; topics?: string[] }>('PUT', `/api/courses/${courseId}/topics`, { topicIds, ...options }),
  /**
   * 单个主题改归属。courseId 为 null 表示取消归类（回到默认教学配置）；
   * 会改变教学配置时由界面确认后传 confirmed:true。
   */
  assignTopic: (topicId: string, courseId: string | null, options: { confirmed?: true } = {}) =>
    request<Topic>('PATCH', `/api/topics/${topicId}`, { courseId, ...options }),
  courseGuidance: (courseId: string) =>
    request<CourseGuidance>('GET', `/api/courses/${encodeURIComponent(courseId)}/guidance`),
  /** 未归类/默认教学配置：服务端用同一个解析函数给出，不需要前端拼接 */
  unclassifiedGuidance: () => request<CourseGuidance>('GET', '/api/courses/unclassified/guidance'),
  organizationImpact: (input: ImpactRequest) => request<OrganizationImpact>('POST', '/api/organization/impact', input),

  placement: (topicId: string) => request<PlacementState>('GET', `/api/topics/${topicId}/placement`),
  beginPlacement: (topicId: string, background: string) =>
    request<PlacementState>('POST', `/api/topics/${topicId}/placement`, { background }),
  answerPlacement: (topicId: string, pointId: string, choice: number) =>
    request<PlacementState>('POST', `/api/topics/${topicId}/placement/answer`, { pointId, choice }),
  skipPlacement: (topicId: string) => request<PlacementState>('POST', `/api/topics/${topicId}/placement/skip`),

  /** preview 按范围预览：范围只影响这一节，范围外到期只提示数量 */
  preview: (options: { scope?: LearningScope } = {}) => {
    const scope = options.scope ?? { kind: 'all' };
    return request<Preview>('GET', `/api/sessions/preview?${query({ device: currentDevice(), timeZone, ...scopeQuery(scope) })}`);
  },
  /**
   * 开始下一节。scope 只作用于新课堂；有未完成的一堂课时：
   * resume 明确继续它，fresh 明确结束它再构建新的，两者都不传时服务端返回冲突由界面提示。
   */
  nextSession: (options: { guidance?: string; fresh?: boolean; resume?: boolean; scope?: LearningScope } = {}) =>
    request<NextSession>('POST', '/api/sessions/next', {
      ...options,
      scope: options.scope ?? { kind: 'all' },
      device: currentDevice(),
      timeZone,
    }),
  submitAttempt: (body: { sessionId: string; itemId: string; answer: Answer; durationMs: number }) =>
    request<AttemptResult>('POST', '/api/attempts', body),
  rate: (attemptId: string, selfRating: 'hard' | 'good' | 'easy') =>
    request<{ ok: boolean }>('POST', `/api/attempts/${attemptId}/rating`, { selfRating }),
  appeal: (attemptId: string, reason: string) => request<AppealResult>('POST', `/api/attempts/${attemptId}/appeal`, { reason }),
  finish: (sessionId: string) => request<FinishResult>('POST', `/api/sessions/${sessionId}/finish`),
  answerRevisit: (resumeTopicIds: string[]) => request<{ ok: boolean }>('POST', '/api/revisit', { resumeTopicIds }),

  askThreads: (scope: { sessionId?: string; pointId?: string }) =>
    request<{ threads: AskThread[] }>('GET', `/api/ask-threads?${query(scope)}`),
  createAskThread: (scope: { sessionId?: string; pointId?: string }) => request<AskThread>('POST', '/api/ask-threads', scope),
  ask: (input: { threadId: string; question: string; itemId?: string; pointId?: string; quote?: string }) => request<Ask>('POST', '/api/asks', input),
  suggestKnowledge: (threadId: string, hint?: string) => request<AskSuggestions>('POST', `/api/ask-threads/${threadId}/suggest`, { hint }),
  acceptKnowledge: (anchorPointId: string, points: KnowledgeSuggestion[]) =>
    request<{ added: number; skipped: number; topicId: string }>('POST', '/api/asks/accept', { anchorPointId, points }),

  map: () => request<CognitiveMap>('GET', '/api/map'),
  point: (pointId: string) => request<PointDetail>('GET', `/api/points/${pointId}`),
  setLearningExcluded: (pointId: string, excluded: boolean) =>
    request<{ id: string; excluded: boolean }>('PATCH', `/api/points/${pointId}/learning`, { excluded }),
  reviewDays: (topicId?: string) => request<{ days: ReviewDay[] }>('GET', `/api/review-days?${query({ timeZone, topicId })}`),
  dayReview: (day: string, topicId?: string) =>
    request<DayReview>('GET', `/api/review-days/${day}?${query({ timeZone, topicId })}`),
  relearn: (knowledgePointIds: string[]) => request<{ relearned: string[] }>('POST', '/api/relearn', { knowledgePointIds }),
  addExistingKnowledge: (text: string) => request<{ id: string; text: string }>('POST', '/api/existing-knowledge', { text }),
  removeExistingKnowledge: (id: string) => request<{ ok: boolean }>('DELETE', `/api/existing-knowledge/${id}`),

  illustration: (id: string) => request<{ status: 'pending' | 'ready' | 'failed' }>('GET', `/api/illustrations/${encodeURIComponent(id)}`),
  retryIllustration: (id: string) => request<Jsonify<ReturnType<Services['illustrations']['retry']>>>(
    'POST', `/api/illustrations/${encodeURIComponent(id)}/retry`,
  ),
  illustrationImageUrl: (id: string) => `/api/illustrations/${encodeURIComponent(id)}/image`,

  cheatsheets: () => request<{ cheatsheets: CheatsheetSummary[] }>('GET', '/api/cheatsheets'),
  cheatsheet: (id: string) => request<Cheatsheet>('GET', `/api/cheatsheets/${id}`),
  createCheatsheet: (topicIds: string[], stages: Stage[]) =>
    request<{ id: string; title: string; pointCount: number }>('POST', '/api/cheatsheets', { topicIds, stages }),
  exportMarkdown: (topicIds: string[], records: boolean, cheatsheetId?: string) =>
    request<{ filename: string; markdown: string }>('POST', '/api/export', { topicIds, records, cheatsheetId }),

  settings: () => request<SettingsView>('GET', '/api/settings'),
  saveSettings: (patch: Partial<UserSettings>) => request<UserSettings>('PUT', '/api/settings', patch),
  aiSettings: () => request<AiSettingsView>('GET', '/api/settings/ai'),
  saveAiSettings: (patch: AiSettingsPatch) => request<AiSettingsView>('PUT', '/api/settings/ai', patch),
  testAi: (target: 'text' | 'image', patch: AiSettingsPatch) => request<AiTestResult>('POST', '/api/settings/ai/test', { target, patch }),
  today: () => request<Today>('GET', `/api/today?${query({ timeZone })}`),
};

/** 把文字内容存成本地文件（导出、速查表下载） */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
