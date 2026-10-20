import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { openDb } from '../src/store/db';
import { topics } from '../src/store/schema';

describe('脚手架', () => {
  it('健康检查接口返回 ok', async () => {
    const res = await createApp().request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('内存数据库执行迁移后可以读写', () => {
    const db = openDb(':memory:');
    db.insert(topics).values({ id: 't1', title: 'TypeScript 常用技能', createdAt: new Date() }).run();
    const rows = db.select().from(topics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.graphStatus).toBe('pending');
  });
});
