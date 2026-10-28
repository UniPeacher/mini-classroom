import { eq } from 'drizzle-orm';
import { AiOutputError, type StructuredModel } from '../ai/gateway';
import { UNLEARNED } from '../domain/memory';
import { planPool } from '../domain/plan-pool';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import { loadExistingKnowledge, loadPoints, loadPool, loadStates } from '../store/repo';
import { memoryStates } from '../store/schema';
import { resolvePointTeaching, teachingChanged, type TeachingConfig } from '../teaching';
import { settleWithLimit } from './concurrency';
import { contextOf, generateItem, saveGeneratedItem } from './generate-item';

/** 提前为 48 小时内到期的复习备好内容 */
export const POOL_HORIZON_MS = 48 * 3600 * 1000;
/** 候选池常备约两节的量 */
const SESSIONS_AHEAD = 2;

export interface FillPoolDeps {
  db: Db;
  model: StructuredModel;
  settings: () => Settings;
  clock: () => Date;
  /** 配置了图像模型时，讲解可以配插画 */
  illustrations: boolean;
}

/**
 * 按规划把候选池补满：后台任务和"构建新一节"共用。
 * 单项内容结构始终不合法时丢弃这一项；其他错误（如网络）返回给调用方决定是否重试，
 * 已生成的内容已入池，重试时只补缺少的部分。
 *
 * 教学配置的一致性：本轮按开始时读到的共用规则生成；每项在生成前后都重新解析
 * 所属课程此刻的教学配置，只要与本次基线不同，就中止本轮，不再保存之后的结果。
 * 配置改动本身已经作废了受影响主题的旧候选内容，下一轮补池会按最新配置统一准备，
 * 避免同一批内容混着两套引导词。
 */
export async function fillPool({ db, model, settings, clock, illustrations }: FillPoolDeps, now: Date): Promise<{ generated: number; retryable: unknown }> {
  // 本轮基线：共用规则与组织关系在开始时就固定
  const generationSettings = settings();
  const points = loadPoints(db);
  const states = loadStates(db);
  const needs = planPool({
    points,
    states,
    pool: loadPool(db),
    now,
    horizonMs: POOL_HORIZON_MS,
    newCount: SESSIONS_AHEAD * generationSettings.maxNewPerSession,
    prefs: generationSettings.formPrefs,
  });
  const byId = new Map(points.map((p) => [p.id, p]));
  const known = loadExistingKnowledge(db).map((k) => k.text);
  // 生成期间教学配置变了就中止本轮：不再发起新的生成，也不保存已完成的结果
  let aborted = false;

  const results = await settleWithLimit(
    needs.map((need) => async () => {
      if (aborted) return;
      const excluded = () => db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, need.knowledgePointId)).get()?.excluded;
      // 按基线引导词生成；生成前确认此刻的配置仍然一致
      const teaching = resolvePointTeaching(db, need.knowledgePointId, generationSettings);
      if (excluded() || changed(need.knowledgePointId, teaching)) {
        aborted = true;
        return;
      }
      const ctx = contextOf(byId.get(need.knowledgePointId)!, byId, { state: states.get(need.knowledgePointId) ?? UNLEARNED, existingKnowledge: known });
      const generated = await generateItem(model, ctx, need, {
        illustrations,
        contentGuidance: teaching.guidance,
        guidanceFingerprint: teaching.fingerprint,
      });
      // 生成期间可能改了归类、改了引导词，或把知识点设为不学：过期结果不入池
      if (excluded() || changed(need.knowledgePointId, teaching)) {
        aborted = true;
        return;
      }
      saveGeneratedItem(db, generated, clock());
      return true;
    }),
    generationSettings.generationConcurrency,
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
  return { generated: results.filter((r) => r.status === 'fulfilled' && r.value).length, retryable };

  /**
   * 此刻的教学配置是否已经与本次基线不同：每次都重新读设置与组织关系。
   * 指纹变了（预设或共用规则变了）或知识点已被删除都会返回 true；
   * 旧内容没有指纹（升级前生成）时不因升级被判过期。
   */
  function changed(pointId: string, baseline: TeachingConfig): boolean {
    return teachingChanged(db, pointId, settings(), baseline.fingerprint);
  }
}
