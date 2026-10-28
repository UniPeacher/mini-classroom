import { eq } from 'drizzle-orm';
import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { loadPool } from '../../src/store/repo';
import { items, memoryStates, sessions, topics } from '../../src/store/schema';
import { DAY, DAY1, createHarness } from '../fixtures/harness';

type Harness = ReturnType<typeof createHarness>;

/** 建两个学科、三个课程，并把主题归到课程下 */
async function seeded(h: Harness) {
  const stem = (await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).body;
  const lang = (await h.call('POST', '/api/disciplines', { name: '语言', presetId: 'language' })).body;
  const dsp = (await h.call('POST', '/api/courses', { name: '数字信号处理', disciplineId: stem.id })).body;
  const hyd = (await h.call('POST', '/api/courses', { name: '液压传动', disciplineId: stem.id })).body;
  const esp = (await h.call('POST', '/api/courses', { name: '西班牙语', disciplineId: lang.id })).body;

  const dspTopic = await h.startTopic('离散时间信号');
  const hydTopic = await h.startTopic('阀控缸');
  const espTopic = await h.startTopic('动词变位');
  await h.call('PUT', `/api/courses/${dsp.id}/topics`, { topicIds: [dspTopic] });
  await h.call('PUT', `/api/courses/${hyd.id}/topics`, { topicIds: [hydTopic] });
  await h.call('PUT', `/api/courses/${esp.id}/topics`, { topicIds: [espTopic] });
  await h.worker.runUntilIdle();
  return { stem, lang, dsp, hyd, esp, dspTopic, hydTopic, espTopic };
}

const preview = async (h: Harness, scope?: { kind: string; id?: string }, now = DAY1) => {
  const query = scope && scope.kind !== 'all' ? `?scopeKind=${scope.kind}&scopeId=${scope.id}` : '?scopeKind=all';
  return (await h.call('GET', `/api/sessions/preview${query}`, undefined, now)).body;
};

describe('组织视图', () => {
  it('返回学科、课程、主题与统计，迁移报告为空时是 null', async () => {
    const h = createHarness();
    const { stem, dsp, dspTopic } = await seeded(h);
    const view = (await h.call('GET', '/api/organization')).body;
    expect(view.disciplines.find((d: any) => d.id === stem.id)).toMatchObject({ name: '理工科', presetId: 'stem', counts: { courses: 2, topics: 2 } });
    expect(view.courses.find((c: any) => c.id === dsp.id).counts).toMatchObject({ topics: 1 });
    expect(view.topics.find((t: any) => t.id === dspTopic)).toMatchObject({ courseId: dsp.id, disciplineId: stem.id, courseName: '数字信号处理' });
    expect(view.unclassifiedTopics).toEqual([]);
    expect(view.migrationReport).toBeNull();
  });

  it('课程与主题的统计带认知边缘（下一步可学），与组装用同一套规则', async () => {
    const h = createHarness();
    const { dsp, dspTopic } = await seeded(h);
    const view = (await h.call('GET', '/api/organization')).body;
    const course = view.courses.find((c: any) => c.id === dsp.id);
    expect(course.counts.edge).toBeGreaterThan(0);
    expect(course.counts.points).toBeGreaterThan(0);
    expect(course.counts.learned).toBe(0);
    expect(view.topics.find((t: any) => t.id === dspTopic).counts.edge).toBeGreaterThan(0);
  });

  it('未归类的主题单独列出，不会被删除', async () => {
    const h = createHarness();
    const loose = await h.startTopic('没归类的主题');
    const view = (await h.call('GET', '/api/organization')).body;
    expect(view.unclassifiedTopics.map((t: any) => t.id)).toEqual([loose]);
    expect((await h.call('PATCH', `/api/topics/${loose}`, { priority: 2 })).body.priority).toBe(2);
  });

  it('学科与课程重名被拒绝，不存在的学科返回 404', async () => {
    const h = createHarness();
    await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' });
    expect((await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).status).toBe(409);
    expect((await h.call('POST', '/api/disciplines', { name: '  ' })).status).toBe(400);
    expect((await h.call('POST', '/api/disciplines', { name: '新学科', presetId: '不存在' })).status).toBe(400);
    expect((await h.call('POST', '/api/courses', { name: '课程', disciplineId: 'nope' })).status).toBe(404);

    const stem = (await h.call('POST', '/api/disciplines', { name: '理学' })).body;
    await h.call('POST', '/api/courses', { name: '物理', disciplineId: stem.id });
    expect((await h.call('POST', '/api/courses', { name: '物理', disciplineId: stem.id })).status).toBe(409);
  });

  it('只能删除空学科与空课程', async () => {
    const h = createHarness();
    const { stem, dsp, dspTopic } = await seeded(h);
    expect((await h.call('DELETE', `/api/disciplines/${stem.id}`)).status).toBe(409);
    expect((await h.call('DELETE', `/api/courses/${dsp.id}`)).status).toBe(409);

    // 把主题移走（换预设会作废待学内容，先确认）就可以删课程
    const moved = await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: null });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ code: 'teaching-impact', affectedItems: expect.any(Number) });
    const confirmedMove = await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: null, confirmed: true });
    expect(confirmedMove.status).toBe(200);
    expect(confirmedMove.body.courseId).toBeNull();
    expect((await h.call('DELETE', `/api/courses/${dsp.id}`)).body).toEqual({ ok: true });
  });

  it('把一个主题归入课程，未列出的主题保持原归属', async () => {
    const h = createHarness();
    const { dsp, esp, espTopic } = await seeded(h);
    const extra = await h.startTopic('另一主题');
    const result = (await h.call('PUT', `/api/courses/${dsp.id}/topics`, { topicIds: [extra] })).body;
    expect(result.assigned).toBe(1);
    const view = (await h.call('GET', '/api/organization')).body;
    expect(view.topics.find((t: any) => t.id === extra).courseId).toBe(dsp.id);
    // 没有列出的主题不变
    expect(view.topics.find((t: any) => t.id === espTopic).courseId).toBe(esp.id);
    expect((await h.call('PUT', `/api/courses/${dsp.id}/topics`, { topicIds: ['nope'] })).status).toBe(404);
  });

  it('取消课程归属会改变讲法，需要先确认；确认后回到未归类', async () => {
    const h = createHarness();
    const { dspTopic } = await seeded(h);
    // 从理工科课程移到未归类：预设变回通用，需要确认
    const blocked = await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: null });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'teaching-impact', affectedTopics: 1, modelCalls: true });
    const patched = (await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: null, confirmed: true })).body;
    expect(patched.courseId).toBeNull();
    expect((await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: 'nope' })).status).toBe(404);
  });

  it('没有确认的归属变更被拒绝，且主题、课程与候选内容都保持原样', async () => {
    const h = createHarness();
    const { dsp, esp, dspTopic } = await seeded(h);
    const beforeTopic = h.db.select().from(topics).where(eq(topics.id, dspTopic)).get()!;
    const beforePool = loadPool(h.db);
    const beforeItemRows = h.db.select().from(items).all().map((i) => `${i.id}:${i.status}`).sort();

    // 换到预设不同的课程（理工科 → 语言）：拒绝
    const rejected = await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: esp.id });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ code: 'teaching-impact', affectedTopics: 1, modelCalls: true });

    // 不变量：主题归属未变、候选内容未被作废、没有新增任务
    const afterTopic = h.db.select().from(topics).where(eq(topics.id, dspTopic)).get()!;
    expect(afterTopic.courseId).toBe(beforeTopic.courseId);
    expect(loadPool(h.db)).toEqual(beforePool);
    expect(h.db.select().from(items).all().map((i) => `${i.id}:${i.status}`).sort()).toEqual(beforeItemRows);

    // 确认后才生效
    const accepted = await h.call('PATCH', `/api/topics/${dspTopic}`, { courseId: esp.id, confirmed: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.courseId).toBe(esp.id);
    void dsp;
  });

  it('换到预设相同的课程不需要确认（讲法没变）', async () => {
    const h = createHarness();
    const discipline = (await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).body;
    const a = (await h.call('POST', '/api/courses', { name: '课甲', disciplineId: discipline.id })).body;
    const b = (await h.call('POST', '/api/courses', { name: '课乙', disciplineId: discipline.id })).body;
    const topic = await h.startTopic('主题');
    await h.call('PUT', `/api/courses/${a.id}/topics`, { topicIds: [topic] });
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);

    const moved = await h.call('PATCH', `/api/topics/${topic}`, { courseId: b.id });
    expect(moved.status).toBe(200);
    expect(moved.body.courseId).toBe(b.id);
    expect(loadPool(h.db)).toEqual(before);
  });
});

describe('教学引导词预览', () => {
  it('课程给出所属学科的合并引导词；未归类只给共用规则', async () => {
    const h = createHarness();
    const { dsp, esp } = await seeded(h);
    const dspGuidance = (await h.call('GET', `/api/courses/${dsp.id}/guidance`)).body;
    expect(dspGuidance).toMatchObject({ courseId: dsp.id, presetId: 'stem', presetLabel: '理工科' });
    expect(dspGuidance.tutorialGuidance).toContain('理工科');
    const espGuidance = (await h.call('GET', `/api/courses/${esp.id}/guidance`)).body;
    expect(espGuidance).toMatchObject({ presetId: 'language' });
    expect(espGuidance.tutorialGuidance).toContain('语言学习');

    const unclassified = (await h.call('GET', '/api/courses/unclassified/guidance')).body;
    expect(unclassified).toMatchObject({ courseId: null, presetId: 'default' });
    expect(unclassified.tutorialGuidance).not.toContain('学科补充要求');
    expect((await h.call('GET', '/api/courses/nope/guidance')).status).toBe(404);
  });
});

describe('影响评估（只读）', () => {
  it('给出受影响的课程、主题、待学内容与模型调用次数，且不改动任何数据', async () => {
    const h = createHarness();
    const { stem, espTopic } = await seeded(h);
    const before = loadPool(h.db);
    const beforeItemRows = h.db.select().from(items).all().map((i) => `${i.id}:${i.status}`).sort();
    const espPoints = new Set((await h.call('GET', '/api/map')).body.points.filter((p: any) => p.topicId === espTopic).map((p: any) => p.id));

    const impact = (await h.call('POST', '/api/organization/impact', { kind: 'discipline', id: stem.id, presetId: 'programming' })).body;
    expect(impact.kind).toBe('discipline');
    // 计数是数字，明细在单独的数组里
    expect(impact.affectedCourses).toBe(2);
    expect(impact.affectedTopics).toBe(2);
    expect(impact.courseDetails).toHaveLength(2);
    expect(impact.topicDetails).toHaveLength(2);
    // 只算这个学科下的待学内容，另一个学科的候选项不计入
    const inStem = before.filter((i) => !espPoints.has(i.knowledgePointId));
    expect(impact.affectedItems).toBe(inStem.length);
    expect(impact.modelCalls).toBe(inStem.length > 0);

    // 只读：候选项、主题、记忆状态都没变
    expect(loadPool(h.db)).toEqual(before);
    expect(h.db.select().from(items).all().map((i) => `${i.id}:${i.status}`).sort()).toEqual(beforeItemRows);
    expect(h.db.select().from(topics).all()).toHaveLength(3);
  });

  it('改名、换成相同预设、或没有待学内容时影响为零', async () => {
    const h = createHarness();
    const { stem, dsp, dspTopic } = await seeded(h);

    // 换成相同预设：教学配置没变
    const same = (await h.call('POST', '/api/organization/impact', { kind: 'discipline', id: stem.id, presetId: 'stem' })).body;
    expect(same).toMatchObject({ affectedCourses: 0, affectedTopics: 0, affectedItems: 0, modelCalls: false });

    // 只改名：请求里没有 presetId，教学配置不变
    const rename = (await h.call('POST', '/api/organization/impact', { kind: 'discipline', id: stem.id })).body;
    expect(rename).toMatchObject({ affectedCourses: 0, affectedTopics: 0, affectedItems: 0, modelCalls: false });

    // 没有待学内容的学科：换个预设也不作废任何内容
    const emptyDiscipline = (await h.call('POST', '/api/disciplines', { name: '空学科', presetId: 'stem' })).body;
    const emptyCourse = (await h.call('POST', '/api/courses', { name: '空课程', disciplineId: emptyDiscipline.id })).body;
    const emptyImpact = (await h.call('POST', '/api/organization/impact', { kind: 'discipline', id: emptyDiscipline.id, presetId: 'programming' })).body;
    expect(emptyImpact).toMatchObject({ affectedCourses: 0, affectedTopics: 0, affectedItems: 0, modelCalls: false });
    void emptyCourse;
    void dsp;
    void dspTopic;
  });

  it('课程影响只算这门课程下的主题', async () => {
    const h = createHarness();
    const { dsp, esp } = await seeded(h);
    const impact = (await h.call('POST', '/api/organization/impact', { kind: 'course', id: dsp.id, disciplineId: esp.disciplineId })).body;
    expect(impact.affectedCourses).toBe(1);
    expect(impact.affectedTopics).toBe(1);
    expect(impact.topicDetails.map((t: any) => t.id)).toHaveLength(1);
  });
});

describe('修改组织关系与待学内容', () => {
  it('换学科预设要先确认影响范围，确认后只作废该学科下的待学内容', async () => {
    const h = createHarness();
    const { stem, lang, dspTopic, espTopic } = await seeded(h);
    const before = loadPool(h.db);
    expect(before.length).toBeGreaterThan(0);

    // 没确认时拒绝，且不改动任何内容
    expect((await h.call('PATCH', `/api/disciplines/${stem.id}`, { presetId: 'programming' })).status).toBe(409);
    expect(loadPool(h.db)).toEqual(before);

    const saved = (await h.call('PATCH', `/api/disciplines/${stem.id}`, { presetId: 'programming', confirmed: true })).body;
    expect(saved.presetId).toBe('programming');

    const after = loadPool(h.db);
    // 语言学科（另一个学科）的内容不受影响：它原本的候选项都还在
    const espPointIds = new Set((await h.call('GET', '/api/map')).body.points.filter((p: any) => p.topicId === espTopic).map((p: any) => p.id));
    const espBefore = before.filter((i) => espPointIds.has(i.knowledgePointId));
    expect(espBefore.length).toBeGreaterThan(0);
    for (const item of espBefore) expect(after.some((i) => i.id === item.id)).toBe(true);
    expect(after.length).toBeLessThan(before.length);
    void dspTopic;
    void lang;
  });

  it('空学科换预设不需要确认；有待学内容时才需要', async () => {
    const h = createHarness();
    const empty = (await h.call('POST', '/api/disciplines', { name: '空学科', presetId: 'stem' })).body;
    await h.call('POST', '/api/courses', { name: '空课程', disciplineId: empty.id });
    // 没有任何候选内容：直接保存成功
    const saved = await h.call('PATCH', `/api/disciplines/${empty.id}`, { presetId: 'programming' });
    expect(saved.status).toBe(200);
    expect(saved.body.presetId).toBe('programming');

    // 换回相同预设也不要求确认
    expect((await h.call('PATCH', `/api/disciplines/${empty.id}`, { presetId: 'programming' })).status).toBe(200);
    // 只改名也不要求确认
    expect((await h.call('PATCH', `/api/disciplines/${empty.id}`, { name: '改名后' })).status).toBe(200);
  });

  it('只改名不会作废内容', async () => {
    const h = createHarness();
    const { dsp } = await seeded(h);
    const before = loadPool(h.db);
    const renamed = (await h.call('PATCH', `/api/courses/${dsp.id}`, { name: '信号处理' })).body;
    expect(renamed.name).toBe('信号处理');
    expect(loadPool(h.db)).toEqual(before);
  });

  it('课程换到预设相同的学科不用确认；换到预设不同的学科要先确认', async () => {
    const h = createHarness();
    const { dsp, hyd, lang } = await seeded(h);
    const before = loadPool(h.db);
    const samePreset = (await h.call('POST', '/api/disciplines', { name: '另一个理工科', presetId: 'stem' })).body;
    expect((await h.call('PATCH', `/api/courses/${dsp.id}`, { disciplineId: samePreset.id })).status).toBe(200);
    expect(loadPool(h.db)).toEqual(before);

    expect((await h.call('PATCH', `/api/courses/${hyd.id}`, { disciplineId: lang.id })).status).toBe(409);
    expect((await h.call('PATCH', `/api/courses/${hyd.id}`, { disciplineId: lang.id, confirmed: true })).status).toBe(200);
  });

  it('把主题归入别的课程会换掉它的待学内容（只限这个主题）', async () => {
    const h = createHarness();
    const { esp, espTopic, dsp } = await seeded(h);
    const before = loadPool(h.db);
    const espPoints = new Set((await h.call('GET', '/api/map')).body.points.filter((p: any) => p.topicId === espTopic).map((p: any) => p.id));
    expect(before.some((i) => espPoints.has(i.knowledgePointId))).toBe(true);

    await h.call('PUT', `/api/courses/${dsp.id}/topics`, { topicIds: [espTopic] });
    const after = loadPool(h.db);
    expect(after.some((i) => espPoints.has(i.knowledgePointId))).toBe(false);
    void esp;
  });
});

describe('按范围开始一节', () => {
  it('预览的范围只影响这一节，范围外到期单独计数', async () => {
    const h = createHarness();
    const { dsp, espTopic } = await seeded(h);
    // 让两个课程的知识点都到期：写进数据库时日期是 ISO 字符串
    const lastReview = new Date(DAY1.getTime() - 5 * DAY);
    const due = new Date(DAY1.getTime() - DAY);
    for (const point of h.db.select().from(memoryStates).all()) {
      const card = { ...createEmptyCard(lastReview), state: State.Review, stability: 2, difficulty: 5, reps: 1, last_review: lastReview.toISOString(), due: due.toISOString() };
      h.db.update(memoryStates).set({ stage: 'recall', card }).where(eq(memoryStates.knowledgePointId, point.knowledgePointId)).run();
    }
    const all = await preview(h);
    expect(all.dueCount).toBeGreaterThan(0);
    const scoped = await preview(h, { kind: 'course', id: dsp.id });
    expect(scoped.scope).toMatchObject({ kind: 'course', id: dsp.id, label: '数字信号处理' });
    // 范围外到期只提示数量，不混进这一节
    expect(scoped.outsideDueCount).toBeGreaterThan(0);
    expect(scoped.dueCount).toBeLessThan(all.dueCount);
    expect(all.outsideDueCount).toBe(0);
    // 这一节里安排的复习与新学都来自这门课程
    const map = (await h.call('GET', '/api/map')).body;
    const espPoints = new Set(map.points.filter((p: any) => p.topicId === espTopic).map((p: any) => p.id));
    expect(scoped.items.every((i: any) => i.topicTitle === '离散时间信号')).toBe(true);
    void espPoints;
  });

  it('预览不动任何数据，也不开始课堂', async () => {
    const h = createHarness();
    await seeded(h);
    await preview(h);
    expect(h.db.select().from(sessions).all()).toEqual([]);
  });

  it('按课程开始的一节只含这门课程的内容，并记下范围快照', async () => {
    const h = createHarness();
    const { esp, espTopic } = await seeded(h);
    const session = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } })).body.session;
    expect(session).not.toBeNull();
    expect([...new Set(session.items.map((i: any) => i.topicTitle))]).toEqual(['动词变位']);
    const row = h.db.select().from(sessions).where(eq(sessions.id, session.id)).get()!;
    expect(row).toMatchObject({ scopeKind: 'course', scopeId: esp.id, scopeLabel: '西班牙语' });
    void espTopic;
  });

  it('范围内没有内容时不用别的范围填空', async () => {
    const h = createHarness();
    const { dsp } = await seeded(h);
    const empty = (await h.call('POST', '/api/courses', { name: '空课程', disciplineId: dsp.disciplineId })).body;
    const previewEmpty = await preview(h, { kind: 'course', id: empty.id });
    expect(previewEmpty.items).toEqual([]);
    expect((await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: empty.id } })).body.session).toBeNull();
  });
});

describe('范围请求的边界', () => {
  it('学科/课程范围必须带 id；不带时拒绝，不会退化成全部范围', async () => {
    const h = createHarness();
    const { dsp } = await seeded(h);
    expect((await h.call('POST', '/api/sessions/next', { scope: { kind: 'course' } })).status).toBe(400);
    expect((await h.call('POST', '/api/sessions/next', { scope: { kind: 'discipline' } })).status).toBe(400);
    expect((await h.call('GET', '/api/sessions/preview?scopeKind=course')).status).toBe(400);
    expect((await h.call('GET', '/api/sessions/preview?scopeKind=discipline')).status).toBe(400);
    // 全部范围不需要 id
    expect((await h.call('GET', '/api/sessions/preview?scopeKind=all')).status).toBe(200);
    // 不带范围仍按全部处理，可以开始
    expect((await h.call('POST', '/api/sessions/next', {})).body.session).not.toBeNull();
    void dsp;
  });

  it('直接调用服务时只传 scope 也按“明确带了范围”处理，不会静默继续别的范围', async () => {
    const h = createHarness();
    const { esp, dsp } = await seeded(h);
    const open = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } })).body.session;
    // 不经过 HTTP 的参数校验，直接调服务
    await expect(h.services.learning.nextSession(DAY1, { scope: { kind: 'course', id: dsp.id } }))
      .rejects.toMatchObject({ code: 'open-session' });
    // 旧的未完成课堂没有被结束
    const stillOpen = h.db.select().from(sessions).where(eq(sessions.id, open.id)).get()!;
    expect(stillOpen.finishedAt).toBeNull();
  });
});

describe('未完成课堂与范围', () => {
  it('有未完成的一节时，带范围开始会返回冲突，并带上两边快照，不做破坏性操作', async () => {
    const h = createHarness();
    const { esp, dsp, espTopic } = await seeded(h);
    const open = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } })).body.session;

    const conflict = await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: dsp.id } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'open-session',
      openSession: { id: open.id, scope: { kind: 'course', id: esp.id, label: '西班牙语' } },
      requestedScope: { kind: 'course', id: dsp.id, label: '数字信号处理' },
    });
    // 旧课堂还在
    const openRows = h.db.select().from(sessions).all().filter((s) => s.finishedAt === null);
    expect(openRows).toMatchObject([{ id: open.id }]);
    void espTopic;
  });

  it('同一个范围也必须明确选择：resume 继续旧的，不带则冲突', async () => {
    const h = createHarness();
    const { dsp } = await seeded(h);
    const open = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: dsp.id } })).body.session;

    expect((await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: dsp.id } })).status).toBe(409);
    const resumed = (await h.call('POST', '/api/sessions/next', { resume: true })).body;
    expect(resumed).toMatchObject({ resumed: true, session: { id: open.id } });
  });

  it('resume 明确继续旧的课堂，忽略请求里的范围', async () => {
    const h = createHarness();
    const { esp, dsp } = await seeded(h);
    const open = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } })).body.session;
    const resumed = (await h.call('POST', '/api/sessions/next', { resume: true, scope: { kind: 'course', id: dsp.id } })).body;
    expect(resumed.session.id).toBe(open.id);
    expect(h.db.select().from(sessions).all()).toHaveLength(1);
  });

  it('预览同时给出新的范围内容与未完成课堂的原始范围标签', async () => {
    const h = createHarness();
    const { esp, dsp } = await seeded(h);
    await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } });
    // 改掉课程名：未完成课堂仍显示开始时的名字
    await h.call('PATCH', `/api/courses/${esp.id}`, { name: '西语改名' });
    const view = await preview(h, { kind: 'course', id: dsp.id });
    expect(view.open.scope).toMatchObject({ kind: 'course', id: esp.id, label: '西班牙语' });
    expect(view.scope.label).toBe('数字信号处理');
    expect([...new Set(view.items.map((i: any) => i.topicTitle))]).toEqual(['离散时间信号']);
  });

  it('fresh 明确新建：新的一节建好后旧课堂才结束；新的一节建不成时旧课堂仍可恢复', async () => {
    const h = createHarness();
    const { esp, dsp } = await seeded(h);
    const open = (await h.call('POST', '/api/sessions/next', { scope: { kind: 'course', id: esp.id } })).body.session;

    // 目标范围内没有内容：新的一节建不成
    const empty = (await h.call('POST', '/api/courses', { name: '空课程', disciplineId: dsp.disciplineId })).body;
    const failed = (await h.call('POST', '/api/sessions/next', { fresh: true, scope: { kind: 'course', id: empty.id } })).body;
    expect(failed.session).toBeNull();
    const stillOpen = h.db.select().from(sessions).where(eq(sessions.id, open.id)).get()!;
    expect(stillOpen.finishedAt).toBeNull();

    // 目标范围内有内容：新建成功后才结束旧的
    const built = (await h.call('POST', '/api/sessions/next', { fresh: true, scope: { kind: 'course', id: dsp.id } })).body;
    expect(built.session.id).not.toBe(open.id);
    expect(h.db.select().from(sessions).where(eq(sessions.id, open.id)).get()!.finishedAt).not.toBeNull();
  });
});

describe('改课程归属后的待学内容', () => {
  it('把主题换到同预设的课程时不作废内容；换到不同预设时作废并重新备课', async () => {
    const h = createHarness();
    const { stem, esp, espTopic, dsp } = await seeded(h);
    const before = loadPool(h.db);
    const espPoints = new Set((await h.call('GET', '/api/map')).body.points.filter((p: any) => p.topicId === espTopic).map((p: any) => p.id));
    const mine = before.filter((i) => espPoints.has(i.knowledgePointId));
    expect(mine.length).toBeGreaterThan(0);

    // 新建一个同预设（language）的学科下的课程并移过去：讲法没变
    const lang2 = (await h.call('POST', '/api/disciplines', { name: '语言二', presetId: 'language' })).body;
    const esp2 = (await h.call('POST', '/api/courses', { name: '西班牙语二', disciplineId: lang2.id })).body;
    await h.call('PUT', `/api/courses/${esp2.id}/topics`, { topicIds: [espTopic] });
    expect(loadPool(h.db)).toEqual(before);

    // 再移到理工科课程：预设变了，作废这个主题的待学内容
    await h.call('PUT', `/api/courses/${dsp.id}/topics`, { topicIds: [espTopic] });
    const after = loadPool(h.db);
    expect(after.some((i) => espPoints.has(i.knowledgePointId))).toBe(false);
    void stem;
    void esp;
  });
});
