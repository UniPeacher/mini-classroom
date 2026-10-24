import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/ai/gateway';
import { readUserSettings, settingsSource } from '../../src/settings';
import { loadPool } from '../../src/store/repo';
import { appSettings, illustrations, items, memoryStates, sessions } from '../../src/store/schema';
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
