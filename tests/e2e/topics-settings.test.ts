import { describe, expect, it } from 'vitest';
import { DECOMPOSE_FAIL_STREAK } from '../../src/domain/memory';
import { enqueue } from '../../src/jobs/queue';
import { CORRECT_MARK, MCQ } from '../fixtures/fake-model';
import { DAY, DAY1, createHarness } from '../fixtures/harness';

type Harness = ReturnType<typeof createHarness>;

/** 开一节、全部答完（答对的自评良好）并结束；返回这一节和结束时的回访题 */
async function runSession(harness: Harness, now: Date, answerRight = true) {
  const { call, worker } = harness;
  const session = (await call('POST', '/api/sessions/next', {}, now)).body.session;
  for (const item of session.items) {
    const answer = item.question?.type === 'mcq' || item.question?.type === 'pick_line'
      ? { choice: answerRight ? MCQ.answerIndex : 0 }
      : { text: answerRight ? `${CORRECT_MARK} 答案` : '不记得了' };
    const res = await call('POST', '/api/attempts', { sessionId: session.id, itemId: item.id, answer }, now);
    if (res.body.needsRating) await call('POST', `/api/attempts/${res.body.attemptId}/rating`, { selfRating: 'good' }, now);
  }
  const finish = (await call('POST', `/api/sessions/${session.id}/finish`, undefined, now)).body;
  await worker.runUntilIdle();
  return { session, revisit: finish.revisit };
}

const topicsOfNew = (session: any) => [...new Set(session.items.filter((i: any) => i.purpose === 'new').map((i: any) => i.topicTitle))];

describe('多个学习主题', () => {
  it('每节的新知识点只来自一个主题，主题之间轮换', async () => {
    const harness = createHarness();
    await harness.startTopic('主题甲', { now: new Date(DAY1.getTime() - 60_000) });
    await harness.startTopic('主题乙');
    const first = await runSession(harness, DAY1);
    const second = await runSession(harness, DAY1);
    expect(topicsOfNew(first.session)).toEqual(['主题甲']);
    expect(topicsOfNew(second.session)).toEqual(['主题乙']);
  });

  it('暂停的主题不再新学', async () => {
    const harness = createHarness();
    await harness.startTopic('主题甲');
    const paused = await harness.startTopic('主题乙');
    await harness.call('PATCH', `/api/topics/${paused}`, { status: 'paused' });
    const first = await runSession(harness, DAY1);
    const second = await runSession(harness, DAY1);
    expect(topicsOfNew(first.session)).toEqual(['主题甲']);
    expect(topicsOfNew(second.session)).toEqual(['主题甲']);
  });

  it('暂停的主题复习照常进行', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic('主题甲');
    await runSession(harness, DAY1);
    await harness.call('PATCH', `/api/topics/${topic}`, { status: 'paused' });
    // 一个月后：按那时的时间补好复习题，再开一节
    const later = new Date(DAY1.getTime() + 30 * DAY);
    enqueue(harness.db, 'fill_pool', { now: later.toISOString() }, later);
    await harness.worker.runUntilIdle();
    const open = (await harness.call('POST', '/api/sessions/next', {}, later)).body.session;
    expect(open.items.some((i: any) => i.purpose === 'review')).toBe(true);
    expect(topicsOfNew(open)).toEqual([]);
  });

  it('优先级只能是 1~3；主题不存在时 404', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic('主题甲');
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { priority: 3 })).body.priority).toBe(3);
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { priority: 4 })).status).toBe(400);
    expect((await harness.call('PATCH', '/api/topics/nope', { priority: 2 })).status).toBe(404);
  });
});

describe('主题回访', () => {
  it('有暂停的主题时，在一节结束时问要不要恢复；选中的恢复新学，两周内不再问', async () => {
    const harness = createHarness();
    await harness.startTopic('主题甲');
    const paused = await harness.startTopic('主题乙');
    await harness.call('PATCH', `/api/topics/${paused}`, { status: 'paused' });

    const { revisit } = await runSession(harness, DAY1);
    expect(revisit).toEqual({ topics: [{ id: paused, title: '主题乙' }] });
    await harness.call('POST', '/api/revisit', { resumeTopicIds: [paused] });
    const topics = (await harness.call('GET', '/api/topics')).body.topics;
    expect(topics.find((t: any) => t.id === paused).status).toBe('active');

    await harness.call('PATCH', `/api/topics/${paused}`, { status: 'paused' });
    expect((await runSession(harness, new Date(DAY1.getTime() + 13 * DAY))).revisit).toBeNull();
    expect((await runSession(harness, new Date(DAY1.getTime() + 14 * DAY))).revisit).not.toBeNull();
  });

  it('选"暂时都不"也记下回访时间', async () => {
    const harness = createHarness();
    await harness.startTopic('主题甲');
    const paused = await harness.startTopic('主题乙');
    await harness.call('PATCH', `/api/topics/${paused}`, { status: 'paused' });
    await runSession(harness, DAY1);
    await harness.call('POST', '/api/revisit', { resumeTopicIds: [] });
    expect((await runSession(harness, DAY1)).revisit).toBeNull();
  });
});

describe('拆解', () => {
  it(`理解阶段连续答错 ${DECOMPOSE_FAIL_STREAK} 次：拆出更基础的前置知识点挂入图谱，并先教它`, async () => {
    const harness = createHarness();
    await harness.startTopic();
    for (let i = 0; i < DECOMPOSE_FAIL_STREAK; i++) await runSession(harness, DAY1, false);

    const map = (await harness.call('GET', '/api/map')).body;
    const basic = map.points.find((p: any) => p.title === '更基础的知识点');
    expect(basic).toMatchObject({ decomposed: true, stage: 'unlearned', onEdge: true });
    const struggling = map.points.filter((p: any) => p.prerequisiteIds.includes(basic.id));
    expect(struggling.length).toBeGreaterThan(0);

    const next = (await harness.call('POST', '/api/sessions/next')).body.session;
    const titles = next.items.map((i: any) => i.title);
    expect(titles).toContain('更基础的知识点');
    // 拆解出的前置还没学会，原知识点先不重讲
    for (const p of struggling) expect(titles).not.toContain(p.title);
  });
});

describe('设置与今天的安排', () => {
  it('读取设置时带上形式目录，核心检验形式标为不可屏蔽', async () => {
    const { call } = createHarness();
    const { settings, forms } = (await call('GET', '/api/settings')).body;
    expect(settings).toMatchObject({ sessionMinutes: 10, maxNewPerSession: 2, dailySessionCap: null });
    expect(forms.question.find((f: any) => f.id === 'fix')).toMatchObject({ core: true, mobile: false });
  });

  it('核心检验形式不能屏蔽；非法值拒绝', async () => {
    const { call } = createHarness();
    expect((await call('PUT', '/api/settings', { blockedForms: ['fix'] })).status).toBe(400);
    expect((await call('PUT', '/api/settings', { reminderTimes: ['25:00'] })).status).toBe(400);
    expect((await call('PUT', '/api/settings', { blockedForms: ['complete'], sessionMinutes: 15 })).body).toMatchObject({
      blockedForms: ['complete'],
      sessionMinutes: 15,
    });
  });

  it('达到每日节数上限后不再开新的一节', async () => {
    const harness = createHarness();
    await harness.startTopic();
    await harness.call('PUT', '/api/settings', { dailySessionCap: 1 });
    await runSession(harness, DAY1);
    expect((await harness.call('POST', '/api/sessions/next', { timeZone: 'UTC' })).body).toMatchObject({ session: null, capped: true });
    // 第二天又可以学
    expect((await harness.call('POST', '/api/sessions/next', { timeZone: 'UTC' }, new Date(DAY1.getTime() + DAY))).body.session).not.toBeNull();
  });

  it('提醒时段：时段前 60 分钟起完成过一节就算学完', async () => {
    const harness = createHarness();
    await harness.startTopic();
    await harness.call('PUT', '/api/settings', { reminderTimes: ['20:00', '09:30'] });
    await runSession(harness, DAY1); // UTC 09:00 完成
    const today = (await harness.call('GET', '/api/today?timeZone=UTC')).body;
    expect(today).toMatchObject({ date: '2026-10-20', sessionsToday: 1, dailySessionCap: null });
    expect(today.slots).toEqual([
      { time: '09:30', done: true },
      { time: '20:00', done: false },
    ]);
  });

  it('设置的时长立即生效：一节的时间预算跟着变', async () => {
    const harness = createHarness();
    await harness.startTopic();
    await harness.call('PUT', '/api/settings', { sessionMinutes: 5 });
    expect((await harness.call('POST', '/api/sessions/next')).body.session.budgetSeconds).toBe(300);
  });
});

describe('速查表、导出与已有知识', () => {
  it('速查表默认只收录应用、保持阶段的知识点；范围里没有时说明原因', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic();
    await runSession(harness, DAY1);
    const res = await harness.call('POST', '/api/cheatsheets', { topicIds: [topic] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('应用');
  });

  it('选定范围生成速查表，完成后可查看，并能随导出一起写入 Markdown', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic();
    await runSession(harness, DAY1);
    const created = (await harness.call('POST', '/api/cheatsheets', { topicIds: [topic], stages: ['recall'] })).body;
    expect(created).toMatchObject({ title: 'TypeScript 常用技能 速查表', pointCount: 2 });
    await harness.worker.runUntilIdle();
    const sheet = (await harness.call('GET', `/api/cheatsheets/${created.id}`)).body;
    expect(sheet).toMatchObject({ status: 'ready', markdown: expect.stringContaining('# 速查表') });

    const exported = (await harness.call('POST', '/api/export', { topicIds: [topic], records: true, cheatsheetId: created.id })).body;
    expect(exported.filename).toMatch(/^微课堂-\d{4}-\d{2}-\d{2}\.md$/);
    expect(exported.markdown).toContain('## TypeScript 常用技能');
    expect(exported.markdown).toContain('### 联合类型');
    expect(exported.markdown).toContain('- 掌握阶段：回忆');
    expect(exported.markdown).toContain('#### 作答记录');
    expect(exported.markdown).toContain('# 速查表');
  });

  it('不带作答记录导出时只有知识点', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic();
    await runSession(harness, DAY1);
    const { markdown } = (await harness.call('POST', '/api/export', { topicIds: [topic], records: false })).body;
    expect(markdown).not.toContain('作答记录');
  });

  it('可以手动添加和删除已有知识', async () => {
    const { call } = createHarness();
    const added = (await call('POST', '/api/existing-knowledge', { text: '会用 Excel 做透视表' })).body;
    expect((await call('GET', '/api/map')).body.existingKnowledge.map((k: any) => k.text)).toEqual(['会用 Excel 做透视表']);
    await call('DELETE', `/api/existing-knowledge/${added.id}`);
    expect((await call('GET', '/api/map')).body.existingKnowledge).toEqual([]);
  });
});

describe('学科标签', () => {
  /** 预览某一节会学什么；不传学科时是原来的跨主题安排 */
  const preview = async (harness: Harness, subject?: string) => {
    const suffix = subject ? `?subject=${encodeURIComponent(subject)}` : '';
    return (await harness.call('GET', `/api/sessions/preview${suffix}`)).body;
  };

  it('可以给主题打标签、改标签，也能清空', async () => {
    const harness = createHarness();
    const topic = await harness.startTopic('离散时间信号');
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { subject: '数字信号处理' })).body.subject).toBe('数字信号处理');
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { subject: '信号与系统' })).body.subject).toBe('信号与系统');
    // 空字符串与 null 都表示清空，不会留下一个空标签
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { subject: '   ' })).body.subject).toBeNull();
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { subject: null })).body.subject).toBeNull();
    expect((await harness.call('PATCH', `/api/topics/${topic}`, { subject: 'x'.repeat(41) })).status).toBe(400);
  });

  it('汇总接口按学科给出主题数、可新学数和到期数', async () => {
    const harness = createHarness();
    const dsp = await harness.startTopic('离散时间信号');
    const hyd = await harness.startTopic('阀控缸');
    await harness.startTopic('未归类主题');
    await harness.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await harness.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    await harness.worker.runUntilIdle();

    const { subjects } = (await harness.call('GET', '/api/subjects')).body;
    expect(subjects.map((s: any) => s.subject)).toEqual(['数字信号处理', '液压传动']);
    const dspSummary = subjects.find((s: any) => s.subject === '数字信号处理');
    expect(dspSummary.topicCount).toBe(1);
    expect(dspSummary.edge).toBeGreaterThan(0);
    expect(dspSummary.due).toBe(0);
  });

  it('指定学科时，预览里的新知识点只来自该学科', async () => {
    const harness = createHarness();
    const dsp = await harness.startTopic('离散时间信号');
    const hyd = await harness.startTopic('阀控缸');
    await harness.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await harness.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    await harness.worker.runUntilIdle();

    const onlyDsp = await preview(harness, '数字信号处理');
    expect(onlyDsp.items.length).toBeGreaterThan(0);
    expect([...new Set(onlyDsp.items.map((i: any) => i.topicTitle))]).toEqual(['离散时间信号']);

    const onlyHyd = await preview(harness, '液压传动');
    expect([...new Set(onlyHyd.items.map((i: any) => i.topicTitle))]).toEqual(['阀控缸']);
  });

  it('按学科开始的一节，内容不跨到别的学科', async () => {
    const harness = createHarness();
    const dsp = await harness.startTopic('离散时间信号');
    const hyd = await harness.startTopic('阀控缸');
    await harness.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await harness.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    await harness.worker.runUntilIdle();

    const session = (await harness.call('POST', '/api/sessions/next', { subject: '数字信号处理' }, DAY1)).body.session;
    expect(session).not.toBeNull();
    expect([...new Set(session.items.map((i: any) => i.topicTitle))]).toEqual(['离散时间信号']);
  });

  it('学科里没有可学内容时不会用别的学科填空', async () => {
    const harness = createHarness();
    const dsp = await harness.startTopic('离散时间信号');
    await harness.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await harness.worker.runUntilIdle();

    const empty = await preview(harness, '不存在的学科');
    expect(empty.items).toEqual([]);
    const session = (await harness.call('POST', '/api/sessions/next', { subject: '不存在的学科' }, DAY1)).body.session;
    expect(session).toBeNull();
  });
});
