import { Hono } from 'hono';

/** 组装 HTTP 应用；依赖由调用方注入，便于测试。 */
export function createApp() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  return app;
}
