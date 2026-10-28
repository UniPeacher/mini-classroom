import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { AiOutputError, type Illustrator, type StructuredModel } from '../ai/gateway';
import { decomposePoint, generateCheatsheet, generateGraph, preparePlacement } from '../ai/generators';
import { ILLUSTRATION_SIZE } from '../ai/illustration-style';
import { teachingContextOf } from '../ai/teaching-context';
import { UNLEARNED } from '../domain/memory';
import { chooseProbePoints } from '../domain/placement';
import type { Settings } from '../settings';
import type { LessonContent } from '../shared/content';
import type { Db } from '../store/db';
import {
  addPoints,
  getTopic,
  loadExistingKnowledge,
  loadPoints,
  loadStates,
  markDecomposed,
  markGraphFailed,
  saveGraph,
  wasDecomposed,
} from '../store/repo';
import { attempts, cheatsheets, connections, existingKnowledge, illustrations, items, placements, topics } from '../store/schema';
import { resolveTopicTeaching } from '../teaching';
import { fillPool } from './fill-pool';
import { contextOf } from './generate-item';
import { enqueue } from './queue';
import type { JobHandlers } from './worker';

export interface HandlerDeps {
  db: Db;
  model: StructuredModel;
  clock: () => Date;
  /** 每次读取最新设置 */
  settings: () => Settings;
  /** 按当前配置取画插画的模型；没有配置（或不传）时讲解只用代码画的图 */
  illustrator?: () => Illustrator | undefined;
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

export interface IllustrationPayload {
  illustrationId: string;
}

export interface CheatsheetPayload {
  cheatsheetId: string;
}

/** 速查表的范围：哪些主题、哪些掌握阶段 */
export interface CheatsheetScope {
  topicIds: string[];
  stages: string[];
}

export function createHandlers(deps: HandlerDeps): JobHandlers {
  const { db, model, clock, illustrator } = deps;

  return {
    generate_graph: {
      async run(payload) {
        const { topicId } = payload as GenerateGraphPayload;
        const topic = getTopic(db, topicId);
        if (!topic) throw new Error(`主题不存在：${topicId}`);
        if (topic.graphStatus === 'ready') return;
        try {
          const teaching = resolveTopicTeaching(db, topicId, deps.settings());
          const graph = await generateGraph(model, topic.title, topic.learningBrief, teachingContextOf(teaching.presetId));
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
        const { retryable } = await fillPool({ db, model, settings: deps.settings, clock, illustrations: illustrator?.() !== undefined }, now);
        if (retryable !== undefined) throw retryable;
      },
    },

    prepare_placement: {
      async run(payload) {
        const { topicId } = payload as TopicPayload;
        const topic = getTopic(db, topicId);
        const placement = db.select().from(placements).where(eq(placements.topicId, topicId)).get();
        if (!topic || !placement || topic.placementStatus !== 'preparing') return;
        const points = loadPoints(db).filter((p) => p.topicId === topicId && !p.excluded);
        const probeIds = chooseProbePoints(points);
        try {
          const teaching = resolveTopicTeaching(db, topicId, deps.settings());
          const plan = await preparePlacement(model, {
            topicTitle: topic.title,
            background: placement.background,
            points: points.map((p) => ({ id: p.id, title: p.title, summary: p.summary })),
            probeIds,
            teaching: teachingContextOf(teaching.presetId),
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
        if (!point || point.excluded) return;
        const byId = new Map(points.map((p) => [p.id, p]));
        const state = loadStates(db).get(knowledgePointId) ?? UNLEARNED;
        try {
          const teaching = resolveTopicTeaching(db, point.topicId, deps.settings());
          const result = await decomposePoint(model, {
            ...contextOf(point, byId, { state }),
            existingTitles: points.filter((p) => p.topicId === point.topicId).map((p) => p.title),
            teaching: teachingContextOf(teaching.presetId),
          });
          if (loadPoints(db).find((p) => p.id === knowledgePointId)?.excluded) return;
          addPoints(db, point, result.knowledgePoints.map((k) => ({ ...k, prerequisite: true })), 'decomposed', clock());
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
          const scope = sheet.scope as CheatsheetScope;
          // 速查表可能跨多个主题/课程：按范围里第一个主题的教学配置给出学科要求
          const teaching = scope.topicIds[0] ? resolveTopicTeaching(db, scope.topicIds[0], deps.settings()) : null;
          const markdown = await generateCheatsheet(model, {
            scopeTitle: sheet.title,
            ...cheatsheetInput(scope),
            teaching: teachingContextOf(teaching?.presetId),
          });
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

    generate_illustration: {
      async run(payload) {
        const { illustrationId } = payload as IllustrationPayload;
        const row = db.select({ prompt: illustrations.prompt, status: illustrations.status, itemStatus: items.status })
          .from(illustrations).innerJoin(items, eq(items.id, illustrations.itemId)).where(eq(illustrations.id, illustrationId)).get();
        if (!row || row.status !== 'pending' || row.itemStatus === 'void') return;
        // 排队后画图模型的配置被去掉了：画不了，讲解里显示图的说明文字
        const drawer = illustrator?.();
        if (!drawer) {
          failIllustration(illustrationId);
          return;
        }
        const image = await drawer.draw({ prompt: row.prompt, size: ILLUSTRATION_SIZE });
        db.update(illustrations)
          .set({ status: 'ready', image: Buffer.from(image.data), mediaType: image.mediaType })
          .where(eq(illustrations.id, illustrationId))
          .run();
      },
      onGiveUp(payload) {
        failIllustration((payload as IllustrationPayload).illustrationId);
      },
    },
  };

  function failIllustration(illustrationId: string) {
    db.update(illustrations).set({ status: 'failed' }).where(eq(illustrations.id, illustrationId)).run();
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
