import { Hono } from 'hono';
import { z } from 'zod';
import { LearningError, type Learning } from './learning';

export interface AppDeps {
  learning: Learning;
  clock: () => Date;
  /** 开发模式下允许用 X-Dev-Now 请求头覆盖当前时间，用于验收"第二天" */
  devMode: boolean;
}

const TopicBody = z.object({ title: z.string().trim().min(1, '请输入学习主题') });
const AttemptBody = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  answer: z.union([z.object({ choice: z.number().int() }), z.object({ text: z.string() })]),
  durationMs: z.number().int().nonnegative().optional(),
});
const RatingBody = z.object({ selfRating: z.enum(['hard', 'good', 'easy']) });

/** 组装 HTTP 应用；依赖由调用方注入，便于测试。 */
export function createApp({ learning, clock, devMode }: AppDeps) {
  const app = new Hono();

  const nowOf = (header: string | undefined) => {
    if (!devMode || !header) return clock();
    const date = new Date(header);
    if (Number.isNaN(date.getTime())) throw new LearningError('X-Dev-Now 不是合法的时间', 400);
    return date;
  };

  app.onError((error, c) => {
    if (error instanceof LearningError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((i) => i.message).join('；') }, 400);
    console.error(error);
    return c.json({ error: '服务内部错误' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/topics', (c) => c.json({ topics: learning.listTopics() }));

  app.post('/api/topics', async (c) => {
    const { title } = TopicBody.parse(await c.req.json());
    return c.json(learning.startTopic(title, nowOf(c.req.header('X-Dev-Now'))), 201);
  });

  app.post('/api/sessions/next', (c) => c.json(learning.nextSession(nowOf(c.req.header('X-Dev-Now')))));

  app.post('/api/attempts', async (c) => {
    const body = AttemptBody.parse(await c.req.json());
    return c.json(await learning.submitAttempt(body, nowOf(c.req.header('X-Dev-Now'))), 201);
  });

  app.post('/api/attempts/:id/rating', async (c) => {
    const { selfRating } = RatingBody.parse(await c.req.json());
    return c.json(learning.rateAttempt(c.req.param('id'), selfRating, nowOf(c.req.header('X-Dev-Now'))));
  });

  app.post('/api/sessions/:id/finish', (c) =>
    c.json(learning.finishSession(c.req.param('id'), nowOf(c.req.header('X-Dev-Now')))),
  );

  return app;
}
