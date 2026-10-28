import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { settingsSource } from '../../src/settings';
import { loadPool } from '../../src/store/repo';
import { items, knowledgePoints, topics } from '../../src/store/schema';
import { resolvePointTeaching, resolveTopicTeaching, teachingChanged } from '../../src/teaching';
import { DAY1, createHarness } from '../fixtures/harness';

describe('教学配置指纹', () => {
  it('未归类主题只用共用引导词，预设为通用', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const teaching = resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})());
    expect(teaching).toMatchObject({ presetId: 'default', courseId: null, disciplineId: null });
    expect(teaching.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('按课程解析出学科预设，引导词由共用规则与预设组成', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const discipline = (await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).body;
    const course = (await h.call('POST', '/api/courses', { name: '数字信号处理', disciplineId: discipline.id })).body;
    await h.call('PUT', `/api/courses/${course.id}/topics`, { topicIds: [topic] });

    const teaching = resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})());
    expect(teaching).toMatchObject({ presetId: 'stem', courseId: course.id, disciplineId: discipline.id });
    expect(teaching.guidance.tutorialGuidance).toContain('理工科');
    expect(teaching.guidance.tutorialGuidance).toContain('写作原则');
  });

  it('共用引导词变了或换了学科预设，指纹就变；改名不变', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const discipline = (await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).body;
    const course = (await h.call('POST', '/api/courses', { name: '课程', disciplineId: discipline.id })).body;
    await h.call('PUT', `/api/courses/${course.id}/topics`, { topicIds: [topic] });
    const before = resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint;

    // 改名不影响指纹
    await h.call('PATCH', `/api/courses/${course.id}`, { name: '改名后' });
    await h.call('PATCH', `/api/disciplines/${discipline.id}`, { name: '改名学科' });
    expect(resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint).toBe(before);

    // 改共用引导词 → 指纹变化
    await h.call('PUT', '/api/settings', { tutorialGuidance: '用摄影案例讲解。' });
    const afterGuidance = resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint;
    expect(afterGuidance).not.toBe(before);

    // 换学科预设 → 指纹变化
    await h.call('PATCH', `/api/disciplines/${discipline.id}`, { presetId: 'programming', confirmed: true });
    expect(resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint).not.toBe(afterGuidance);
  });

  it('旧内容没有指纹时不判为过期（不因升级自动作废）', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const point = h.db.select().from(knowledgePoints).where(eq(knowledgePoints.topicId, topic)).get()!;
    // 清空指纹，模拟升级前生成的内容
    h.db.update(items).set({ guidanceFingerprint: null }).run();
    const settings = settingsSource(h.db, {})();
    expect(teachingChanged(h.db, point.id, settings, null)).toBe(false);
    expect(teachingChanged(h.db, point.id, settings, undefined)).toBe(false);
    expect(loadPool(h.db).length).toBeGreaterThan(0);
  });

  it('生成时记下指纹；换成不同预设后该指纹被视为过期', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const point = h.db.select().from(knowledgePoints).where(eq(knowledgePoints.topicId, topic)).get()!;
    const settings = settingsSource(h.db, {})();
    const fingerprint = resolvePointTeaching(h.db, point.id, settings).fingerprint;
    const row = h.db.select().from(items).where(eq(items.knowledgePointId, point.id)).get()!;
    expect(row.guidanceFingerprint).toBe(fingerprint);
    expect(teachingChanged(h.db, point.id, settings, fingerprint)).toBe(false);

    const discipline = (await h.call('POST', '/api/disciplines', { name: '语言', presetId: 'language' })).body;
    const course = (await h.call('POST', '/api/courses', { name: '西语', disciplineId: discipline.id })).body;
    await h.call('PUT', `/api/courses/${course.id}/topics`, { topicIds: [topic] });
    expect(teachingChanged(h.db, point.id, settingsSource(h.db, {})() || settings, fingerprint)).toBe(true);
  });

  it('把主题换到预设相同的学科不会让内容失效', async () => {
    const h = createHarness();
    const topic = await h.startTopic();
    const a = (await h.call('POST', '/api/disciplines', { name: '理工甲', presetId: 'stem' })).body;
    const b = (await h.call('POST', '/api/disciplines', { name: '理工乙', presetId: 'stem' })).body;
    const courseA = (await h.call('POST', '/api/courses', { name: '课甲', disciplineId: a.id })).body;
    const courseB = (await h.call('POST', '/api/courses', { name: '课乙', disciplineId: b.id })).body;
    await h.call('PUT', `/api/courses/${courseA.id}/topics`, { topicIds: [topic] });
    await h.worker.runUntilIdle();
    const before = loadPool(h.db);
    const beforeFp = resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint;

    await h.call('PUT', `/api/courses/${courseB.id}/topics`, { topicIds: [topic] });
    expect(resolveTopicTeaching(h.db, topic, settingsSource(h.db, {})()).fingerprint).toBe(beforeFp);
    expect(loadPool(h.db)).toEqual(before);
    // 归属确实换了
    expect(h.db.select().from(topics).where(eq(topics.id, topic)).get()!.courseId).toBe(courseB.id);
  });

  it('组织改动只作废受影响的待学内容，作答记录与未使用无关的内容不动', async () => {
    const h = createHarness();
    const topicA = await h.startTopic('主题甲');
    const topicB = await h.startTopic('主题乙');
    const a = (await h.call('POST', '/api/disciplines', { name: '语言', presetId: 'language' })).body;
    const b = (await h.call('POST', '/api/disciplines', { name: '理工', presetId: 'stem' })).body;
    const courseA = (await h.call('POST', '/api/courses', { name: '课甲', disciplineId: a.id })).body;
    const courseB = (await h.call('POST', '/api/courses', { name: '课乙', disciplineId: b.id })).body;
    await h.call('PUT', `/api/courses/${courseA.id}/topics`, { topicIds: [topicA] });
    await h.call('PUT', `/api/courses/${courseB.id}/topics`, { topicIds: [topicB] });
    await h.worker.runUntilIdle();

    const before = loadPool(h.db);
    const pointsB = new Set(h.db.select().from(knowledgePoints).where(eq(knowledgePoints.topicId, topicB)).all().map((p) => p.id));
    const untouched = before.filter((i) => pointsB.has(i.knowledgePointId));
    expect(untouched.length).toBeGreaterThan(0);

    // 把主题甲换到预设不同的课程：只有它的内容作废
    await h.call('PUT', `/api/courses/${courseB.id}/topics`, { topicIds: [topicA] });
    const after = loadPool(h.db);
    const pointsA = new Set(h.db.select().from(knowledgePoints).where(eq(knowledgePoints.topicId, topicA)).all().map((p) => p.id));
    expect(after.some((i) => pointsA.has(i.knowledgePointId))).toBe(false);
    // 主题乙原本的内容仍在
    const afterIds = new Set(after.map((i) => i.id));
    for (const item of untouched) expect(afterIds.has(item.id)).toBe(true);
    void DAY1;
  });
});
