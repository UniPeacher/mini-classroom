import { describe, expect, it } from 'vitest';
import { GRAPH, MCQ } from '../fixtures/fake-model';
import { createHarness } from '../fixtures/harness';

/**
 * 点开学习主题看到它在认知地图中的部分：
 * 每个知识点的掌握阶段、是否在认知边缘、下次复习时间，以及学过的讲解和作答记录。
 */
describe('学习主题的认知地图', () => {
  /** 第 1 节："联合类型"选择题答对并自评良好，"unknown 类型收窄"简答答错 */
  async function afterFirstSession() {
    const harness = createHarness();
    const { topicId } = (await harness.call('POST', '/api/topics', { title: 'TypeScript 常用技能' })).body;
    await harness.worker.runUntilIdle();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    const [union, unknown] = session.items;
    const ok = await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: union.id, answer: { choice: MCQ.answerIndex } });
    await harness.call('POST', `/api/attempts/${ok.body.attemptId}/rating`, { selfRating: 'good' });
    await harness.call('POST', '/api/attempts', { sessionId: session.id, itemId: unknown.id, answer: { text: '不记得了' } });
    await harness.call('POST', `/api/sessions/${session.id}/finish`);
    const map = (await harness.call('GET', `/api/topics/${topicId}/map`)).body;
    const byTitle = (title: string) => map.points.find((p: any) => p.title === title);
    return { map, byTitle };
  }

  it('按推荐顺序列出主题下的全部知识点', async () => {
    const { map } = await afterFirstSession();
    expect(map.topic.title).toBe('TypeScript 常用技能');
    expect(map.points.map((p: any) => p.title)).toEqual(GRAPH.knowledgePoints.map((k) => k.title));
  });

  it('学会的知识点：处于回忆阶段，有下次复习时间，可回看讲解、小题、作答和自评', async () => {
    const { byTitle } = await afterFirstSession();
    const union = byTitle('联合类型');
    expect(union).toMatchObject({ stage: 'recall', onEdge: false });
    expect(union.nextReviewAt).toEqual(expect.any(String));
    expect(union.records).toHaveLength(1);
    const [record] = union.records;
    expect(record).toMatchObject({ kind: 'lesson', correct: true, selfRating: 'good', answer: { choice: MCQ.answerIndex } });
    expect(record.explanation).toEqual(expect.any(String));
    // 作答过的题目可以看到正确答案和解析
    expect(record.question).toMatchObject({ answerIndex: MCQ.answerIndex, explanation: MCQ.explanation });
  });

  it('答错的知识点：留在理解阶段，记录中带错误类型、批改反馈和参考答案', async () => {
    const { byTitle } = await afterFirstSession();
    const unknown = byTitle('unknown 类型收窄');
    expect(unknown).toMatchObject({ stage: 'understand', nextReviewAt: null });
    expect(unknown.records).toHaveLength(1);
    expect(unknown.records[0]).toMatchObject({ correct: false, errorType: 'misconception', answer: { text: '不记得了' } });
    expect(unknown.records[0].feedback).toEqual(expect.any(String));
    expect(unknown.records[0].question).toHaveProperty('referenceAnswer');
  });

  it('没学的知识点只有标题和概要；前置都学会的在认知边缘，前置没学会的不在', async () => {
    const { byTitle } = await afterFirstSession();
    // 知识点 0 的前置是联合类型（已学会）和 unknown 收窄（没学会）
    expect(byTitle('知识点 0')).toMatchObject({ stage: 'unlearned', onEdge: false, records: [], summary: '要掌握的内容' });
    expect(byTitle('知识点 1')).toMatchObject({ stage: 'unlearned', onEdge: true, records: [] });
  });

  it('图谱还在生成时没有知识点；主题不存在时返回 404', async () => {
    const { call } = createHarness();
    const { topicId } = (await call('POST', '/api/topics', { title: 'TypeScript 常用技能' })).body;
    const pending = (await call('GET', `/api/topics/${topicId}/map`)).body;
    expect(pending.topic.graphStatus).toBe('pending');
    expect(pending.points).toEqual([]);
    expect((await call('GET', '/api/topics/no-such-topic/map')).status).toBe(404);
  });
});
