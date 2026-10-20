import { describe, expect, it } from 'vitest';
import { loadPool } from '../../src/store/repo';
import { items } from '../../src/store/schema';
import { createHarness } from '../fixtures/harness';

const GUIDANCE = '多结合后端开发的真实例子';

/**
 * 开始一节时可选地写一段补充说明：按组装规则挑好内容后，按补充说明逐项重新生成（形式不变）再开始。
 * 不写补充说明时行为不变：只读候选池、不调用 AI。
 */
async function ready(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  await harness.startTopic();
  return { ...harness, poolBefore: loadPool(harness.db) };
}

describe('带补充说明开始一节', () => {
  it('每项都按补充说明重新生成，知识点与形式不变，原内容作废', async () => {
    const { call, db, calls, prompts, poolBefore } = await ready();
    const callsBefore = calls.length;
    const res = (await call('POST', '/api/sessions/next', { guidance: GUIDANCE })).body;
    const session = res.session;

    expect(res).toMatchObject({ resumed: false, guided: { applied: session.items.length, total: session.items.length } });
    // 每项调用一次模型，提示词里都带着补充说明
    expect(calls.length - callsBefore).toBe(session.items.length);
    for (const prompt of prompts.slice(callsBefore)) expect(prompt).toContain(GUIDANCE);

    const all = db.select().from(items).all();
    for (const item of session.items) {
      // 用的是新生成的内容，不是候选池里原有的
      expect(poolBefore.some((p) => p.id === item.id)).toBe(false);
      // 被替换的原内容：同一知识点、同一类型和形式，已作废
      const original = poolBefore.find((p) => p.knowledgePointId === item.knowledgePointId && p.kind === item.kind && p.form === item.form);
      expect(original).toBeDefined();
      expect(all.find((row) => row.id === original!.id)?.status).toBe('void');
    }
  });

  it('生成失败时沿用候选池里的原内容，这一节照常开始', async () => {
    const options: { invalid?: string[] } = {};
    const { call, poolBefore } = await ready(options);
    options.invalid = ['lesson', 'review']; // 候选池备好之后，模型开始只返回不合法内容
    const res = (await call('POST', '/api/sessions/next', { guidance: GUIDANCE })).body;
    expect(res.session.items.length).toBeGreaterThan(0);
    expect(res.guided).toEqual({ applied: 0, total: res.session.items.length });
    for (const item of res.session.items) expect(poolBefore.some((p) => p.id === item.id)).toBe(true);
  });

  it('有未完成的一节时继续那一节，不调用 AI，并告知是继续', async () => {
    const { call, calls } = await ready();
    const first = (await call('POST', '/api/sessions/next')).body.session;
    const callsBefore = calls.length;
    const res = (await call('POST', '/api/sessions/next', { guidance: GUIDANCE })).body;
    expect(res).toMatchObject({ resumed: true, guided: null, session: { id: first.id } });
    expect(calls.length).toBe(callsBefore);
  });

  it('不写或只写空白时不调用 AI；超过 500 字拒绝', async () => {
    const { call, calls } = await ready();
    const callsBefore = calls.length;
    const res = (await call('POST', '/api/sessions/next', { guidance: '   ' })).body;
    expect(res).toMatchObject({ resumed: false, guided: null });
    expect(res.session.items.length).toBeGreaterThan(0);
    expect(calls.length).toBe(callsBefore);

    const fresh = await ready();
    expect((await fresh.call('POST', '/api/sessions/next', { guidance: '长'.repeat(501) })).status).toBe(400);
  });
});
