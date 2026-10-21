import { Hono } from 'hono';
import { z } from 'zod';
import { UserSettingsSchema } from '../settings';
import type { Services } from './services';
import { LearningError } from './views';

export interface AppDeps {
  services: Services;
  clock: () => Date;
  /** 开发模式下允许用 X-Dev-Now 请求头覆盖当前时间，用于验收"第二天" */
  devMode: boolean;
  /** 前端页面地址；直接打开服务端根路径时跳转过去。未知时返回 null */
  frontendUrl?: () => string | null;
}

const STAGES = ['unlearned', 'inferred', 'understand', 'recall', 'apply', 'retain'] as const;

const TopicBody = z.object({ title: z.string().trim().min(1, '请输入学习主题').max(100, '主题名称不超过 100 字') });
const TopicPatch = z
  .object({ status: z.enum(['active', 'paused']).optional(), priority: z.number().int().min(1).max(3).optional() })
  .refine((p) => p.status !== undefined || p.priority !== undefined, '没有要修改的内容');
const PlacementBody = z.object({ background: z.string().trim().max(500, '背景自述不超过 500 字') });
const PlacementAnswerBody = z.object({ pointId: z.string(), choice: z.number().int().min(-1) });
const NextSessionBody = z.object({
  // 可选的补充说明；全是空白时当作没写
  guidance: z.string().trim().max(500, '补充说明不超过 500 字').optional(),
  device: z.enum(['desktop', 'mobile']).optional(),
  timeZone: z.string().optional(),
  fresh: z.boolean().optional(),
});
const PreviewQuery = z.object({ device: z.enum(['desktop', 'mobile']).optional(), timeZone: z.string().optional() });
const AttemptBody = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  answer: z.union([z.object({ choice: z.number().int() }), z.object({ text: z.string() })]),
  durationMs: z.number().int().nonnegative().optional(),
});
const RatingBody = z.object({ selfRating: z.enum(['hard', 'good', 'easy']) });
const AppealBody = z.object({ reason: z.string().trim().min(1, '请写明申诉理由').max(1000, '申诉理由不超过 1000 字') });
const ThreadBody = z.object({ sessionId: z.string().optional(), pointId: z.string().optional() });
const ThreadQuery = z.object({ sessionId: z.string().optional(), pointId: z.string().optional() });
const AskBody = z.object({
  threadId: z.string(),
  itemId: z.string().optional(),
  pointId: z.string().optional(),
  quote: z.string().trim().max(2000, '引用的内容不超过 2000 字').optional(),
  question: z.string().trim().min(1, '请输入问题').max(1000, '问题不超过 1000 字'),
});
const AcceptBody = z.object({
  anchorPointId: z.string(),
  points: z
    .array(z.object({ title: z.string().trim().min(1).max(60), summary: z.string().trim().min(1).max(300), kind: z.enum(['prerequisite', 'extension']) }))
    .min(1, '请至少选一个知识点')
    .max(4),
});
const RevisitBody = z.object({ resumeTopicIds: z.array(z.string()) });
const RelearnBody = z.object({ knowledgePointIds: z.array(z.string()).min(1, '请选择要重新学习的知识点') });
const ExistingBody = z.object({ text: z.string().trim().min(1, '请输入已有知识').max(100, '已有知识不超过 100 字') });
const CheatsheetBody = z.object({ topicIds: z.array(z.string()).min(1, '请选择至少一个学习主题'), stages: z.array(z.enum(STAGES)).optional() });
const ExportBody = z.object({ topicIds: z.array(z.string()).min(1, '请选择至少一个学习主题'), records: z.boolean(), cheatsheetId: z.string().optional() });
const ReviewQuery = z.object({ timeZone: z.string().min(1), topicId: z.string().optional() });
const TimeZoneQuery = z.object({ timeZone: z.string().min(1) });
const DayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const SettingsPatch = UserSettingsSchema.partial();

/** 组装 HTTP 应用；依赖由调用方注入，便于测试。 */
export function createApp({ services, clock, devMode, frontendUrl }: AppDeps) {
  const { learning, knowledge, placement, preferences, asking } = services;
  const app = new Hono();

  const nowOf = (header: string | undefined) => {
    if (!devMode || !header) return clock();
    const date = new Date(header);
    if (Number.isNaN(date.getTime())) throw new LearningError('X-Dev-Now 不是合法的时间', 400);
    return date;
  };
  const now = (c: { req: { header(name: string): string | undefined } }) => nowOf(c.req.header('X-Dev-Now'));
  const body = async <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => schema.parse(await c.req.json().catch(() => ({})));

  app.onError((error, c) => {
    if (error instanceof LearningError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((i) => i.message).join('；') }, 400);
    console.error(error);
    return c.json({ error: '服务内部错误' }, 500);
  });

  // 服务端只提供 /api 接口；有人直接打开服务端地址时，带去前端页面而不是显示 404
  app.get('/', (c) => {
    const url = frontendUrl?.() ?? null;
    return url ? c.redirect(url) : c.text('这是微课堂的接口服务，页面请打开前端地址（start.sh 启动时会打印）。');
  });

  app.get('/api/health', (c) => c.json({ ok: true, devMode }));

  // ---------- 学习主题与摸底诊断 ----------

  app.get('/api/topics', (c) => c.json({ topics: learning.listTopics() }));
  app.post('/api/topics', async (c) => c.json(learning.startTopic((await body(c, TopicBody)).title, now(c)), 201));
  app.patch('/api/topics/:id', async (c) => c.json(learning.updateTopic(c.req.param('id'), await body(c, TopicPatch), now(c))));

  app.get('/api/topics/:id/placement', (c) => c.json(placement.status(c.req.param('id'))));
  app.post('/api/topics/:id/placement', async (c) =>
    c.json(placement.begin(c.req.param('id'), (await body(c, PlacementBody)).background, now(c))),
  );
  app.post('/api/topics/:id/placement/answer', async (c) => {
    const { pointId, choice } = await body(c, PlacementAnswerBody);
    return c.json(placement.answer(c.req.param('id'), pointId, choice, now(c)));
  });
  app.post('/api/topics/:id/placement/skip', (c) => c.json(placement.skip(c.req.param('id'), now(c))));

  // ---------- 微课堂 ----------

  app.get('/api/sessions/preview', (c) => {
    const { device, timeZone } = PreviewQuery.parse(c.req.query());
    return c.json(learning.previewNext(now(c), { device, timeZone }));
  });
  app.post('/api/sessions/next', async (c) => {
    const { guidance, device, timeZone, fresh } = await body(c, NextSessionBody);
    return c.json(await learning.nextSession(now(c), { guidance: guidance || undefined, device, timeZone, fresh }));
  });
  app.post('/api/sessions/:id/finish', (c) => c.json(learning.finishSession(c.req.param('id'), now(c))));
  app.post('/api/attempts', async (c) => c.json(await learning.submitAttempt(await body(c, AttemptBody), now(c)), 201));
  app.post('/api/attempts/:id/rating', async (c) =>
    c.json(learning.rateAttempt(c.req.param('id'), (await body(c, RatingBody)).selfRating, now(c))),
  );
  app.post('/api/attempts/:id/appeal', async (c) =>
    c.json(await learning.appealAttempt(c.req.param('id'), (await body(c, AppealBody)).reason, now(c))),
  );
  app.get('/api/ask-threads', (c) => c.json({ threads: asking.listThreads(ThreadQuery.parse(c.req.query())) }));
  app.post('/api/ask-threads', async (c) => c.json(asking.createThread(await body(c, ThreadBody), now(c)), 201));
  app.post('/api/ask-threads/:id/suggest', async (c) => c.json(await asking.suggest(c.req.param('id'))));
  app.post('/api/asks', async (c) => {
    const input = await body(c, AskBody);
    return c.json(await asking.ask({ ...input, quote: input.quote || undefined }, now(c)), 201);
  });
  app.post('/api/asks/accept', async (c) => c.json(asking.accept(await body(c, AcceptBody), now(c)), 201));
  app.post('/api/revisit', async (c) => c.json(learning.answerRevisit((await body(c, RevisitBody)).resumeTopicIds, now(c))));

  // ---------- 认知地图、回看、重新学习 ----------

  app.get('/api/map', (c) => c.json(knowledge.cognitiveMap(now(c))));
  app.get('/api/points/:id', (c) => c.json(knowledge.pointDetail(c.req.param('id'))));
  app.get('/api/review-days', (c) => c.json({ days: knowledge.reviewDays(ReviewQuery.parse(c.req.query())) }));
  app.get('/api/review-days/:day', (c) =>
    c.json(knowledge.dayReview({ day: DayParam.parse(c.req.param('day')), ...ReviewQuery.parse(c.req.query()) })),
  );
  app.post('/api/relearn', async (c) => c.json(knowledge.relearnPoints((await body(c, RelearnBody)).knowledgePointIds, now(c))));
  app.post('/api/existing-knowledge', async (c) => c.json(knowledge.addExistingKnowledge((await body(c, ExistingBody)).text, now(c)), 201));
  app.delete('/api/existing-knowledge/:id', (c) => c.json(knowledge.removeExistingKnowledge(c.req.param('id'))));

  // ---------- 速查表与导出 ----------

  app.get('/api/cheatsheets', (c) => c.json({ cheatsheets: knowledge.listCheatsheets() }));
  app.post('/api/cheatsheets', async (c) => c.json(knowledge.createCheatsheet(await body(c, CheatsheetBody), now(c)), 201));
  app.get('/api/cheatsheets/:id', (c) => c.json(knowledge.getCheatsheet(c.req.param('id'))));
  app.post('/api/export', async (c) => c.json(knowledge.exportMarkdown(await body(c, ExportBody), now(c))));

  // ---------- 设置与今天的安排 ----------

  app.get('/api/settings', (c) => c.json(preferences.getSettings()));
  app.put('/api/settings', async (c) => c.json(preferences.updateSettings(await body(c, SettingsPatch), now(c))));
  app.get('/api/today', (c) => c.json(preferences.today(now(c), TimeZoneQuery.parse(c.req.query()).timeZone)));

  return app;
}
