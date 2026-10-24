import { describe, expect, it } from 'vitest';
import { createServices } from '../../src/server/services';
import { settingsSource } from '../../src/settings';
import { jobs } from '../../src/store/schema';
import { createFakeModel } from '../fixtures/fake-model';
import { createHarness } from '../fixtures/harness';

const IDEA = '想学 Python';
const GOAL = '用 Python 独立整理销售报表';
const CORRECTION = '不做报表，我想采集公开网页数据';

/** 用户先明确学习目的，明确确认后才加入计划；纠正、重试和刷新不能破坏这个边界。 */
describe('通过对话添加学习主题', () => {
  async function begin(options: Parameters<typeof createHarness>[0] = {}) {
    const harness = createHarness(options);
    const created = await harness.call('POST', '/api/topic-drafts', { idea: IDEA });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const read = async () => (await harness.call('GET', `/api/topic-drafts/${id}`)).body;
    const reply = async () => harness.call('POST', `/api/topic-drafts/${id}/reply`, { revision: (await read()).revision });
    const send = async (message: string) => harness.call('POST', `/api/topic-drafts/${id}/messages`, { message, revision: (await read()).revision });
    const confirm = async () => harness.call('POST', `/api/topic-drafts/${id}/confirm`, { revision: (await read()).revision });
    return { ...harness, id, created, read, reply, send, confirm };
  }

  it('输入只保存为待讨论的想法，不建主题、不排队生成图谱', async () => {
    const h = await begin();
    expect(h.created.body.messages).toEqual([{ role: 'user', content: IDEA }]);
    expect(h.created.body.brief).toBeNull();
    expect((await h.call('GET', '/api/topics')).body.topics).toEqual([]);
    expect(h.db.select().from(jobs).all()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect((await h.call('GET', '/api/topic-drafts')).body.drafts).toEqual([expect.objectContaining({ id: h.id, idea: IDEA })]);
    expect((await h.confirm()).status).toBe(409);
  });

  it('携带完整多轮上下文，纠正后旧摘要不能确认，只有最新目标能进入计划', async () => {
    const h = await begin();
    expect((await h.reply()).body.brief).toBeNull();
    expect((await h.confirm()).status).toBe(409);
    await h.send('希望用 Python 独立整理销售报表，会 Excel，没有编程基础');
    const draft = (await h.reply()).body;
    expect(draft.brief.goal).toBe(GOAL);
    expect(h.prompts.at(-1)).toContain(IDEA);
    expect(h.prompts.at(-1)).toContain('你希望用它解决什么具体问题');
    expect((await h.call('GET', '/api/topics')).body.topics).toEqual([]);

    const corrected = (await h.send(CORRECTION)).body;
    expect(corrected.brief).toBeNull();
    expect((await h.call('POST', `/api/topic-drafts/${h.id}/confirm`, { revision: draft.revision })).status).toBe(409);
    expect((await h.confirm()).status).toBe(409);
    const revised = (await h.reply()).body;
    expect(revised.brief.goal).toContain('公开网页');
    expect(h.prompts.at(-1)).toContain(CORRECTION);

    const confirmed = await h.confirm();
    expect(confirmed.status).toBe(200);
    expect(h.calls.filter(name => name === 'topic_title')).toHaveLength(1);
    const topics = (await h.call('GET', '/api/topics')).body.topics;
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ id: confirmed.body.topicId, title: 'Python 公开网页数据采集', learningBrief: revised.brief });
    expect((await h.read()).topicId).toBe(topics[0].id);
    expect((await h.call('GET', `/api/topics/${topics[0].id}/placement`)).body.background).toBe(revised.brief.background);
    expect((await h.call('GET', `/api/topics/${topics[0].id}/placement`)).body.preparationFailed).toBe(false);
    expect((await h.call('GET', '/api/topic-drafts')).body.drafts).toEqual([]);

    await h.worker.runUntilIdle();
    const graphPrompt = h.prompts[h.calls.indexOf('knowledge_graph')]!;
    expect(graphPrompt).toContain(revised.brief.goal);
    expect(graphPrompt).toContain(revised.brief.scope[0]);
    expect(graphPrompt).not.toContain(GOAL);
    await h.call('POST', `/api/topics/${topics[0].id}/placement/skip`);
    await h.worker.runUntilIdle();
    expect(h.prompts[h.calls.indexOf('lesson')]).toContain(revised.brief.goal);
    expect((await h.call('GET', '/api/sessions/preview')).body.items.length).toBeGreaterThan(0);
  });

  it('刷新或重新创建服务后，已发送的消息、待回复状态和摘要仍然存在', async () => {
    const h = await begin();
    await h.reply();
    await h.send('希望用 Python 独立整理销售报表，会 Excel，没有编程基础');
    const restored = createServices({ db: h.db, model: createFakeModel().model, settings: settingsSource(h.db, {}) });
    expect(restored.topicPlanning.get(h.id).messages.at(-1)?.role).toBe('user');
    await h.reply();
    expect(restored.topicPlanning.get(h.id).brief?.goal).toBe(GOAL);
  });

  it('模型回复失败时保留用户输入，可重试且不重复添加消息', async () => {
    const h = await begin({ networkFailures: { topic_clarification: 1 } });
    expect((await h.reply()).status).toBe(502);
    expect((await h.read()).messages).toEqual([{ role: 'user', content: IDEA }]);
    const retry = await h.reply();
    expect(retry.status).toBe(200);
    expect(retry.body.messages).toHaveLength(2);
    expect(retry.body.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('生成名称失败不加入计划，重试最终确认可以成功', async () => {
    const h = await begin({ networkFailures: { topic_title: 1 } });
    await h.reply();
    await h.send('希望用 Python 独立整理销售报表，会 Excel，没有编程基础');
    await h.reply();
    expect((await h.confirm()).status).toBe(502);
    expect((await h.call('GET', '/api/topics')).body.topics).toEqual([]);
    expect((await h.read()).brief.goal).toBe(GOAL);
    expect((await h.confirm()).status).toBe(200);
  });

  it('并发回复和确认只执行一次，确认重试返回同一主题', async () => {
    const h = await begin({ delayMs: 10 });
    const replies = await Promise.all([h.reply(), h.reply()]);
    expect(replies.map(r => r.status)).toEqual([200, 200]);
    expect(h.calls.filter(name => name === 'topic_clarification')).toHaveLength(1);
    await h.send('希望用 Python 独立整理销售报表，会 Excel，没有编程基础');
    await h.reply();
    const results = await Promise.all([h.confirm(), h.confirm()]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results[0]!.body.topicId).toBe(results[1]!.body.topicId);
    expect((await h.confirm()).body.topicId).toBe(results[0]!.body.topicId);
    expect(h.calls.filter(name => name === 'topic_title')).toHaveLength(1);
    expect((await h.call('GET', '/api/topics')).body.topics).toHaveLength(1);
    expect(h.db.select().from(jobs).all()).toHaveLength(1);
    expect((await h.send('确认后再改')).status).toBe(409);
  });

  it('旧页面发送的消息不能覆盖新一轮讨论', async () => {
    const h = await begin();
    await h.reply();
    const revision = (await h.read()).revision;
    await h.send('希望用 Python 独立整理销售报表');
    expect((await h.call('POST', `/api/topic-drafts/${h.id}/messages`, { revision, message: '旧页面的输入' })).status).toBe(409);
    expect((await h.read()).messages.at(-1).content).toBe('希望用 Python 独立整理销售报表');
  });

  it('生成名称期间发生新纠正时，旧确认不能把过期目标加入计划', async () => {
    const h = await begin({ delayMs: 10 });
    await h.reply();
    await h.send('希望用 Python 独立整理销售报表，会 Excel，没有编程基础');
    await h.reply();
    const draft = await h.read();
    const confirmation = h.services.topicPlanning.confirm(h.id, draft.revision, new Date());
    h.services.topicPlanning.addMessage(h.id, CORRECTION, draft.revision, new Date());
    await expect(confirmation).rejects.toMatchObject({ status: 409 });
    expect((await h.call('GET', '/api/topics')).body.topics).toEqual([]);
    expect((await h.read()).brief).toBeNull();
  });

  it('拒绝空输入、超长输入、不存在的讨论和缺失的确认版本', async () => {
    const h = await begin();
    for (const idea of ['', '  ', '长'.repeat(2001)]) expect((await h.call('POST', '/api/topic-drafts', { idea })).status).toBe(400);
    expect((await h.send('  ')).status).toBe(400);
    expect((await h.send('长'.repeat(2001))).status).toBe(400);
    expect((await h.call('GET', '/api/topic-drafts/missing')).status).toBe(404);
    expect((await h.call('POST', `/api/topic-drafts/${h.id}/confirm`, {})).status).toBe(400);
  });
});
