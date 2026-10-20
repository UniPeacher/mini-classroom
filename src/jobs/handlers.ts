import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { AiOutputError, type StructuredModel } from '../ai/gateway';
import { type PointContext, decomposePoint, generateCheatsheet, generateGraph, preparePlacement } from '../ai/generators';
import { UNLEARNED } from '../domain/memory';
import { chooseProbePoints } from '../domain/placement';
import { type PoolNeed, planPool } from '../domain/plan-pool';
import type { Settings } from '../settings';
import type { LessonContent } from '../shared/content';
import type { Db } from '../store/db';
import {
  addDecomposedPoints,
  getTopic,
  insertItem,
  loadExistingKnowledge,
  loadPoints,
  loadPool,
  loadStates,
  markDecomposed,
  markGraphFailed,
  saveGraph,
  wasDecomposed,
} from '../store/repo';
import { attempts, cheatsheets, connections, existingKnowledge, items, placements, topics } from '../store/schema';
import { settleWithLimit } from './concurrency';
import { contextOf, generateItem } from './generate-item';
import { enqueue } from './queue';
import type { JobHandlers } from './worker';

export interface HandlerDeps {
  db: Db;
  model: StructuredModel;
  clock: () => Date;
  /** 每次读取最新设置 */
  settings: () => Settings;
}

export interface GenerateGraphPayload {
  topicId: string;
}

export interface FillPoolPayload {
  /** 规划时使用的"当前时间"；开发模式下可由请求覆盖 */
  now?: string;
}

export interface TopicPayload {
  topicId: string;
}

export interface DecomposePayload {
  knowledgePointId: string;
}

export interface CheatsheetPayload {
  cheatsheetId: string;
}

/** 速查表的范围：哪些主题、哪些掌握阶段 */
export interface CheatsheetScope {
  topicIds: string[];
  stages: string[];
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
        const settings = deps.settings();
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
          needs.map((need) => () => {
            const ctx = contextOf(byId.get(need.knowledgePointId)!, byId, {
              state: states.get(need.knowledgePointId) ?? UNLEARNED,
              existingKnowledge: known,
            });
            return fulfill(need, ctx);
          }),
          settings.generationConcurrency,
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

    prepare_placement: {
      async run(payload) {
        const { topicId } = payload as TopicPayload;
        const topic = getTopic(db, topicId);
        const placement = db.select().from(placements).where(eq(placements.topicId, topicId)).get();
        if (!topic || !placement || topic.placementStatus !== 'preparing') return;
        const points = loadPoints(db).filter((p) => p.topicId === topicId);
        const probeIds = chooseProbePoints(points);
        try {
          const plan = await preparePlacement(model, {
            topicTitle: topic.title,
            background: placement.background,
            points: points.map((p) => ({ id: p.id, title: p.title, summary: p.summary })),
            probeIds,
          });
          const now = clock();
          db.transaction((tx) => {
            for (const text of plan.existingKnowledge) {
              tx.insert(existingKnowledge).values({ id: randomUUID(), topicId, text, createdAt: now }).run();
            }
            tx.update(placements)
              .set({ startIds: plan.likelyKnownIds, probes: plan.probes })
              .where(eq(placements.topicId, topicId))
              .run();
            tx.update(topics).set({ placementStatus: 'testing' }).where(eq(topics.id, topicId)).run();
          });
        } catch (error) {
          if (error instanceof AiOutputError) {
            failPlacement(topicId);
            return;
          }
          throw error;
        }
      },
      onGiveUp(payload) {
        failPlacement((payload as TopicPayload).topicId);
      },
    },

    decompose: {
      async run(payload) {
        const { knowledgePointId } = payload as DecomposePayload;
        if (wasDecomposed(db, knowledgePointId)) return;
        const points = loadPoints(db);
        const point = points.find((p) => p.id === knowledgePointId);
        if (!point) return;
        const byId = new Map(points.map((p) => [p.id, p]));
        const state = loadStates(db).get(knowledgePointId) ?? UNLEARNED;
        try {
          const result = await decomposePoint(model, {
            ...contextOf(point, byId, { state }),
            existingTitles: points.filter((p) => p.topicId === point.topicId).map((p) => p.title),
          });
          addDecomposedPoints(db, point, result.knowledgePoints, clock());
        } catch (error) {
          // 结构始终不合法：放弃拆解，知识点照常按原方式教
          if (!(error instanceof AiOutputError)) throw error;
          console.warn(`拆解失败（${point.title}）：${error.message}`);
        }
        markDecomposed(db, knowledgePointId, clock());
        enqueue(db, 'fill_pool', {} satisfies FillPoolPayload, clock(), { dedupe: true });
      },
    },

    generate_cheatsheet: {
      async run(payload) {
        const { cheatsheetId } = payload as CheatsheetPayload;
        const sheet = db.select().from(cheatsheets).where(eq(cheatsheets.id, cheatsheetId)).get();
        if (!sheet || sheet.status !== 'pending') return;
        try {
          const markdown = await generateCheatsheet(model, { scopeTitle: sheet.title, ...cheatsheetInput(sheet.scope as CheatsheetScope) });
          db.update(cheatsheets).set({ status: 'ready', markdown }).where(eq(cheatsheets.id, cheatsheetId)).run();
        } catch (error) {
          if (!(error instanceof AiOutputError)) throw error;
          db.update(cheatsheets).set({ status: 'failed' }).where(eq(cheatsheets.id, cheatsheetId)).run();
        }
      },
      onGiveUp(payload) {
        db.update(cheatsheets).set({ status: 'failed' }).where(eq(cheatsheets.id, (payload as CheatsheetPayload).cheatsheetId)).run();
      },
    },
  };

  async function fulfill(need: PoolNeed, ctx: PointContext): Promise<void> {
    insertItem(db, await generateItem(model, ctx, need), clock());
  }

  /** 摸底准备失败：退回"待开始"，用户可以重试或跳过 */
  function failPlacement(topicId: string) {
    db.update(topics).set({ placementStatus: 'pending' }).where(eq(topics.id, topicId)).run();
  }

  /** 速查表的素材：范围内的知识点、它们最近一次的讲解、易混对、联结原话 */
  function cheatsheetInput(scope: CheatsheetScope) {
    const all = loadPoints(db);
    const states = loadStates(db);
    const byId = new Map(all.map((p) => [p.id, p]));
    const points = all.filter((p) => scope.topicIds.includes(p.topicId) && scope.stages.includes((states.get(p.id) ?? UNLEARNED).stage));
    const ids = new Set(points.map((p) => p.id));
    const lessons = ids.size
      ? db
          .select({ knowledgePointId: items.knowledgePointId, content: items.content })
          .from(attempts)
          .innerJoin(items, eq(attempts.itemId, items.id))
          .where(inArray(items.knowledgePointId, [...ids]))
          .orderBy(desc(attempts.createdAt))
          .all()
          .filter((r) => (r.content as Partial<LessonContent>).explanation !== undefined)
      : [];
    const explanationOf = (id: string) => (lessons.find((l) => l.knowledgePointId === id)?.content as LessonContent | undefined)?.explanation ?? null;
    const pairs = new Map<string, [string, string]>();
    for (const p of points) {
      for (const other of p.confusableIds.filter((id) => ids.has(id))) {
        pairs.set([p.id, other].sort().join('|'), [p.title, byId.get(other)!.title]);
      }
    }
    const known = new Map(loadExistingKnowledge(db).map((k) => [k.id, k.text]));
    const links = db
      .select()
      .from(connections)
      .all()
      .filter((c) => ids.has(c.fromPointId))
      .map((c) => ({
        from: byId.get(c.fromPointId)?.title ?? '',
        to: c.toPointId ? (byId.get(c.toPointId)?.title ?? '') : (known.get(c.toExistingId ?? '') ?? ''),
        quote: c.quote,
      }));
    return {
      points: points.map((p) => ({ title: p.title, summary: p.summary, topicTitle: p.topicTitle, explanation: explanationOf(p.id) })),
      confusablePairs: [...pairs.values()],
      connections: links,
    };
  }
}
