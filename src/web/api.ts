import type { Stage } from '../domain/memory';
import type { Answer, Learning } from '../server/learning';

/** 经 JSON 传输后的形状：Date 变成 ISO 字符串，其余结构不变 */
export type Jsonify<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;

// 接口返回类型直接取自服务端实现，前后端只维护一份
export type Topic = Jsonify<ReturnType<Learning['listTopics']>[number]>;
export type TopicMap = Jsonify<ReturnType<Learning['topicMap']>>;
export type MapPoint = TopicMap['points'][number];
export type MapRecord = MapPoint['records'][number];
export type ReviewDay = Jsonify<ReturnType<Learning['reviewDays']>[number]>;
export type DayReview = Jsonify<ReturnType<Learning['dayReview']>>;
export type NextSession = Jsonify<Awaited<ReturnType<Learning['nextSession']>>>;
export type Session = NonNullable<NextSession['session']>;
export type SessionItem = Session['items'][number];
export type AttemptResult = Jsonify<Awaited<ReturnType<Learning['submitAttempt']>>>;
export type { Answer, Stage };

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

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const simulated = devNow.get();
  if (simulated) headers['X-Dev-Now'] = new Date(simulated).toISOString();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

/** 按天回看的查询参数："哪一天"按浏览器所在时区划分 */
function reviewQuery(topicId?: string): string {
  const params = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (topicId) params.set('topicId', topicId);
  return params.toString();
}

export const api = {
  health: () => request<{ ok: boolean; devMode: boolean }>('GET', '/api/health'),
  listTopics: () => request<{ topics: Topic[] }>('GET', '/api/topics'),
  createTopic: (title: string) => request<{ topicId: string }>('POST', '/api/topics', { title }),
  topicMap: (topicId: string) => request<TopicMap>('GET', `/api/topics/${topicId}/map`),
  reviewDays: (topicId?: string) => request<{ days: ReviewDay[] }>('GET', `/api/review-days?${reviewQuery(topicId)}`),
  dayReview: (day: string, topicId?: string) => request<DayReview>('GET', `/api/review-days/${day}?${reviewQuery(topicId)}`),
  relearn: (knowledgePointIds: string[]) => request<{ relearned: string[] }>('POST', '/api/relearn', { knowledgePointIds }),
  nextSession: (guidance?: string) => request<NextSession>('POST', '/api/sessions/next', { guidance }),
  submitAttempt: (body: { sessionId: string; itemId: string; answer: Answer; durationMs: number }) =>
    request<AttemptResult>('POST', '/api/attempts', body),
  rate: (attemptId: string, selfRating: 'hard' | 'good' | 'easy') =>
    request<{ ok: boolean }>('POST', `/api/attempts/${attemptId}/rating`, { selfRating }),
  finish: (sessionId: string) => request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/finish`),
};
