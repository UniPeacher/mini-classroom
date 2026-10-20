import { describe, expect, it } from 'vitest';
import { loadStates } from '../../src/store/repo';
import { CORRECT_MARK, MCQ } from '../fixtures/fake-model';
import { DAY, DAY1, createHarness } from '../fixtures/harness';

/**
 * 切片 1 验收场景：
 * 第 1 节"联合类型"选择题答对并自评良好，"unknown 类型收窄"简答答错；
 * 第二天打开第 2 节：不调用 AI、即时返回、unknown 换形式重现、联合类型未到期不出现、至少 1 个新知识点。
 */
describe('验收：从新建主题到第二节微课堂', () => {
  it('完整走通', async () => {
    const { call, worker, calls, db } = createHarness();

    // 新建主题，后台生成图谱并补满候选池
    expect((await call('POST', '/api/topics', { title: 'TypeScript 常用技能' })).status).toBe(201);
    await worker.runUntilIdle();

    // ---- 第 1 节 ----
    const first = (await call('POST', '/api/sessions/next')).body.session;
    const titles1 = first.items.map((i: any) => i.title);
    expect(titles1).toEqual(['联合类型', 'unknown 类型收窄']);
    const [union, unknown] = first.items;
    expect(first.items.every((i: any) => i.purpose === 'new')).toBe(true);
    expect(union.question.type).toBe('mcq');
    expect(unknown.question.type).toBe('short_answer');
    // 作答前不泄露答案
    expect(union.question).not.toHaveProperty('answerIndex');
    expect(unknown.question).not.toHaveProperty('referenceAnswer');

    const unionAttempt = await call('POST', '/api/attempts', { sessionId: first.id, itemId: union.id, answer: { choice: MCQ.answerIndex } });
    expect(unionAttempt.body).toMatchObject({ correct: true, needsRating: true });
    expect((await call('POST', `/api/attempts/${unionAttempt.body.attemptId}/rating`, { selfRating: 'good' })).status).toBe(200);

    const unknownAttempt = await call('POST', '/api/attempts', {
      sessionId: first.id,
      itemId: unknown.id,
      answer: { text: '不记得了' },
    });
    expect(unknownAttempt.body).toMatchObject({ correct: false, errorType: 'misconception', needsRating: false });
    expect(unknownAttempt.body.reveal).toHaveProperty('referenceAnswer');

    expect((await call('POST', `/api/sessions/${first.id}/finish`)).status).toBe(200);
    await worker.runUntilIdle();

    const states = loadStates(db);
    expect(states.get(union.knowledgePointId)?.stage).toBe('recall');
    expect(states.get(unknown.knowledgePointId)?.stage).toBe('understand');

    // ---- 第二天，第 2 节 ----
    const callsBefore = calls.length;
    const startedAt = performance.now();
    const second = (await call('POST', '/api/sessions/next', undefined, new Date(DAY1.getTime() + DAY))).body.session;
    const elapsed = performance.now() - startedAt;

    expect(calls.length).toBe(callsBefore); // 打开时不调用 AI
    expect(elapsed).toBeLessThan(200);

    const unknownAgain = second.items.find((i: any) => i.knowledgePointId === unknown.knowledgePointId);
    expect(unknownAgain).toBeDefined();
    expect(unknownAgain.purpose).toBe('advance');
    expect(unknownAgain.form).not.toBe(unknown.form); // 换一种讲解形式
    expect(unknownAgain.question.type).not.toBe(unknown.question.type); // 小题也换形式

    expect(second.items.some((i: any) => i.knowledgePointId === union.knowledgePointId)).toBe(false); // 未到期
    const newOnes = second.items.filter(
      (i: any) => i.knowledgePointId !== unknown.knowledgePointId && i.knowledgePointId !== union.knowledgePointId,
    );
    expect(newOnes.length).toBeGreaterThanOrEqual(1);
    expect(newOnes.every((i: any) => i.purpose === 'new')).toBe(true);
    // 同一节里的多个新知识点，小题形式交替出现
    if (newOnes.length >= 2) expect(new Set(newOnes.map((i: any) => i.question.type)).size).toBe(2);
  });
});

describe('学习流程的边界情况', () => {
  async function started() {
    const harness = createHarness();
    await harness.call('POST', '/api/topics', { title: 'TypeScript 常用技能' });
    await harness.worker.runUntilIdle();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    return { ...harness, session };
  }

  it('图谱还没生成好时，提示"准备中"而不是报错', async () => {
    const { call } = createHarness();
    await call('POST', '/api/topics', { title: 'TypeScript 常用技能' });
    expect((await call('POST', '/api/sessions/next')).body).toEqual({ session: null, preparing: true, resumed: false, guided: null });
  });

  it('有未结束的一节时，继续这一节，并带上已作答的结果', async () => {
    const { call, session } = await started();
    await call('POST', '/api/attempts', { sessionId: session.id, itemId: session.items[0].id, answer: { choice: 0 } });
    const again = (await call('POST', '/api/sessions/next')).body.session;
    expect(again.id).toBe(session.id);
    expect(again.items[0].attempt).toMatchObject({ correct: false, errorType: 'misconception' });
    expect(again.items[1].attempt).toBeNull();
  });

  it('同一项不能重复作答', async () => {
    const { call, session } = await started();
    const body = { sessionId: session.id, itemId: session.items[0].id, answer: { choice: 1 } };
    await call('POST', '/api/attempts', body);
    expect((await call('POST', '/api/attempts', body)).status).toBe(409);
  });

  it('答错时不能自评', async () => {
    const { call, session } = await started();
    const wrong = await call('POST', '/api/attempts', { sessionId: session.id, itemId: session.items[0].id, answer: { choice: 0 } });
    expect((await call('POST', `/api/attempts/${wrong.body.attemptId}/rating`, { selfRating: 'easy' })).status).toBe(400);
  });

  it('答案类型与题型不符时拒绝', async () => {
    const { call, session } = await started();
    const res = await call('POST', '/api/attempts', { sessionId: session.id, itemId: session.items[0].id, answer: { text: '文字' } });
    expect(res.status).toBe(400);
  });

  it('简答答对后自评，记忆状态按自评更新', async () => {
    const { call, session, db } = await started();
    const shortItem = session.items[1];
    const res = await call('POST', '/api/attempts', { sessionId: session.id, itemId: shortItem.id, answer: { text: `${CORRECT_MARK} 我的答案` } });
    expect(res.body).toMatchObject({ correct: true, needsRating: true });
    expect(loadStates(db).get(shortItem.knowledgePointId)?.stage).toBe('unlearned'); // 自评前不更新
    await call('POST', `/api/attempts/${res.body.attemptId}/rating`, { selfRating: 'easy' });
    expect(loadStates(db).get(shortItem.knowledgePointId)?.stage).toBe('recall');
  });

  it('结束时答对但没自评的，按"良好"计入', async () => {
    const { call, session, db } = await started();
    await call('POST', '/api/attempts', { sessionId: session.id, itemId: session.items[0].id, answer: { choice: 1 } });
    await call('POST', `/api/sessions/${session.id}/finish`);
    expect(loadStates(db).get(session.items[0].knowledgePointId)?.stage).toBe('recall');
  });

  it('已结束的一节不能再作答', async () => {
    const { call, session } = await started();
    await call('POST', `/api/sessions/${session.id}/finish`);
    const res = await call('POST', '/api/attempts', { sessionId: session.id, itemId: session.items[0].id, answer: { choice: 1 } });
    expect(res.status).toBe(409);
  });

  it('新建主题时标题不能为空', async () => {
    const { call } = createHarness();
    expect((await call('POST', '/api/topics', { title: '  ' })).status).toBe(400);
  });
});
