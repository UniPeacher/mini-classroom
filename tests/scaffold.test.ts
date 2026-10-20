import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Learning } from '../src/server/learning';
import { openDb } from '../src/store/db';
import { topics } from '../src/store/schema';
import { createHarness } from './fixtures/harness';

describe('脚手架', () => {
  it('健康检查接口返回 ok', async () => {
    const { call } = createHarness();
    expect(await call('GET', '/api/health')).toEqual({ status: 200, body: { ok: true, devMode: true } });
  });

  it('内存数据库执行迁移后可以读写', () => {
    const db = openDb(':memory:');
    db.insert(topics).values({ id: 't1', title: 'TypeScript 常用技能', createdAt: new Date() }).run();
    const rows = db.select().from(topics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.graphStatus).toBe('pending');
  });
});

describe('服务端根路径', () => {
  const learning = {} as Learning;
  const clock = () => new Date();

  it('知道前端地址时跳转到前端页面，而不是 404', async () => {
    const app = createApp({ learning, clock, devMode: false, frontendUrl: () => 'http://127.0.0.1:6101' });
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:6101');
  });

  it('前端未启动时说明这是接口服务', async () => {
    const app = createApp({ learning, clock, devMode: false, frontendUrl: () => null });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('接口服务');
  });
});
