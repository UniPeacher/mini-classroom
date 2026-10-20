import { describe, expect, it } from 'vitest';
import { APPEAL_ACCEPT_MARK, APPEAL_VOID_MARK, CORRECT_MARK, MCQ } from '../fixtures/fake-model';
import { createHarness } from '../fixtures/harness';

/** 第 1 节："联合类型"选择题答对，"unknown 类型收窄"简答答错 */
async function firstSession(harness = createHarness()) {
  await harness.startTopic();
  const session = (await harness.call('POST', '/api/sessions/next')).body.session;
  const [union, unknown] = session.items;
  const right = await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: union.id, answer: { choice: MCQ.answerIndex } });
  const wrong = await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: unknown.id, answer: { text: '不记得了' } });
  const stageOf = async (id: string) => (await harness.call('GET', `/api/points/${id}`)).body.stage;
  return { ...harness, session, union, unknown, rightId: right.body.attemptId, wrongId: wrong.body.attemptId, stageOf };
}

/**
 * 申诉：对 AI 的判错有异议时由 AI 重新判定。答案也成立则改判答对、补一次自评；
 * 题目有误则作废、不计入记忆状态；否则维持原判。
 */
describe('申诉', () => {
  it('答案也成立：还原作答前的记忆状态，改判为答对，补自评后按答对计入', async () => {
    const { call, unknown, wrongId, stageOf } = await firstSession();
    expect(await stageOf(unknown.knowledgePointId)).toBe('understand');
    const res = await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: `我的说法也对 ${APPEAL_ACCEPT_MARK}` });
    expect(res.body).toEqual({ outcome: 'accepted', feedback: '你的答案也成立', needsRating: true });
    expect(await stageOf(unknown.knowledgePointId)).toBe('unlearned');
    await call('POST', `/api/attempts/${wrongId}/rating`, { selfRating: 'good' });
    expect(await stageOf(unknown.knowledgePointId)).toBe('recall');
  });

  it('题目有误：这次作答作废，记忆状态还原，作答记录里标明', async () => {
    const { call, unknown, wrongId, stageOf } = await firstSession();
    const res = await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: `题目有歧义 ${APPEAL_VOID_MARK}` });
    expect(res.body.outcome).toBe('void');
    expect(await stageOf(unknown.knowledgePointId)).toBe('unlearned');
    const record = (await call('GET', `/api/points/${unknown.knowledgePointId}`)).body.records[0];
    expect(record).toMatchObject({ voided: true, appeal: { outcome: 'void', reason: `题目有歧义 ${APPEAL_VOID_MARK}` } });
  });

  it('维持原判：记忆状态不变', async () => {
    const { call, unknown, wrongId, stageOf } = await firstSession();
    expect((await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: '我觉得没错' })).body.outcome).toBe('rejected');
    expect(await stageOf(unknown.knowledgePointId)).toBe('understand');
  });

  it('答对的不能申诉；同一次作答只能申诉一次；理由不能为空', async () => {
    const { call, rightId, wrongId } = await firstSession();
    expect((await call('POST', `/api/attempts/${rightId}/appeal`, { reason: '…' })).status).toBe(400);
    await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: '我觉得没错' });
    expect((await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: '再申诉' })).status).toBe(409);
    expect((await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: '  ' })).status).toBe(400);
  });

  it('之后这个知识点又有了计入记忆的作答，就不能再对早先那次申诉', async () => {
    const harness = await firstSession();
    const { call, worker, session, unknown, wrongId } = harness;
    await call('POST', `/api/sessions/${session.id}/finish`);
    await worker.runUntilIdle();
    const next = (await call('POST', '/api/sessions/next')).body.session;
    const again = next.items.find((i: any) => i.knowledgePointId === unknown.knowledgePointId);
    await call('POST', '/api/attempts', { sessionId: next.id, itemId: again.id, answer: { choice: 0 } });
    expect((await call('POST', `/api/attempts/${wrongId}/appeal`, { reason: APPEAL_ACCEPT_MARK })).status).toBe(409);
  });
});

/**
 * 联结练习：每个新知识点讲完后，用自己的话说明它和一个已学知识（或已有知识）的关系。
 * 认可后成为认知地图上带原话的联结；不认可的不入图，对方知识点立即到期复习。
 */
describe('联结练习', () => {
  it('有已有知识时，新知识点讲完后接一道联结练习；认可后成为带原话的联结', async () => {
    const harness = createHarness();
    await harness.call('POST', '/api/existing-knowledge', { text: '会写 JavaScript' });
    await harness.startTopic();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    expect(session.items.map((i: any) => i.purpose)).toEqual(['new', 'connection', 'new', 'connection']);
    const exercise = session.items[1];
    expect(exercise.knowledgePointId).toBe(session.items[0].knowledgePointId);
    expect(exercise.connection.prompt).toContain('会写 JavaScript');

    const quote = `${CORRECT_MARK} 联合类型像 JS 里一个变量可以存不同类型的值`;
    const res = await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: exercise.id, answer: { text: quote } });
    expect(res.body).toMatchObject({ correct: true, needsRating: false, reveal: { relation: '前者是后者的前提' } });
    const map = (await harness.call('GET', '/api/map')).body;
    expect(map.connections).toHaveLength(1);
    expect(map.connections[0]).toMatchObject({ fromPointId: exercise.knowledgePointId, quote, toExisting: { text: '会写 JavaScript' } });
  });

  it('联结不成立：不入图；对方是已学知识点时，它立即到期复习', async () => {
    const harness = createHarness();
    const { call, worker } = harness;
    await harness.startTopic();
    // 第 1 节：两个前置都答对，第 2 节新学"知识点 0"时就能与它们建立联结
    const first = (await call('POST', '/api/sessions/next')).body.session;
    for (const item of first.items) {
      const answer = item.question.type === 'mcq' ? { choice: MCQ.answerIndex } : { text: `${CORRECT_MARK} 答案` };
      const res = await call('POST', '/api/attempts', { sessionId: first.id, itemId: item.id, answer });
      await call('POST', `/api/attempts/${res.body.attemptId}/rating`, { selfRating: 'good' });
    }
    await call('POST', `/api/sessions/${first.id}/finish`);
    await worker.runUntilIdle();

    const second = (await call('POST', '/api/sessions/next')).body.session;
    const index = second.items.findIndex((i: any) => i.title === '知识点 0');
    const exercise = second.items[index + 1];
    expect(exercise.purpose).toBe('connection');
    expect(exercise.connection.partner).toBe('unknown 类型收窄');

    await call('POST', '/api/attempts', { sessionId: second.id, itemId: exercise.id, answer: { text: '它们没有关系' } });
    const map = (await call('GET', '/api/map')).body;
    expect(map.connections).toEqual([]);
    const partner = map.points.find((p: any) => p.title === 'unknown 类型收窄');
    expect(new Date(partner.nextReviewAt).getTime()).toBeLessThanOrEqual(new Date('2026-10-20T09:00:00Z').getTime());
  });

  it('联结练习不能申诉；挂着联结的已有知识不能删除', async () => {
    const harness = createHarness();
    const known = (await harness.call('POST', '/api/existing-knowledge', { text: '会写 JavaScript' })).body;
    await harness.startTopic();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    const exercise = session.items[1];
    const res = await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: exercise.id, answer: { text: `${CORRECT_MARK} 说明` } });
    expect((await harness.call('POST', `/api/attempts/${res.body.attemptId}/appeal`, { reason: '…' })).status).toBe(400);
    expect((await harness.call('DELETE', `/api/existing-knowledge/${known.id}`)).status).toBe(409);
  });
});
