import { eq } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import type { ExplainForm, QuestionForm } from '../domain/forms';
import { UNLEARNED, type MemoryState } from '../domain/memory';
import type { PoolNeed } from '../domain/plan-pool';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import { loadExistingKnowledge, loadPoints, loadStates } from '../store/repo';
import { items } from '../store/schema';
import { resolvePointTeaching, teachingChanged, type TeachingConfig } from '../teaching';
import { settleWithLimit } from './concurrency';
import { contextOf, generateItem, saveGeneratedItem } from './generate-item';

/** 可以按补充说明重新生成的一项内容（讲解 + 当场小题，或复习题） */
export interface TeachableItem {
  id: string;
  knowledgePointId: string;
  kind: 'lesson' | 'review';
  form: string;
  questionForm: string;
  estSeconds: number;
}

export interface RegenerateDeps {
  db: Db;
  model: StructuredModel;
  /** 每次读取最新设置 */
  settings: () => Settings;
  /** 配置了图像模型时，讲解可以配插画 */
  illustrations: boolean;
  clock: () => Date;
}

/** 重新生成的结果：替换后的内容，以及生成期间配置是否已变 */
export interface RegenerateResult {
  items: TeachableItem[];
  /** 成功替换的项数 */
  applied: number;
  /**
   * 生成期间教学配置是否变化。为 true 时调用方应提示用户重试，
   * 并丢弃这次结果，不要用它建课。
   */
  stale: boolean;
}

/**
 * 按一节补充说明重新生成挑好的内容（讲解形式、题目形式保持不变）。
 *
 * 这是"开始一节时按补充说明重讲"的可复用实现，学习流程可以直接调用：
 * - 生成前逐个解析所属课程此刻的教学配置（引导词 + 指纹）；
 * - 生成后用同一入口重新解析并比较指纹，任何一项变化就返回 stale；
 * - 成功的项作废原内容、存入新内容（带本次指纹）；失败的项沿用原内容，不让这一节开不了。
 *
 * 旧内容没有指纹（升级前生成）时不会被判为过期，避免升级引起自动重新生成。
 */
export async function regenerateItems(
  { db, model, settings, illustrations, clock }: RegenerateDeps,
  picked: TeachableItem[],
  guidance: string,
  now: Date,
): Promise<RegenerateResult> {
  const generationSettings = settings();
  const points = loadPoints(db);
  const states = loadStates(db);
  const byId = new Map(points.map((p) => [p.id, p]));
  const known = loadExistingKnowledge(db).map((k) => k.text);

  // 生成前快照：每项按它所属课程取引导词与指纹
  const snapshots = new Map<string, TeachingConfig>();
  for (const item of picked) {
    if (!snapshots.has(item.knowledgePointId)) {
      snapshots.set(item.knowledgePointId, resolvePointTeaching(db, item.knowledgePointId, generationSettings));
    }
  }

  const results = await settleWithLimit(
    picked.map((item) => async () => {
      const point = byId.get(item.knowledgePointId);
      if (!point) throw new Error(`知识点不存在：${item.knowledgePointId}`);
      const teaching = snapshots.get(item.knowledgePointId)!;
      const state: MemoryState = states.get(item.knowledgePointId) ?? UNLEARNED;
      return generateItem(model, contextOf(point, byId, { guidance, state, existingKnowledge: known }), needOf(item), {
        illustrations,
        contentGuidance: teaching.guidance,
        guidanceFingerprint: teaching.fingerprint,
      });
    }),
    generationSettings.generationConcurrency,
  );

  // 生成后重新读最新设置与组织关系：只要涉及的教学配置变了，就判为过期
  const latest = settings();
  const stale = [...snapshots].some(([pointId, teaching]) => teachingChanged(db, pointId, latest, teaching.fingerprint));
  if (stale) return { items: picked, applied: 0, stale: true };

  let applied = 0;
  const replaced = picked.map((item, i): TeachableItem => {
    const result = results[i]!;
    if (result.status === 'rejected') {
      console.warn(`按补充说明生成失败，沿用原内容（${item.kind} / ${item.knowledgePointId}）：${String(result.reason)}`);
      return item;
    }
    applied += 1;
    const id = db.transaction((tx) => {
      tx.update(items).set({ status: 'void' }).where(eq(items.id, item.id)).run();
      return saveGeneratedItem(tx, result.value, clock());
    });
    return { ...item, id, estSeconds: result.value.estSeconds };
  });
  return { items: replaced, applied, stale: false };
}

/** 候选池中一项内容的形式，换算成重新生成时需要的形式 */
export function needOf(item: TeachableItem): PoolNeed {
  return item.kind === 'lesson'
    ? {
        kind: 'lesson',
        knowledgePointId: item.knowledgePointId,
        explainForm: item.form as ExplainForm,
        questionForm: item.questionForm as QuestionForm,
      }
    : { kind: 'review', knowledgePointId: item.knowledgePointId, questionForm: item.form as QuestionForm };
}
