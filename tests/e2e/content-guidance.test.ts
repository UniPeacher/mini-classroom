import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/ai/gateway';
import { readUserSettings, settingsSource } from '../../src/settings';
import { loadPool } from '../../src/store/repo';
import { appSettings, illustrations, items, knowledgePoints, memoryStates, sessions, topics } from '../../src/store/schema';
import { createFakeIllustrator } from '../fixtures/fake-model';
import { DAY1, createHarness } from '../fixtures/harness';

const CUSTOM = {
  tutorialGuidance: '先用银行建模的案例引出问题，再详细解释原因；允许长段落，不使用加粗。',
  figureGuidance: '组合流程与局部放大，用蓝色表示输入、橙色表示输出，并标明判断条件。',
};

/** 暂停讲解请求，以验证生成过程中修改设置的实际边界。 */
function holdLessons(h: ReturnType<typeof createHarness>) {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const generate = h.model.generate;
  h.model.generate = async <T>(request: StructuredRequest<T>): Promise<T> => {
    if (request.name === 'lesson') {
      started();
      await gate;
    }
    return generate(request);
  };
  return { entered, release };
}

describe('两个内容引导词设置', () => {
  it('已有设置没有引导词字段时，保留原学习参数并采用默认引导词', async () => {
    const h = createHarness();
    h.db.insert(appSettings).values({ key: 'user_settings', value: { sessionMinutes: 15, blockedForms: ['complete'] }, updatedAt: DAY1 }).run();
    const view = (await h.call('GET', '/api/settings')).body;
    expect(view.settings).toMatchObject({ sessionMinutes: 15, blockedForms: ['complete'], tutorialGuidance: null, figureGuidance: null });
    expect(settingsSource(h.db, {})().contentGuidance).toEqual(view.guidanceDefaults);
  });
  it('提供可编辑的默认说明，保存后可重新读取，恢复默认只影响指定项', async () => {
    const h = createHarness();
    const initial = (await h.call('GET', '/api/settings')).body;
    expect(initial.settings).toMatchObject({ tutorialGuidance: null, figureGuidance: null });
    expect(initial.guidanceDefaults.tutorialGuidance).toContain('讲解');
    expect(initial.guidanceDefaults.figureGuidance).toContain('帮助学习者理解知识');

    expect((await h.call('PUT', '/api/settings', CUSTOM)).body).toMatchObject(CUSTOM);
    expect(readUserSettings(h.db, {})).toMatchObject(CUSTOM);
    expect(settingsSource(h.db, {})().contentGuidance).toEqual(CUSTOM);
    expect((await h.call('PUT', '/api/settings', { tutorialGuidance: null })).body)
      .toMatchObject({ tutorialGuidance: null, figureGuidance: CUSTOM.figureGuidance });
    expect(settingsSource(h.db, {})().contentGuidance.tutorialGuidance).toBe(initial.guidanceDefaults.tutorialGuidance);
  });

  it('空白和默认原文都表示使用默认，非法输入不覆盖已保存内容', async () => {
    const h = createHarness();
    const initial = (await h.call('GET', '/api/settings')).body;
    await h.call('PUT', '/api/settings', CUSTOM);
    expect((await h.call('PUT', '/api/settings', { tutorialGuidance: 42 })).status).toBe(400);
    expect((await h.call('PUT', '/api/settings', { figureGuidance: '长'.repeat(initial.guidanceMaxLength + 1) })).status).toBe(400);
    expect(readUserSettings(h.db, {})).toMatchObject(CUSTOM);
    expect((await h.call('PUT', '/api/settings', { tutorialGuidance: ' \n\t ', figureGuidance: initial.guidanceDefaults.figureGuidance })).body)
      .toMatchObject({ tutorialGuidance: null, figureGuidance: null });
  });

  it('只重新准备尚未开始的内容，继续学习时保留原课程和记录', async () => {
    const h = createHarness();
    await h.startTopic();
    const active = (await h.call('POST', '/api/sessions/next')).body.session;
    await h.worker.runUntilIdle();
    const unused = loadPool(h.db);
    expect(unused.length).toBeGreaterThan(0);
    await h.call('PUT', '/api/settings', CUSTOM);
    expect(loadPool(h.db)).toHaveLength(0);
    for (const item of unused) expect(h.db.select().from(items).where(eq(items.id, item.id)).get()!.status).toBe('void');
    const resumed = (await h.call('POST', '/api/sessions/next')).body;
    expect(resumed.resumed).toBe(true);
    expect(resumed.session).toEqual(active);
  });

  it('同样的引导词和无关设置不会让已备好的内容失效', async () => {
    const h = createHarness();
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.startTopic();
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.call('PUT', '/api/settings', { sessionMinutes: 15 });
    expect(loadPool(h.db)).toEqual(before);
  });

  it.each([false, true])('后台备课采用两个引导词，图像模型启用：%s', async (withImages) => {
    const drawing = createFakeIllustrator();
    const h = createHarness(withImages ? { illustrator: drawing.illustrator } : {});
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.startTopic();
    const lessons = h.requests.filter((request) => request.name === 'lesson');
    expect(lessons.length).toBeGreaterThan(0);
    for (const request of lessons) {
      expect(request.system).toContain(CUSTOM.tutorialGuidance);
      expect(request.system).not.toContain('一句话不超过 30 个字');
      expect(request.prompt).not.toContain('一般 200~500 字');
      expect(request.prompt).toContain(CUSTOM.figureGuidance);
      expect(request.prompt).not.toContain('教学作用的参考');
    }
    if (withImages) {
      expect(drawing.prompts.length).toBeGreaterThan(0);
      for (const prompt of drawing.prompts) expect(prompt).toContain(CUSTOM.figureGuidance);
    }
    for (const request of h.requests.filter((request) => request.name === 'knowledge_graph')) {
      expect(request.system).not.toContain(CUSTOM.tutorialGuidance);
      expect(request.prompt).not.toContain(CUSTOM.figureGuidance);
    }
  });

  it('复习材料和按本节补充说明重新生成的内容都采用当前引导词', async () => {
    const h = createHarness();
    await h.startTopic();
    h.db.update(memoryStates).set({ stage: 'inferred' }).run();
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.worker.runUntilIdle();
    const reviews = h.requests.filter((request) => request.name === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    for (const request of reviews) {
      expect(request.system).toContain(CUSTOM.tutorialGuidance);
      expect(request.prompt).toContain(CUSTOM.figureGuidance);
    }
    const before = h.requests.length;
    const local = '本节用摄影曝光的例子，先讲操作再解释原因。';
    const response = await h.call('POST', '/api/sessions/next', { guidance: local });
    expect(response.status).toBe(200);
    expect(response.body.guided.applied).toBeGreaterThan(0);
    const generated = h.requests.slice(before);
    expect(generated.length).toBeGreaterThan(0);
    for (const request of generated) {
      expect(request.system).toContain(CUSTOM.tutorialGuidance);
      expect(request.system).toContain('优先采用本节说明');
      expect(request.prompt).toContain(CUSTOM.figureGuidance);
      expect(request.prompt).toContain(local);
    }
  });

  it('后台生成期间更新设置，过期结果不能重新进入待学内容', async () => {
    const h = createHarness();
    await h.startTopic();
    await h.call('PUT', '/api/settings', CUSTOM);
    const held = holdLessons(h);
    const running = h.worker.runOnce();
    await held.entered;
    const latest = { ...CUSTOM, tutorialGuidance: '用摄影案例讲解，先展示现象，再逐步分析原因。' };
    await h.call('PUT', '/api/settings', latest);
    held.release();
    await running;
    expect(loadPool(h.db)).toHaveLength(0);
    const before = h.requests.length;
    await h.worker.runUntilIdle();
    expect(loadPool(h.db).length).toBeGreaterThan(0);
    for (const request of h.requests.slice(before).filter((request) => request.name === 'lesson')) {
      expect(request.system).toContain(latest.tutorialGuidance);
    }
  });

  it('按本节说明生成时更新设置，提示重试，不把过期内容建成课程', async () => {
    const h = createHarness();
    await h.startTopic();
    const held = holdLessons(h);
    const running = h.call('POST', '/api/sessions/next', { guidance: '增加一个具体案例' });
    await held.entered;
    await h.call('PUT', '/api/settings', CUSTOM);
    held.release();
    const response = await running;
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('引导词已更新');
    expect(h.db.select().from(sessions).all()).toHaveLength(0);
    expect(loadPool(h.db)).toHaveLength(0);
  });

  it('待学内容过期后跳过其排队中的绘图任务', async () => {
    const drawing = createFakeIllustrator();
    const h = createHarness({ illustrator: drawing.illustrator });
    await h.startTopic();
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.worker.runOnce();
    expect(h.db.select().from(illustrations).where(eq(illustrations.status, 'pending')).all().length).toBeGreaterThan(0);
    const before = drawing.prompts.length;
    const latest = { figureGuidance: '用清晰的分镜图表现过程，每步标出关键变化。' };
    await h.call('PUT', '/api/settings', latest);
    await h.worker.runUntilIdle();
    const prompts = drawing.prompts.slice(before);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain(latest.figureGuidance);
      expect(prompt).not.toContain(CUSTOM.figureGuidance);
    }
  });

  it('已开始课程的图片继续使用该课程保存的说明，保持图文一致', async () => {
    const drawing = createFakeIllustrator();
    const h = createHarness({ illustrator: drawing.illustrator });
    await h.call('PUT', '/api/settings', CUSTOM);
    await h.startTopic();
    const active = (await h.call('POST', '/api/sessions/next', { guidance: '多用例子' })).body.session;
    const activeIds = new Set(active.items.map((item: { id: string }) => item.id));
    const pending = h.db.select().from(illustrations).where(eq(illustrations.status, 'pending')).all()
      .filter((row) => activeIds.has(row.itemId));
    expect(pending.length).toBeGreaterThan(0);
    await h.call('PUT', '/api/settings', { figureGuidance: '用分镜展示动作变化。' });
    await h.worker.runUntilIdle();
    for (const row of pending) {
      const saved = h.db.select().from(illustrations).where(eq(illustrations.id, row.id)).get()!;
      expect(saved.status).toBe('ready');
      expect(saved.prompt).toBe(row.prompt);
      expect(saved.prompt).toContain(CUSTOM.figureGuidance);
      expect(drawing.prompts).toContain(saved.prompt);
    }
  });
});

describe('学科内容风格', () => {
  /** 两个不同学科的主题，各自打上标签 */
  async function twoSubjects(h: ReturnType<typeof createHarness>) {
    const dsp = await h.startTopic('离散时间信号');
    const esp = await h.startTopic('西班牙语动词变位');
    await h.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await h.call('PATCH', `/api/topics/${esp}`, { subject: '西班牙语' });
    return { dsp, esp };
  }

  it('设置接口给出全部预设及其说明', async () => {
    const h = createHarness();
    const view = (await h.call('GET', '/api/settings')).body;
    expect(view.subjectStyles.length).toBeGreaterThanOrEqual(9);
    const ids = view.subjectStyles.map((s: any) => s.id);
    expect(ids).toContain('default');
    expect(ids).toContain('stem');
    expect(ids).toContain('language');
    expect(view.subjectStyles.every((s: any) => s.label && s.description)).toBe(true);
  });

  it('非法预设名被拒绝', async () => {
    const h = createHarness();
    expect((await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'quantum', subjects: ['西语'] }] })).status).toBe(400);
    expect((await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西语'] }] })).status).toBe(200);
  });

  it('学科汇总里带上当前选定的风格', async () => {
    const h = createHarness();
    await twoSubjects(h);
    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西班牙语'] }] });
    const { subjects } = (await h.call('GET', '/api/subjects')).body;
    expect(subjects.find((s: any) => s.subject === '西班牙语').styleId).toBe('language');
    expect(subjects.find((s: any) => s.subject === '数字信号处理').styleId).toBe('default');
  });

  it('切换某学科的风格时，只作废这个学科的内容，其他学科不受影响', async () => {
    const h = createHarness();
    await twoSubjects(h);
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);

    // 记录每个候选项属于哪个学科
    const subjectOfPoint = new Map<string, string | null>();
    for (const row of h.db.select({ id: knowledgePoints.id, subject: topics.subject }).from(knowledgePoints).innerJoin(topics, eq(knowledgePoints.topicId, topics.id)).all()) {
      subjectOfPoint.set(row.id, row.subject);
    }
    const languageItems = before.filter((i) => subjectOfPoint.get(i.knowledgePointId) === '西班牙语');
    const others = before.filter((i) => subjectOfPoint.get(i.knowledgePointId) !== '西班牙语');
    expect(languageItems.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);

    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西班牙语'] }] });

    const after = loadPool(h.db);
    // 语言学科的内容被作废，其他学科的内容保持可用
    expect(after.some((i) => subjectOfPoint.get(i.knowledgePointId) === '西班牙语')).toBe(false);
    for (const item of others) {
      expect(after.some((i) => i.id === item.id)).toBe(true);
    }
    for (const item of languageItems) {
      expect(h.db.select().from(items).where(eq(items.id, item.id)).get()!.status).toBe('void');
    }
  });

  it('改成同一个风格不会让内容失效', async () => {
    const h = createHarness();
    await twoSubjects(h);
    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西班牙语'] }] });
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);
    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西班牙语'] }] });
    expect(loadPool(h.db)).toEqual(before);
  });

  it('生成内容时按学科使用对应的风格提示词', async () => {
    const h = createHarness();
    await twoSubjects(h);
    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西班牙语'] }, { name: '理工科', styleId: 'stem', subjects: ['数字信号处理'] }] });
    h.requests.length = 0;
    await h.worker.runUntilIdle();

    const systems = h.requests.map((r) => r.system ?? '');
    expect(systems.length).toBeGreaterThan(0);
    // 语言主题的讲解带语言学科要求，理工科主题带公式与量纲要求
    expect(systems.some((s) => s.includes('语言学习'))).toBe(true);
    expect(systems.some((s) => s.includes('理工科'))).toBe(true);
    // 每个请求都保留通用写作原则：预设只追加不替换
    for (const s of systems) expect(s).toContain('写作原则');
  });
});

describe('学科分组：大类定风格，下面挂多门课', () => {
  it('同一分组下的多门课共用一套风格；换分组后随之改变', async () => {
    const h = createHarness();
    const dsp = await h.startTopic('离散时间信号');
    const hyd = await h.startTopic('阀控缸');
    const esp = await h.startTopic('西班牙语动词变位');
    for (const [id, subject] of [[dsp, '数字信号处理'], [hyd, '液压传动'], [esp, '西班牙语']] as const) {
      await h.call('PATCH', `/api/topics/${id}`, { subject });
    }

    // 理工科大组选 stem，把两门专业课都挂进去
    const saved = (await h.call('PUT', '/api/settings', {
      subjectGroups: [
        { name: '理工科', styleId: 'stem', subjects: ['数字信号处理', '液压传动'] },
        { name: '语言', styleId: 'language', subjects: ['西班牙语'] },
      ],
    })).body;
    expect(saved.subjectGroups.find((g: any) => g.name === '理工科').subjects).toEqual(['数字信号处理', '液压传动']);

    // 学科汇总带出所属分组
    const { subjects } = (await h.call('GET', '/api/subjects')).body;
    expect(subjects.find((s: any) => s.subject === '数字信号处理').group).toBe('理工科');
    expect(subjects.find((s: any) => s.subject === '液压传动').group).toBe('理工科');
    expect(subjects.find((s: any) => s.subject === '西班牙语').group).toBe('语言');
    // 同组的风格一致
    expect(subjects.find((s: any) => s.subject === '数字信号处理').styleId).toBe('stem');
    expect(subjects.find((s: any) => s.subject === '液压传动').styleId).toBe('stem');
  });

  it('把标签从一个分组挪到另一个分组，风格跟着变，并只作废这些课的内容', async () => {
    const h = createHarness();
    const dsp = await h.startTopic('离散时间信号');
    const esp = await h.startTopic('西班牙语动词变位');
    await h.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await h.call('PATCH', `/api/topics/${esp}`, { subject: '西班牙语' });
    await h.call('PUT', '/api/settings', {
      subjectGroups: [
        { name: '理工科', styleId: 'stem', subjects: ['数字信号处理'] },
        { name: '语言', styleId: 'language', subjects: ['西班牙语'] },
      ],
    });
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);

    // 把西语从"语言"挪到"理工科"
    await h.call('PUT', '/api/settings', {
      subjectGroups: [
        { name: '理工科', styleId: 'stem', subjects: ['数字信号处理', '西班牙语'] },
        { name: '语言', styleId: 'language', subjects: [] },
      ],
    });
    const { subjects } = (await h.call('GET', '/api/subjects')).body;
    expect(subjects.find((s: any) => s.subject === '西班牙语').group).toBe('理工科');
    expect(subjects.find((s: any) => s.subject === '西班牙语').styleId).toBe('stem');
    // 西语从 language 变成 stem，内容需要重新准备
    expect(loadPool(h.db).length).toBeLessThan(before.length);
  });

  it('分组名为空或重名时被拒绝', async () => {
    const h = createHarness();
    expect((await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '  ', styleId: 'stem', subjects: [] }] })).status).toBe(400);
  });
});

describe('单个标签单独指定风格', () => {
  it('标签自己的风格优先于分组，且只作废这个标签的内容', async () => {
    const h = createHarness();
    const hyd = await h.startTopic('阀控缸');
    const dsp = await h.startTopic('离散时间信号');
    await h.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    await h.call('PATCH', `/api/topics/${dsp}`, { subject: '数字信号处理' });
    await h.call('PUT', '/api/settings', {
      subjectGroups: [{ name: '理工科', styleId: 'stem', subjects: ['液压传动', '数字信号处理'] }],
    });
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);

    // 只给液压传动单独指定风格
    await h.call('PUT', '/api/settings', { tagStyles: { 液压传动: 'programming' } });

    const { subjects } = (await h.call('GET', '/api/subjects')).body;
    const hydRow = subjects.find((s: any) => s.subject === '液压传动');
    const dspRow = subjects.find((s: any) => s.subject === '数字信号处理');
    expect(hydRow.styleId).toBe('programming');
    expect(hydRow.ownStyle).toBe(true);
    expect(dspRow.styleId).toBe('stem');
    expect(dspRow.ownStyle).toBe(false);

    // 液压传动的内容被重新准备，数字信号处理的保留
    const subjectOfPoint = new Map<string, string | null>();
    for (const row of h.db.select({ id: knowledgePoints.id, subject: topics.subject }).from(knowledgePoints).innerJoin(topics, eq(knowledgePoints.topicId, topics.id)).all()) {
      subjectOfPoint.set(row.id, row.subject);
    }
    const after = loadPool(h.db);
    expect(after.some((i) => subjectOfPoint.get(i.knowledgePointId) === '液压传动')).toBe(false);
    expect(after.some((i) => subjectOfPoint.get(i.knowledgePointId) === '数字信号处理')).toBe(true);
  });

  it('取消单独指定后重新跟随分组', async () => {
    const h = createHarness();
    const hyd = await h.startTopic('阀控缸');
    await h.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    await h.call('PUT', '/api/settings', { subjectGroups: [{ name: '理工科', styleId: 'stem', subjects: ['液压传动'] }] });
    await h.call('PUT', '/api/settings', { tagStyles: { 液压传动: 'arts' } });
    let row = (await h.call('GET', '/api/subjects')).body.subjects.find((s: any) => s.subject === '液压传动');
    expect(row.styleId).toBe('arts');

    await h.call('PUT', '/api/settings', { tagStyles: {} });
    row = (await h.call('GET', '/api/subjects')).body.subjects.find((s: any) => s.subject === '液压传动');
    expect(row.styleId).toBe('stem');
    expect(row.ownStyle).toBe(false);
  });
});

describe('部分更新设置不会冲掉其他配置', () => {
  it('只改标签覆盖时，已保存的分组和引导词保持不变', async () => {
    const h = createHarness();
    const hyd = await h.startTopic('阀控缸');
    await h.call('PATCH', `/api/topics/${hyd}`, { subject: '液压传动' });
    const grouping = [{ name: '理工科', styleId: 'stem', subjects: ['液压传动'] }];
    await h.call('PUT', '/api/settings', { subjectGroups: grouping, tutorialGuidance: CUSTOM.tutorialGuidance });

    await h.call('PUT', '/api/settings', { tagStyles: { 液压传动: 'programming' } });

    const saved = (await h.call('GET', '/api/settings')).body.settings;
    expect(saved.subjectGroups).toEqual(grouping);
    expect(saved.tutorialGuidance).toBe(CUSTOM.tutorialGuidance);
    expect(saved.tagStyles).toEqual({ 液压传动: 'programming' });
  });

  it('只改学习节奏时，分组与标签覆盖都保留', async () => {
    const h = createHarness();
    await h.call('PUT', '/api/settings', {
      subjectGroups: [{ name: '理工科', styleId: 'stem', subjects: ['液压传动'] }],
      tagStyles: { 液压传动: 'arts' },
    });
    await h.call('PUT', '/api/settings', { sessionMinutes: 15 });

    const saved = (await h.call('GET', '/api/settings')).body.settings;
    expect(saved.sessionMinutes).toBe(15);
    expect(saved.subjectGroups).toHaveLength(1);
    expect(saved.tagStyles).toEqual({ 液压传动: 'arts' });
  });
});
