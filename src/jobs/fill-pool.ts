import { AiOutputError, type StructuredModel } from '../ai/gateway';
import { UNLEARNED } from '../domain/memory';
import { planPool } from '../domain/plan-pool';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import { insertItem, loadExistingKnowledge, loadPoints, loadPool, loadStates } from '../store/repo';
import { settleWithLimit } from './concurrency';
import { contextOf, generateItem } from './generate-item';

/** 提前为 48 小时内到期的复习备好内容 */
export const POOL_HORIZON_MS = 48 * 3600 * 1000;
/** 候选池常备约两节的量 */
const SESSIONS_AHEAD = 2;

export interface FillPoolDeps {
  db: Db;
  model: StructuredModel;
  settings: Settings;
  clock: () => Date;
}

/**
 * 按规划把候选池补满：后台任务和"构建新一节"共用。
 * 单项内容结构始终不合法时丢弃这一项；其他错误（如网络）返回给调用方决定是否重试，
 * 已生成的内容已入池，重试时只补缺少的部分。
 */
export async function fillPool({ db, model, settings, clock }: FillPoolDeps, now: Date): Promise<{ generated: number; retryable: unknown }> {
  const points = loadPoints(db);
  const states = loadStates(db);
  const needs = planPool({
    points,
    states,
    pool: loadPool(db),
    now,
    horizonMs: POOL_HORIZON_MS,
    newCount: SESSIONS_AHEAD * settings.maxNewPerSession,
    prefs: settings.formPrefs,
  });
  const byId = new Map(points.map((p) => [p.id, p]));
  const known = loadExistingKnowledge(db).map((k) => k.text);
  const results = await settleWithLimit(
    needs.map((need) => async () => {
      const ctx = contextOf(byId.get(need.knowledgePointId)!, byId, { state: states.get(need.knowledgePointId) ?? UNLEARNED, existingKnowledge: known });
      insertItem(db, await generateItem(model, ctx, need), clock());
    }),
    settings.generationConcurrency,
  );
  let retryable: unknown;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') return;
    if (result.reason instanceof AiOutputError) {
      console.warn(`丢弃一项候选内容（${needs[i]!.kind} / ${needs[i]!.knowledgePointId}）：${result.reason.message}`);
    } else {
      retryable ??= result.reason;
    }
  });
  return { generated: results.filter((r) => r.status === 'fulfilled').length, retryable };
}
