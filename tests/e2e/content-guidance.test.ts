import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/ai/gateway';
import { readUserSettings, settingsSource, UserSettingsPatchSchema } from '../../src/settings';
import { DEFAULT_CONTENT_GUIDANCE } from '../../src/shared/content-guidance';
import { loadPool } from '../../src/store/repo';
import { appSettings, illustrations, items, knowledgePoints, memoryStates, sessions, topics } from '../../src/store/schema';
import { teachingFingerprint } from '../../src/teaching';
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

/** 建一个学科（含预设）和一门课程，返回 id */
async function makeCourse(h: ReturnType<typeof createHarness>, discipline: string, presetId: string, name: string) {
  const d = (await h.call('POST', '/api/disciplines', { name: discipline, presetId })).body;
  const c = (await h.call('POST', '/api/courses', { name, disciplineId: d.id })).body;
  return { disciplineId: d.id as string, courseId: c.id as string };
}

/** 把主题归入课程（走明确的组织接口，不再用旧的标签设置） */
async function assign(h: ReturnType<typeof createHarness>, courseId: string, topicIds: string[]) {
  const res = await h.call('PUT', `/api/courses/${courseId}/topics`, { topicIds });
  expect(res.status).toBe(200);
  return res.body;
}

/** 知识点 → 所属课程 */
function courseOfPoint(h: ReturnType<typeof createHarness>) {
  const topicOf = new Map(h.db.select().from(knowledgePoints).all().map((p) => [p.id, p.topicId]));
  const courseOfTopic = new Map(h.db.select().from(topics).all().map((t) => [t.id, t.courseId]));
  return (pointId: string) => courseOfTopic.get(topicOf.get(pointId) ?? '') ?? null;
}

describe('两个内容引导词设置', () => {
  it('已有设置没有引导词字段时，保留原学习参数并采用默认引导词', async () => {
    const h = createHarness();
    h.db.insert(appSettings).values({ key: 'user_settings', value: { sessionMinutes: 15, blockedForms: ['complete'] }, updatedAt: DAY1 }).run();
    const view = (await h.call('GET', '/api/settings')).body;
    expect(view.settings).toMatchObject({ sessionMinutes: 15, blockedForms: ['complete'], tutorialGuidance: null, figureGuidance: null });
    expect(settingsSource(h.db, {})().contentGuidance).toEqual(DEFAULT_CONTENT_GUIDANCE);
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
    const resumed = (await h.call('POST', '/api/sessions/next', { resume: true })).body;
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.id).toBe(active.id);
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
    // 本轮补池一旦发现配置变化就中止，不保存与基线不一致的内容
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

describe('教学预设目录', () => {
  it('设置接口给出全部预设及其说明与原文', async () => {
    const h = createHarness();
    const view = (await h.call('GET', '/api/settings')).body;
    expect(view.teachingPresets.length).toBeGreaterThanOrEqual(9);
    const ids = view.teachingPresets.map((s: any) => s.id);
    expect(ids).toContain('default');
    expect(ids).toContain('stem');
    expect(ids).toContain('language');
    expect(view.teachingPresets.every((s: any) => s.label && s.description && typeof s.version === 'number')).toBe(true);
    // 兼容别名：旧界面与测试按 subjectStyles 读取同一份目录
    expect(view.subjectStyles).toEqual(view.teachingPresets);
  });

  it('每个预设都带 tutorial 与 figure 原文，通用预设为空', async () => {
    const h = createHarness();
    const view = (await h.call('GET', '/api/settings')).body;
    const byId = new Map(view.teachingPresets.map((s: any) => [s.id, s]));
    expect((byId.get('default') as any).tutorial).toBe('');
    expect((byId.get('default') as any).figure).toBe('');
    for (const id of ['stem', 'programming', 'language', 'humanities', 'business', 'law', 'medicine', 'arts']) {
      const style = byId.get(id) as any;
      expect(style.tutorial.length).toBeGreaterThan(100);
      expect(style.figure.length).toBeGreaterThan(20);
      expect(style.tutorial).toContain('学科补充要求');
    }
  });

  it('不同预设的追加内容互不相同', async () => {
    const h = createHarness();
    const view = (await h.call('GET', '/api/settings')).body;
    const texts = view.teachingPresets.filter((s: any) => s.id !== 'default').map((s: any) => s.tutorial);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('教学预设只对所属课程生效', () => {
  /** 两门课程：语言（西班牙语）与理工科（数字信号处理） */
  async function twoCourses(h: ReturnType<typeof createHarness>) {
    const language = await makeCourse(h, '语言', 'language', '西班牙语');
    const stem = await makeCourse(h, '理工科', 'stem', '数字信号处理');
    const esp = await h.startTopic('西班牙语动词变位');
    const dsp = await h.startTopic('离散时间信号');
    await assign(h, language.courseId, [esp]);
    await assign(h, stem.courseId, [dsp]);
    // 归属变化会作废旧候选内容并重新备课：等后台按新预设备好
    await h.worker.runUntilIdle();
    return { language, stem, esp, dsp };
  }

  it('生成内容时按课程所属学科的预设追加要求，共用规则始终保留', async () => {
    const h = createHarness();
    // twoCourses 在归入课程后会按新预设备课，这些请求就是本测试要检查的内容
    await twoCourses(h);

    const systems = h.requests.filter((r) => r.name === 'lesson' || r.name === 'review').map((r) => r.system ?? '');
    expect(systems.length).toBeGreaterThan(0);
    expect(systems.some((s) => s.includes('语言学习'))).toBe(true);
    expect(systems.some((s) => s.includes('理工科'))).toBe(true);
    for (const s of systems) expect(s).toContain('写作原则');
  });

  it('只有真正受影响的课程内容被作废，其他课程保持可用', async () => {
    const h = createHarness();
    const { language, stem } = await twoCourses(h);
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);
    const courseOf = courseOfPoint(h);
    const languageItems = before.filter((i) => courseOf(i.knowledgePointId) === language.courseId);
    const others = before.filter((i) => courseOf(i.knowledgePointId) !== language.courseId);
    expect(languageItems.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);

    // 只改语言学科的内容风格
    const res = await h.call('PATCH', `/api/disciplines/${language.disciplineId}`, { presetId: 'humanities', confirmed: true });
    expect(res.status).toBe(200);

    const after = loadPool(h.db);
    expect(after.some((i) => courseOf(i.knowledgePointId) === language.courseId)).toBe(false);
    for (const item of others) expect(after.some((i) => i.id === item.id)).toBe(true);
    for (const item of languageItems) {
      expect(h.db.select().from(items).where(eq(items.id, item.id)).get()!.status).toBe('void');
    }
    expect(stem.courseId).not.toBe(language.courseId);
  });

  it('预设没变的改名或移动不会让内容失效', async () => {
    const h = createHarness();
    const { language } = await twoCourses(h);
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);

    // 改名：不影响讲法
    expect((await h.call('PATCH', `/api/disciplines/${language.disciplineId}`, { name: '外语' })).status).toBe(200);
    expect((await h.call('PATCH', `/api/courses/${language.courseId}`, { name: '西班牙语进阶' })).status).toBe(200);
    expect(loadPool(h.db)).toEqual(before);

    // 移到同为 language 预设的另一个学科：讲法没变，内容仍可用
    const other = (await h.call('POST', '/api/disciplines', { name: '语言二类', presetId: 'language' })).body;
    expect((await h.call('PATCH', `/api/courses/${language.courseId}`, { disciplineId: other.id })).status).toBe(200);
    expect(loadPool(h.db)).toEqual(before);
  });

  it('按课程预览的提示词与生成端解析结果逐字一致', async () => {
    const h = createHarness();
    const { language, stem } = await twoCourses(h);
    await h.call('PUT', '/api/settings', CUSTOM);
    h.requests.length = 0;
    await h.worker.runUntilIdle();
    const languageView = (await h.call('GET', `/api/courses/${language.courseId}/guidance`)).body;
    const stemView = (await h.call('GET', `/api/courses/${stem.courseId}/guidance`)).body;

    const lessons = h.requests.filter((r) => r.name === 'lesson');
    expect(lessons.length).toBeGreaterThan(0);
    // 每个学科的讲解提示词都应逐字包含对应课程的预览，且不混入别的课程要求
    for (const request of lessons) {
      const matchesLanguage = request.system?.includes(languageView.tutorialGuidance) ?? false;
      const matchesStem = request.system?.includes(stemView.tutorialGuidance) ?? false;
      expect(matchesLanguage || matchesStem).toBe(true);
      if (matchesLanguage) {
        expect(request.prompt).toContain(languageView.figureGuidance);
        expect(request.system).not.toContain('学科补充要求：理工科');
      } else {
        expect(request.prompt).toContain(stemView.figureGuidance);
        expect(request.system).not.toContain('学科补充要求：语言学习');
      }
    }
    expect(lessons.some((r) => r.system?.includes(languageView.tutorialGuidance))).toBe(true);
    expect(lessons.some((r) => r.system?.includes(stemView.tutorialGuidance))).toBe(true);
  });
});

describe('停用的旧分类设置必须明确失败，而不是继续生效', () => {
  it('写入分组/标签覆盖/扁平映射时返回 400 并给出迁移指引', async () => {
    const h = createHarness();
    for (const legacy of [
      { subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西语'] }] },
      { tagStyles: { 液压传动: 'programming' } },
      { subjectStyles: { 西语: 'language' } },
    ]) {
      const res = await h.call('PUT', '/api/settings', legacy);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('学科与课程');
    }
  });

  it('同一次请求里既改节奏又带旧字段时，整次失败且不改动已保存的配置', async () => {
    const h = createHarness();
    await h.call('PUT', '/api/settings', { sessionMinutes: 12 });
    const res = await h.call('PUT', '/api/settings', { sessionMinutes: 20, tagStyles: { x: 'stem' } });
    expect(res.status).toBe(400);
    expect(readUserSettings(h.db, {}).sessionMinutes).toBe(12);
  });

  it('已存储的旧字段被保留为迁移快照，不会被后续保存抹掉', async () => {
    const h = createHarness();
    h.db.insert(appSettings).values({
      key: 'user_settings',
      value: { sessionMinutes: 15, subjectGroups: [{ name: '语言', styleId: 'language', subjects: ['西语'] }], tagStyles: { 西语: 'arts' } },
      updatedAt: DAY1,
    }).run();
    // 旧字段不参与运行期配置
    expect(settingsSource(h.db, {})().contentGuidance).toEqual(DEFAULT_CONTENT_GUIDANCE);
    await h.call('PUT', '/api/settings', { sessionMinutes: 18 });
    const stored = h.db.select().from(appSettings).where(eq(appSettings.key, 'user_settings')).get()!.value as Record<string, unknown>;
    expect(stored.subjectGroups).toEqual([{ name: '语言', styleId: 'language', subjects: ['西语'] }]);
    expect(stored.tagStyles).toEqual({ 西语: 'arts' });
    expect(stored.sessionMinutes).toBe(18);
  });

  it('单个字段被改坏时只让这一项回到默认，其余偏好保留', async () => {
    const h = createHarness();
    h.db.insert(appSettings).values({
      key: 'user_settings',
      value: { sessionMinutes: 17, reminderTimes: ['25:00'], tutorialGuidance: '自定义引导词', unknownField: true },
      updatedAt: DAY1,
    }).run();
    const read = readUserSettings(h.db, {});
    expect(read.sessionMinutes).toBe(17);
    expect(read.reminderTimes).toEqual([]);
    expect(read.tutorialGuidance).toBe('自定义引导词');
  });

  it('补丁 schema 从字段定义派生：缺省字段不会被补成默认值', () => {
    expect(UserSettingsPatchSchema.parse({ sessionMinutes: 15 })).toEqual({ sessionMinutes: 15 });
    expect(UserSettingsPatchSchema.safeParse({ sessionMinutes: 1 }).success).toBe(false);
    expect(UserSettingsPatchSchema.safeParse({ blockedForms: ['fix'] }).success).toBe(false);
  });
});

describe('教学配置指纹', () => {
  it('相同内容得到相同指纹；预设或引导词变化后指纹改变', () => {
    const base = DEFAULT_CONTENT_GUIDANCE;
    const a = teachingFingerprint('stem', base);
    expect(teachingFingerprint('stem', base)).toBe(a);
    expect(teachingFingerprint('language', base)).not.toBe(a);
    expect(teachingFingerprint('stem', { ...base, tutorialGuidance: `${base.tutorialGuidance}\n补充` })).not.toBe(a);
  });

  it('指纹不含学科名与课程名：改名不影响', async () => {
    const h = createHarness();
    const { disciplineId, courseId } = await makeCourse(h, '语言', 'language', '西班牙语');
    const before = (await h.call('GET', `/api/courses/${courseId}/guidance`)).body.fingerprint;
    await h.call('PATCH', `/api/disciplines/${disciplineId}`, { name: '外语' });
    await h.call('PATCH', `/api/courses/${courseId}`, { name: '西班牙语进阶' });
    expect((await h.call('GET', `/api/courses/${courseId}/guidance`)).body.fingerprint).toBe(before);
  });
});
