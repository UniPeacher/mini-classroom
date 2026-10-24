import { describe, expect, it } from 'vitest';
import { MAX_PLACEMENT_QUESTIONS } from '../../src/domain/placement';
import { MCQ, START_MARK } from '../fixtures/fake-model';
import { createHarness } from '../fixtures/harness';

const UNKNOWN = -1;

/**
 * 摸底诊断：先自述背景（得到已有知识和起点），再顺着前置关系自适应出题，每题都有"不知道"。
 * 直接答对的不再教，推断掌握的先不教、后续抽查，其余按未学处理。
 */
describe('摸底诊断', () => {
  async function newTopic() {
    const harness = createHarness();
    const topicId = await harness.startTopic('TypeScript 常用技能', { skipPlacement: false });
    const placement = (path = '') => `/api/topics/${topicId}/placement${path}`;
    return { ...harness, topicId, placement };
  }

  /** 做完摸底：第一题（起点"知识点 0"）答对，其余都选"不知道" */
  async function finishedPlacement() {
    const harness = await newTopic();
    const { call, worker, placement } = harness;
    await call('POST', placement(), { background: `写过两年 JavaScript ${START_MARK}` });
    await worker.runUntilIdle();
    let state = (await call('GET', placement())).body;
    const first = state.question.title;
    state = (await call('POST', placement('/answer'), { pointId: state.question.pointId, choice: MCQ.answerIndex })).body;
    while (state.status === 'testing') {
      state = (await call('POST', placement('/answer'), { pointId: state.question.pointId, choice: UNKNOWN })).body;
    }
    await worker.runUntilIdle();
    const map = (await call('GET', '/api/map')).body;
    const stageOf = (title: string) => map.points.find((p: any) => p.title === title).stage;
    return { ...harness, first, state, map, stageOf };
  }

  it('图谱生成后先等摸底：摸底完成或跳过之前，这个主题不新学', async () => {
    const { call, placement } = await newTopic();
    expect((await call('GET', placement())).body).toMatchObject({ status: 'pending', question: null });
    expect((await call('POST', '/api/sessions/next')).body.session).toBeNull();
    // 认知地图上这些知识点只是"未学"，不是"前置没学会"的迷雾
    const map = (await call('GET', '/api/map')).body;
    expect(map.points.every((p: any) => p.stage === 'unlearned' && !p.onEdge && !p.fog)).toBe(true);
  });

  it('提交背景自述后，后台备好候选题；题目不带答案，另有"不知道"由页面提供', async () => {
    const { call, worker, placement } = await newTopic();
    expect((await call('POST', placement(), { background: '写过两年 JavaScript' })).body.status).toBe('preparing');
    await worker.runUntilIdle();
    const state = (await call('GET', placement())).body;
    expect(state).toMatchObject({ status: 'testing', answered: 0, maxQuestions: MAX_PLACEMENT_QUESTIONS });
    expect(state.question.options).toEqual(MCQ.options.map((o) => o.text));
    expect(state.question).not.toHaveProperty('answerIndex');
  });

  it('从背景自述推断的起点开始出题，并把背景提炼为已有知识', async () => {
    const { first, map } = await finishedPlacement();
    expect(first).toBe('知识点 0');
    expect(map.existingKnowledge.map((k: any) => k.text)).toEqual(['会写 JavaScript']);
  });

  it('直接答对的进入回忆阶段，它的前置推断掌握，选"不知道"的按未学处理', async () => {
    const { state, stageOf } = await finishedPlacement();
    expect(state.status).toBe('done');
    expect(stageOf('知识点 0')).toBe('recall');
    expect(stageOf('联合类型')).toBe('inferred');
    expect(stageOf('unknown 类型收窄')).toBe('inferred');
    expect(stageOf('知识点 1')).toBe('unlearned');
    expect(state.summary).toEqual({ correct: 1, inferred: 2, unknown: 12 });
  });

  it('之后的微课堂抽查推断掌握的知识点：答对视为已掌握', async () => {
    const { call, worker } = await finishedPlacement();
    await worker.runUntilIdle();
    const session = (await call('POST', '/api/sessions/next')).body.session;
    const spotChecks = session.items.filter((i: any) => i.purpose === 'spot_check');
    expect(spotChecks.map((i: any) => i.title).sort()).toEqual(['unknown 类型收窄', '联合类型']);

    const check = spotChecks[0];
    const answer = check.question.type === 'mcq' ? { choice: MCQ.answerIndex } : { text: '[对] 答案' };
    const res = await call('POST', '/api/attempts', { sessionId: session.id, itemId: check.id, answer });
    await call('POST', `/api/attempts/${res.body.attemptId}/rating`, { selfRating: 'good' });
    const map = (await call('GET', '/api/map')).body;
    expect(map.points.find((p: any) => p.id === check.knowledgePointId).stage).toBe('recall');
  });

  it('只能回答当前这道题', async () => {
    const { call, worker, placement } = await newTopic();
    await call('POST', placement(), { background: '' });
    await worker.runUntilIdle();
    expect((await call('POST', placement('/answer'), { pointId: 'not-current', choice: 0 })).status).toBe(409);
  });

  it('跳过摸底：所有知识点从未学开始，可以新学', async () => {
    const { call, worker, placement } = await newTopic();
    expect((await call('POST', placement('/skip'))).body.status).toBe('skipped');
    await worker.runUntilIdle();
    expect((await call('POST', '/api/sessions/next')).body.session.items.length).toBeGreaterThan(0);
  });

  it('摸底题准备失败时退回待开始，可以重新开始', async () => {
    const harness = createHarness({ invalid: ['placement'] });
    const topicId = await harness.startTopic('TypeScript 常用技能', { skipPlacement: false });
    await harness.call('POST', `/api/topics/${topicId}/placement`, { background: '' });
    await harness.worker.runUntilIdle();
    expect((await harness.call('GET', `/api/topics/${topicId}/placement`)).body.status).toBe('pending');
    expect((await harness.call('GET', `/api/topics/${topicId}/placement`)).body.preparationFailed).toBe(true);
  });
});
