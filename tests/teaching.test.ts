import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../src/ai/gateway';
import { createHandlers } from '../src/jobs/handlers';
import { enqueue } from '../src/jobs/queue';
import { createWorker } from '../src/jobs/worker';
import { settingsSource, toSettings, DEFAULT_USER_SETTINGS } from '../src/settings';
import { DEFAULT_CONTENT_GUIDANCE } from '../src/shared/content-guidance';
import { resolvePointTeaching, teachingChanged, adoptLegacyFingerprints } from '../src/teaching';
import { openDb } from '../src/store/db';
import { createTopic, insertItem, loadPool, loadPoints, loadStates } from '../src/store/repo';
import { courses, disciplines, items, jobs, knowledgePoints, memoryStates, topics } from '../src/store/schema';
import { DAY1, createHarness } from './fixtures/harness';
import { createFakeModel } from './fixtures/fake-model';
import { UNLEARNED } from '../src/domain/memory';

const settings = () => toSettings(DEFAULT_USER_SETTINGS, {});

/** 直接建一套学科 → 课程 → 主题，绕过 HTTP，便于断言解析结果 */
function setup() {
  const db = openDb(':memory:');
  const disciplineId = 'disc-1';
  const courseId = 'course-1';
  db.insert(disciplines).values({ id: disciplineId, name: '语言', presetId: 'language', createdAt: DAY1 }).run();
  db.insert(courses).values({ id: courseId, name: '西班牙语', disciplineId, createdAt: DAY1 }).run();
  const topicId = createTopic(db, '西班牙语动词变位', DAY1, undefined, null, courseId);
  const unclassifiedId = createTopic(db, '未归类主题', DAY1);
  // 图谱已生成、摸底已跳过：知识点可以新学，补池才会真的生成内容
  db.update(topics).set({ graphStatus: 'ready', placementStatus: 'skipped' }).run();
  return { db, topicId, unclassifiedId, disciplineId, courseId };
}

/** 造一个知识点（含记忆状态），返回知识点 id 与所属主题 */
function addPoint(db: ReturnType<typeof setup>['db'], topicId: string, id = 'kp-1') {
  db.insert(knowledgePoints).values({ id, topicId, title: '规则动词', summary: '掌握现在时变位', position: 0 }).run();
  db.insert(memoryStates).values({ knowledgePointId: id, stage: 'unlearned', updatedAt: DAY1 }).run();
  return id;
}

describe('教学配置解析：学科 → 课程 → 学习主题', () => {
  it('归入课程的主题使用学科预设；未归类主题只用共用规则', () => {
    const { db, topicId, unclassifiedId, courseId, disciplineId } = setup();
    const classified = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    expect(classified).toMatchObject({ presetId: 'language', courseId, disciplineId });
    expect(classified.guidance.tutorialGuidance).toContain('学科补充要求：语言学习');
    expect(classified.guidance.tutorialGuidance).toContain(DEFAULT_CONTENT_GUIDANCE.tutorialGuidance.trimEnd());

    const loose = resolvePointTeachingFromTopic(db, unclassifiedId, 'kp-b');
    expect(loose).toMatchObject({ presetId: 'default', courseId: null, disciplineId: null });
    expect(loose.guidance).toEqual(DEFAULT_CONTENT_GUIDANCE);
    expect(loose.fingerprint).not.toBe(classified.fingerprint);
  });

  it('预设 id 被改坏时退回通用，不套用别的学科要求', () => {
    const { db, topicId, disciplineId } = setup();
    db.update(disciplines).set({ presetId: 'quantum' }).where(eq(disciplines.id, disciplineId)).run();
    const teaching = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    expect(teaching.presetId).toBe('default');
    expect(teaching.guidance).toEqual(DEFAULT_CONTENT_GUIDANCE);
  });

  it('学科名或课程名改变不会改变指纹，也不会让内容失效', () => {
    const { db, topicId, courseId, disciplineId } = setup();
    const before = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    db.update(disciplines).set({ name: '外语' }).where(eq(disciplines.id, disciplineId)).run();
    db.update(courses).set({ name: '西班牙语进阶' }).where(eq(courses.id, courseId)).run();
    const after = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('换到预设相同的另一个学科时指纹不变；换成不同预设时指纹改变', () => {
    const { db, topicId, courseId, disciplineId } = setup();
    const before = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    db.insert(disciplines).values({ id: 'disc-2', name: '语言二类', presetId: 'language', createdAt: DAY1 }).run();
    db.update(courses).set({ disciplineId: 'disc-2' }).where(eq(courses.id, courseId)).run();
    expect(resolvePointTeachingFromTopic(db, topicId, 'kp-a').fingerprint).toBe(before.fingerprint);

    db.update(disciplines).set({ presetId: 'humanities' }).where(eq(disciplines.id, 'disc-2')).run();
    expect(resolvePointTeachingFromTopic(db, topicId, 'kp-a').fingerprint).not.toBe(before.fingerprint);
    expect(disciplineId).toBe('disc-1');
  });

  it('手动改共用引导词会改变所有主题的指纹', () => {
    const { db, topicId, unclassifiedId } = setup();
    const a = resolvePointTeachingFromTopic(db, topicId, 'kp-a');
    const b = resolvePointTeachingFromTopic(db, unclassifiedId, 'kp-b');
    const custom = toSettings({ ...DEFAULT_USER_SETTINGS, tutorialGuidance: '用摄影案例讲。' }, {});
    expect(resolvePointTeachingFromTopic(db, topicId, 'kp-a', custom).fingerprint).not.toBe(a.fingerprint);
    expect(resolvePointTeachingFromTopic(db, unclassifiedId, 'kp-b', custom).fingerprint).not.toBe(b.fingerprint);
  });
});

describe('内容过期判定', () => {
  it('旧内容没有指纹（升级前生成）时不因配置变化自动作废', () => {
    const { db, topicId } = setup();
    const pointId = addPoint(db, topicId);
    expect(teachingChanged(db, pointId, settings(), null)).toBe(false);
    expect(teachingChanged(db, pointId, settings(), undefined)).toBe(false);
  });

  it('指纹不一致即为过期；一致则不是', () => {
    const { db, topicId } = setup();
    const pointId = addPoint(db, topicId);
    const current = resolvePointTeaching(db, pointId, settings()).fingerprint;
    expect(teachingChanged(db, pointId, settings(), current)).toBe(false);
    expect(teachingChanged(db, pointId, settings(), `${current}-stale`)).toBe(true);
  });

  it('生成期间知识点被删除时判为过期，避免写入时撞外键', () => {
    const { db, topicId } = setup();
    const pointId = addPoint(db, topicId);
    const fingerprint = resolvePointTeaching(db, pointId, settings()).fingerprint;
    db.delete(memoryStates).where(eq(memoryStates.knowledgePointId, pointId)).run();
    db.delete(knowledgePoints).where(eq(knowledgePoints.id, pointId)).run();
    expect(teachingChanged(db, pointId, settings(), fingerprint)).toBe(true);
    // 即便"没有指纹"，已删除的知识点也不能再入池
    expect(teachingChanged(db, pointId, settings(), null)).toBe(true);
  });
});

describe('候选内容与生成时的教学配置一致', () => {
  /** 用真实的 handlers 跑一次补池 */
  function workerFor(db: ReturnType<typeof setup>['db'], model: StructuredModel) {
    const worker = createWorker(
      db,
      createHandlers({ db, model, clock: () => DAY1, settings: () => settings() }),
      () => DAY1,
    );
    // 补池是入队任务：只有队列里有任务才会真正执行
    enqueue(db, 'fill_pool', {}, DAY1, { dedupe: true });
    return worker;
  }

  it('入池内容保存生成时的指纹；配置没变时保留，配置变了才作废', async () => {
    const { db, topicId, disciplineId } = setup();
    const pointId = addPoint(db, topicId);
    db.update(topics).set({ placementStatus: 'skipped' }).run();
    await workerFor(db, createFakeModel().model).runUntilIdle();

    const pooled = db.select().from(items).where(eq(items.status, 'pooled')).all();
    expect(pooled.length).toBeGreaterThan(0);
    const expected = resolvePointTeaching(db, pointId, settings()).fingerprint;
    for (const row of pooled) expect(row.guidanceFingerprint).toBe(expected);

    // 改名不影响
    await workerFor(db, createFakeModel().model).runUntilIdle();
    expect(loadPool(db).map((i) => i.id).sort()).toEqual(pooled.map((i) => i.id).sort());

    // 换预设后旧内容过期
    db.update(disciplines).set({ presetId: 'humanities' }).where(eq(disciplines.id, disciplineId)).run();
    for (const row of db.select().from(items).where(eq(items.status, 'pooled')).all()) {
      expect(teachingChanged(db, row.knowledgePointId, settings(), row.guidanceFingerprint)).toBe(true);
    }
  });

  it('生成前配置变了：本轮中止，不保存与基线不一致的内容', async () => {
    const { db, topicId, disciplineId } = setup();
    addPoint(db, topicId);
    db.update(topics).set({ placementStatus: 'skipped' }).run();
    const fake = createFakeModel();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = fake.model.generate;
    let first = true;
    const model: StructuredModel = {
      async generate<T>(request: StructuredRequest<T>): Promise<T> {
        if (request.name === 'lesson' && first) {
          first = false;
          entered();
          await gate;
        }
        return generate(request);
      },
    };
    const worker = workerFor(db, model);
    const running = worker.runOnce();
    await started;
    // 生成期间换预设：受影响主题的旧候选被作废，本轮补池必须放弃保存
    db.update(disciplines).set({ presetId: 'humanities' }).where(eq(disciplines.id, disciplineId)).run();
    release();
    await running;
    expect(db.select().from(items).where(eq(items.status, 'pooled')).all()).toHaveLength(0);
  });

  it('补池按所属课程的预设备课，不同课程互不影响', async () => {
    const { db, topicId } = setup();
    // 第二门课程：理工科
    db.insert(disciplines).values({ id: 'disc-stem', name: '理工科', presetId: 'stem', createdAt: DAY1 }).run();
    db.insert(courses).values({ id: 'course-stem', name: '数字信号处理', disciplineId: 'disc-stem', createdAt: DAY1 }).run();
    const stemTopic = createTopic(db, '离散时间信号', DAY1, undefined, null, 'course-stem');
    db.update(topics).set({ graphStatus: 'ready', placementStatus: 'skipped' }).run();
    addPoint(db, topicId, 'kp-lang');
    addPoint(db, stemTopic, 'kp-stem');

    const fake = createFakeModel();
    await workerFor(db, fake.model).runUntilIdle();
    const systems = fake.requests.filter((r) => r.name === 'lesson').map((r) => r.system ?? '');
    expect(systems.some((s) => s.includes('学科补充要求：语言学习'))).toBe(true);
    expect(systems.some((s) => s.includes('学科补充要求：理工科'))).toBe(true);
    // 每条请求只带一个学科要求，不会互相串味
    for (const s of systems) {
      expect(Number(s.includes('学科补充要求：语言学习')) + Number(s.includes('学科补充要求：理工科'))).toBe(1);
    }
    // 每个知识点都真的有对应指纹
    for (const row of db.select().from(items).all()) expect(row.guidanceFingerprint).toBeTruthy();
  });

  it('旧内容（没有指纹）不会被升级或补池顺手作废', async () => {
    const { db, topicId } = setup();
    const pointId = addPoint(db, topicId);
    // 模拟升级前生成的一项候选
    insertItem(db, { knowledgePointId: pointId, kind: 'lesson', form: 'explain_direct', questionForm: 'mcq', estSeconds: 90, content: { explanation: '旧讲解' } as never }, DAY1);
    await workerFor(db, createFakeModel().model).runUntilIdle();
    const legacy = db.select().from(items).all().find((i) => i.guidanceFingerprint === null);
    expect(legacy).toBeDefined();
    expect(legacy!.status).toBe('pooled');
  });

  it('一次性标注旧内容指纹：只补指纹列，不改状态、不入队、不调用模型', async () => {
    const { db, topicId } = setup();
    const pointId = addPoint(db, topicId);
    // 三个典型场景：候选池、已使用（历史）、联结练习
    const pooledId = insertItem(db, { knowledgePointId: pointId, kind: 'lesson', form: 'explain_direct', questionForm: 'mcq', estSeconds: 90, content: { explanation: '旧讲解' } as never }, DAY1);
    const usedId = insertItem(db, { knowledgePointId: pointId, kind: 'review', form: 'mcq', questionForm: 'mcq', estSeconds: 60, content: { question: {} } as never, status: 'used' }, DAY1);
    const connectionId = insertItem(db, { knowledgePointId: pointId, kind: 'connection', form: 'connection', questionForm: 'connection', estSeconds: 90, content: {} as never, status: 'used' }, DAY1);
    const jobsBefore = db.select().from(jobs).all().length;
    const contentOf = (id: string) => db.select().from(items).where(eq(items.id, id)).get()!;
    const before = [contentOf(pooledId), contentOf(usedId), contentOf(connectionId)].map((r) => ({ status: r.status, createdAt: r.createdAt.getTime(), content: r.content }));

    const expected = resolvePointTeaching(db, pointId, settings()).fingerprint;
    expect(adoptLegacyFingerprints(db, settings())).toBe(2);

    // 讲解与复习题补上基线指纹；联结练习不涉及内容风格，保持为空
    expect(contentOf(pooledId).guidanceFingerprint).toBe(expected);
    expect(contentOf(usedId).guidanceFingerprint).toBe(expected);
    expect(contentOf(connectionId).guidanceFingerprint).toBeNull();
    // 状态、内容、创建时间、任务队列都没有变化
    const after = [contentOf(pooledId), contentOf(usedId), contentOf(connectionId)].map((r) => ({ status: r.status, createdAt: r.createdAt.getTime(), content: r.content }));
    expect(after).toEqual(before);
    expect(db.select().from(jobs).all()).toHaveLength(jobsBefore);
    // 重复执行不再变化
    expect(adoptLegacyFingerprints(db, settings())).toBe(0);
  });
});

/** 解析知识点时先补一条知识点记录（解析函数需要它的主题归属） */
function resolvePointTeachingFromTopic(
  db: ReturnType<typeof setup>['db'],
  topicId: string,
  pointId: string,
  current = settings(),
) {
  const exists = db.select({ id: knowledgePoints.id }).from(knowledgePoints).where(eq(knowledgePoints.id, pointId)).get();
  if (!exists) {
    db.insert(knowledgePoints).values({ id: pointId, topicId, title: '占位', summary: '占位', position: 0 }).run();
  }
  return resolvePointTeaching(db, pointId, current);
}

describe('补池与状态读取不受测试顺序影响', () => {
  it('未参与补池的主题不会凭空产生候选内容', () => {
    const { db, unclassifiedId } = setup();
    expect(db.select().from(items).all()).toHaveLength(0);
    expect(loadPoints(db)).toHaveLength(0);
    expect(loadStates(db).size).toBe(0);
    expect(unclassifiedId).toBeTruthy();
    expect(UNLEARNED.stage).toBe('unlearned');
  });
});

describe('组织变更与补池的协作', () => {
  it('只有受影响的主题会重新备课（通过 HTTP 组织接口）', async () => {
    const h = createHarness();
    const d1 = (await h.call('POST', '/api/disciplines', { name: '语言', presetId: 'language' })).body;
    const c1 = (await h.call('POST', '/api/courses', { name: '西班牙语', disciplineId: d1.id })).body;
    const d2 = (await h.call('POST', '/api/disciplines', { name: '理工科', presetId: 'stem' })).body;
    const c2 = (await h.call('POST', '/api/courses', { name: '数字信号处理', disciplineId: d2.id })).body;
    const esp = await h.startTopic('西班牙语动词变位');
    const dsp = await h.startTopic('离散时间信号');
    await h.call('PUT', `/api/courses/${c1.id}/topics`, { topicIds: [esp] });
    await h.call('PUT', `/api/courses/${c2.id}/topics`, { topicIds: [dsp] });
    await h.worker.runUntilIdle();

    const before = loadPool(h.db);
    const courseOfTopic = new Map(h.db.select().from(topics).all().map((t) => [t.id, t.courseId]));
    const topicOfPoint = new Map(h.db.select().from(knowledgePoints).all().map((p) => [p.id, p.topicId]));
    const courseOf = (pointId: string) => courseOfTopic.get(topicOfPoint.get(pointId) ?? '') ?? null;
    const stemItems = before.filter((i) => courseOf(i.knowledgePointId) === c2.id);
    expect(stemItems.length).toBeGreaterThan(0);

    await h.call('PATCH', `/api/disciplines/${d1.id}`, { presetId: 'humanities', confirmed: true });
    const after = loadPool(h.db);
    for (const item of stemItems) expect(after.some((i) => i.id === item.id)).toBe(true);
    expect(after.every((i) => courseOf(i.knowledgePointId) !== c1.id)).toBe(true);
    expect(enqueue).toBeTypeOf('function');
  });
});
