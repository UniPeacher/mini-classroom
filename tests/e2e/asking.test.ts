import { describe, expect, it } from 'vitest';
import { createHarness } from '../fixtures/harness';

/**
 * 学习时随时提问：AI 结合正在学的这一项回答；小题作答前不直接给答案。
 * 可以从提问中整理出还不了解的知识，用户确认后加入认知地图，之后的微课堂安排学习。
 */
describe('学习时提问', () => {
  async function inSession() {
    const harness = createHarness();
    await harness.startTopic();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    return { ...harness, session, item: session.items[0] };
  }

  it('结合正在学的这一项回答，问答记在这一节里', async () => {
    const { call, prompts, session, item } = await inSession();
    const before = prompts.length;
    const res = await call('POST', '/api/asks', { sessionId: session.id, itemId: item.id, question: '联合类型和交叉类型有什么区别？' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toEqual(expect.any(String));
    // 提示词带上了正在学的知识点和讲解
    expect(prompts[before]).toContain('知识点：联合类型');
    expect(prompts[before]).toContain('讲解内容');
    const listed = (await call('GET', `/api/sessions/${session.id}/asks`)).body.asks;
    expect(listed.map((a: any) => a.question)).toEqual(['联合类型和交叉类型有什么区别？']);
  });

  it('小题还没作答时，提示词要求不直接给出答案；作答后可以讨论答案', async () => {
    const { call, prompts, session, item } = await inSession();
    await call('POST', '/api/asks', { sessionId: session.id, itemId: item.id, question: '这题答案是什么？' });
    expect(prompts.at(-1)).toContain('不要直接给出答案');
    await call('POST', '/api/attempts', { sessionId: session.id, itemId: item.id, answer: { choice: 1 } });
    await call('POST', '/api/asks', { sessionId: session.id, itemId: item.id, question: '为什么选 B？' });
    expect(prompts.at(-1)).toContain('可以直接讨论小题的答案');
    // 第二次提问带上了之前的问答
    expect(prompts.at(-1)).toContain('这题答案是什么？');
  });

  it('从提问中整理出不了解的知识（去掉已有的），确认后加入认知地图，缺的基础挂成前置', async () => {
    const { call, worker, session, item } = await inSession();
    await call('POST', '/api/asks', { sessionId: session.id, itemId: item.id, question: '怎么判断一个值是不是字符串？' });
    const { anchor, suggestions } = (await call('POST', `/api/sessions/${session.id}/asks/suggest`)).body;
    expect(anchor.title).toBe('联合类型');
    expect(suggestions.map((s: any) => s.title)).toEqual(['类型守卫']);

    const res = await call('POST', '/api/asks/accept', { anchorPointId: anchor.id, points: suggestions });
    expect(res.body).toMatchObject({ added: 1, skipped: 0 });
    await worker.runUntilIdle();
    const map = (await call('GET', '/api/map')).body;
    const added = map.points.find((p: any) => p.title === '类型守卫');
    expect(added).toMatchObject({ stage: 'unlearned', origin: 'asked', mastery: 0 });
    expect(map.points.find((p: any) => p.title === '联合类型').prerequisiteIds).toContain(added.id);
  });

  it('同名知识点不会重复加入；没有提问时不能整理', async () => {
    const { call, session, item } = await inSession();
    expect((await call('POST', `/api/sessions/${session.id}/asks/suggest`)).status).toBe(400);
    const res = await call('POST', '/api/asks/accept', {
      anchorPointId: item.knowledgePointId,
      points: [{ title: '联合类型', summary: '已有', kind: 'extension' }],
    });
    expect(res.body).toMatchObject({ added: 0, skipped: 1 });
  });

  it('问题不能为空；这一项不属于本节时 404', async () => {
    const { call, session } = await inSession();
    expect((await call('POST', '/api/asks', { sessionId: session.id, question: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/asks', { sessionId: session.id, itemId: 'nope', question: '问' })).status).toBe(404);
  });
});
