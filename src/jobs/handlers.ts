import { AiOutputError, type StructuredModel } from '../ai/gateway';
import { type PointContext, generateGraph, generateLesson, generateReview } from '../ai/generators';
import { type PoolNeed, planPool } from '../domain/plan-pool';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import {
  type PointInfo,
  getTopic,
  insertItem,
  loadPoints,
  loadPool,
  loadStates,
  markGraphFailed,
  saveGraph,
} from '../store/repo';
import { settleWithLimit } from './concurrency';
import { enqueue } from './queue';
import type { JobHandlers } from './worker';

export interface HandlerDeps {
  db: Db;
  model: StructuredModel;
  clock: () => Date;
  settings: Settings;
}

export interface GenerateGraphPayload {
  topicId: string;
}

export interface FillPoolPayload {
  /** 规划时使用的"当前时间"；开发模式下可由请求覆盖 */
  now?: string;
}

/** 提前为 48 小时内到期的复习备好内容 */
const POOL_HORIZON_MS = 48 * 3600 * 1000;
/** 候选池常备约两节的量 */
const SESSIONS_AHEAD = 2;

export function createHandlers(deps: HandlerDeps): JobHandlers {
  const { db, model, clock } = deps;

  return {
    generate_graph: {
      async run(payload) {
        const { topicId } = payload as GenerateGraphPayload;
        const topic = getTopic(db, topicId);
        if (!topic) throw new Error(`主题不存在：${topicId}`);
        if (topic.graphStatus === 'ready') return;
        try {
          const graph = await generateGraph(model, topic.title);
          saveGraph(db, topicId, graph, clock());
        } catch (error) {
          // 结构始终不合法时重试也没意义，直接判定失败；网络等错误交给队列重试
          if (error instanceof AiOutputError) {
            markGraphFailed(db, topicId);
            return;
          }
          throw error;
        }
        enqueue(db, 'fill_pool', {} satisfies FillPoolPayload, clock(), { dedupe: true });
      },
      onGiveUp(payload) {
        markGraphFailed(db, (payload as GenerateGraphPayload).topicId);
      },
    },

    fill_pool: {
      async run(payload) {
        const now = (payload as FillPoolPayload).now ? new Date((payload as FillPoolPayload).now!) : clock();
        const points = loadPoints(db);
        const needs = planPool({
          points,
          states: loadStates(db),
          pool: loadPool(db),
          now,
          horizonMs: POOL_HORIZON_MS,
          newCount: SESSIONS_AHEAD * deps.settings.maxNewPerSession,
        });
        const byId = new Map(points.map((p) => [p.id, p]));
        const results = await settleWithLimit(
          needs.map((need) => () => fulfill(need, contextOf(byId.get(need.knowledgePointId)!, byId))),
          deps.settings.generationConcurrency,
        );
        // 单项内容结构始终不合法：丢弃这一项。其他错误（如网络）让整个任务重试；
        // 已生成的内容已入池，重试时只补缺少的部分
        let retryable: unknown;
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') return;
          if (result.reason instanceof AiOutputError) {
            console.warn(`丢弃一项候选内容（${needs[i]!.kind} / ${needs[i]!.knowledgePointId}）：${result.reason.message}`);
          } else {
            retryable ??= result.reason;
          }
        });
        if (retryable !== undefined) throw retryable;
      },
    },
  };

  async function fulfill(need: PoolNeed, ctx: PointContext): Promise<void> {
    if (need.kind === 'lesson') {
      const { estSeconds, ...content } = await generateLesson(model, ctx, need);
      insertItem(
        db,
        { knowledgePointId: need.knowledgePointId, kind: 'lesson', form: need.explainForm, questionForm: need.questionForm, estSeconds, content },
        clock(),
      );
    } else {
      const { estSeconds, ...content } = await generateReview(model, ctx, need.questionForm);
      insertItem(
        db,
        { knowledgePointId: need.knowledgePointId, kind: 'review', form: need.questionForm, questionForm: need.questionForm, estSeconds, content },
        clock(),
      );
    }
  }
}

function contextOf(point: PointInfo, byId: Map<string, PointInfo>): PointContext {
  const titles = (ids: string[]) => ids.map((id) => byId.get(id)?.title).filter((t): t is string => t !== undefined);
  return {
    topicTitle: point.topicTitle,
    title: point.title,
    summary: point.summary,
    prerequisites: titles(point.prerequisiteIds),
    confusables: titles(point.confusableIds),
  };
}
