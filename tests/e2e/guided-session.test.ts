import { describe, expect, it } from 'vitest';
import { loadPool, loadStates } from '../../src/store/repo';
import { items, sessions } from '../../src/store/schema';
import { MCQ } from '../fixtures/fake-model';
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

/**
 * 构建新一节：不管有没有未完成的一节、候选池备没备好，都现在构建。
 * 未完成的一节提前结束（答过的照常计入，没做的不计入）；候选池没有可学内容时当场生成。
 */
describe('构建新一节', () => {
  it('有未完成的一节时，提前结束它，再构建新的一节', async () => {
    const { call, db, startTopic } = createHarness();
    await startTopic();
    const old = (await call('POST', '/api/sessions/next')).body.session;
    await call('POST', '/api/attempts', { sessionId: old.id, itemId: old.items[0].id, answer: { choice: MCQ.answerIndex } });

    const res = (await call('POST', '/api/sessions/next', { fresh: true })).body;
    expect(res).toMatchObject({ resumed: false });
    expect(res.session.id).not.toBe(old.id);
    const finished = db.select().from(sessions).all().find((s) => s.id === old.id)!;
    expect(finished.finishedAt).not.toBeNull();
    // 答对未自评的一项按"良好"计入
    expect(loadStates(db).get(old.items[0].knowledgePointId)?.stage).toBe('recall');
  });

  it('候选池里没有可学的内容时当场生成；不构建时只能等后台准备', async () => {
    const { call, db, calls, startTopic } = createHarness();
    await startTopic();
    db.update(items).set({ status: 'void' }).run(); // 候选池清空
    expect((await call('POST', '/api/sessions/next')).body.session).toBeNull();

    const before = calls.length;
    const res = (await call('POST', '/api/sessions/next', { fresh: true })).body;
    expect(res.session.items.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(before);
  });

  it('构建时可以带补充说明', async () => {
    const { call, prompts, startTopic } = createHarness();
    await startTopic();
    const before = prompts.length;
    const res = (await call('POST', '/api/sessions/next', { fresh: true, guidance: GUIDANCE })).body;
    expect(res.guided).toEqual({ applied: res.session.items.length, total: res.session.items.length });
    for (const prompt of prompts.slice(before)) expect(prompt).toContain(GUIDANCE);
  });
});
