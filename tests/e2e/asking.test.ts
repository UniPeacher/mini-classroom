import { describe, expect, it } from 'vitest';
import { createHarness } from '../fixtures/harness';

/**
 * 学习时随时提问：按会话组织，新建会话后不再带上之前的上下文。
 * AI 结合正在学的这一项（或正在看的知识点）和选中的内容回答；小题作答前不直接给答案。
 * 可以从一个会话的提问中整理出还不了解的知识，用户点选后加入认知地图，之后的微课堂安排学习。
 */
describe('学习时提问', () => {
  async function inSession() {
    const harness = createHarness();
    await harness.startTopic();
    const session = (await harness.call('POST', '/api/sessions/next')).body.session;
    const thread = (await harness.call('POST', '/api/ask-threads', { sessionId: session.id })).body;
    const ask = (question: string, extra: Record<string, unknown> = {}) =>
      harness.call('POST', '/api/asks', { threadId: thread.id, itemId: session.items[0].id, question, ...extra });
    return { ...harness, session, item: session.items[0], thread, ask };
  }

  it('结合正在学的这一项回答，问答记在会话里', async () => {
    const { call, prompts, session, ask } = await inSession();
    const before = prompts.length;
    const res = await ask('联合类型和交叉类型有什么区别？');
    expect(res.status).toBe(201);
    expect(res.body.answer).toEqual(expect.any(String));
    expect(prompts[before]).toContain('知识点：联合类型');
    expect(prompts[before]).toContain('讲解内容');
    const threads = (await call('GET', `/api/ask-threads?sessionId=${session.id}`)).body.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].asks.map((a: any) => a.question)).toEqual(['联合类型和交叉类型有什么区别？']);
  });

  it('选中的内容随提问一起交给 AI，并记在问答里', async () => {
    const { prompts, ask } = await inSession();
    const res = await ask('这句话是什么意思？', { quote: '用 | 表示多种可能的类型' });
    expect(res.body.quote).toBe('用 | 表示多种可能的类型');
    expect(prompts.at(-1)).toContain('学习者选中了这段内容来问');
    expect(prompts.at(-1)).toContain('用 | 表示多种可能的类型');
  });

  it('小题还没作答时，提示词要求不直接给出答案；作答后可以讨论答案，并接着上文', async () => {
    const { call, prompts, session, item, ask } = await inSession();
    await ask('这题答案是什么？');
    expect(prompts.at(-1)).toContain('不要直接给出答案');
    await call('POST', '/api/attempts', { sessionId: session.id, itemId: item.id, answer: { choice: 1 } });
    await ask('为什么选 B？');
    expect(prompts.at(-1)).toContain('可以直接讨论小题的答案');
    expect(prompts.at(-1)).toContain('这题答案是什么？');
  });

  it('新建会话后不再带上之前的问答；会话列表最新的在前', async () => {
    const { call, prompts, session, item, ask } = await inSession();
    await ask('第一个会话里的问题');
    const second = (await call('POST', '/api/ask-threads', { sessionId: session.id })).body;
    await call('POST', '/api/asks', { threadId: second.id, itemId: item.id, question: '新会话的问题' });
    expect(prompts.at(-1)).not.toContain('第一个会话里的问题');
    const threads = (await call('GET', `/api/ask-threads?sessionId=${session.id}`)).body.threads;
    expect(threads.map((t: any) => t.id)[0]).toBe(second.id);
  });

  it('在认知地图里看知识点时也能提问，结合这个知识点回答', async () => {
    const { call, prompts, item } = await inSession();
    const thread = (await call('POST', '/api/ask-threads', { pointId: item.knowledgePointId })).body;
    await call('POST', '/api/asks', { threadId: thread.id, question: '它在实际项目里怎么用？' });
    expect(prompts.at(-1)).toContain('知识点：联合类型');
    const threads = (await call('GET', `/api/ask-threads?pointId=${item.knowledgePointId}`)).body.threads;
    expect(threads[0].asks).toHaveLength(1);
  });

  it('从会话的提问中整理出不了解的知识（去掉已有的），点选加入认知地图，缺的基础挂成前置', async () => {
    const { call, worker, thread, ask } = await inSession();
    await ask('怎么判断一个值是不是字符串？');
    const { anchor, suggestions } = (await call('POST', `/api/ask-threads/${thread.id}/suggest`)).body;
    expect(anchor.title).toBe('联合类型');
    expect(suggestions.map((s: any) => s.title)).toEqual(['类型守卫']);

    const res = await call('POST', '/api/asks/accept', { anchorPointId: anchor.id, points: [suggestions[0]] });
    expect(res.body).toMatchObject({ added: 1, skipped: 0 });
    await worker.runUntilIdle();
    const map = (await call('GET', '/api/map')).body;
    const added = map.points.find((p: any) => p.title === '类型守卫');
    expect(added).toMatchObject({ stage: 'unlearned', origin: 'asked', mastery: 0 });
    expect(map.points.find((p: any) => p.title === '联合类型').prerequisiteIds).toContain(added.id);
  });

  it('同名知识点不会重复加入；没有提问的会话不能整理', async () => {
    const { call, thread, item } = await inSession();
    expect((await call('POST', `/api/ask-threads/${thread.id}/suggest`)).status).toBe(400);
    const res = await call('POST', '/api/asks/accept', {
      anchorPointId: item.knowledgePointId,
      points: [{ title: '联合类型', summary: '已有', kind: 'extension' }],
    });
    expect(res.body).toMatchObject({ added: 0, skipped: 1 });
  });

  it('问题不能为空；会话不存在、这一项不属于本节时 404；不指定位置不能列会话', async () => {
    const { call, thread, ask } = await inSession();
    expect((await ask('  ')).status).toBe(400);
    expect((await call('POST', '/api/asks', { threadId: 'nope', question: '问' })).status).toBe(404);
    expect((await call('POST', '/api/asks', { threadId: thread.id, itemId: 'nope', question: '问' })).status).toBe(404);
    expect((await call('GET', '/api/ask-threads')).status).toBe(400);
  });
});
