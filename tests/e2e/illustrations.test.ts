import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { illustrationPrompt } from '../../src/ai/illustration-style';
import type { LessonContent } from '../../src/shared/content';
import { illustrations, items, jobs } from '../../src/store/schema';
import { FAKE_PNG, ILLUSTRATION, createFakeIllustrator } from '../fixtures/fake-model';
import { createHarness } from '../fixtures/harness';

const lessons = (db: ReturnType<typeof createHarness>['db']) =>
  db
    .select()
    .from(items)
    .where(eq(items.kind, 'lesson'))
    .all()
    .filter((row) => row.status !== 'void');

/**
 * 讲解的插画：配置了图像模型时，讲解可以配插画。插画在后台由图像模型画好，
 * 完整的教学绘图提示词单独存在插画表里；讲解正文用 illustration:<插画 id> 引用。
 */
describe('讲解的插画', () => {
  it('讲解入库时为每张插画存下完整提示词并排队去画，正文的 key 换成插画 id', async () => {
    const { illustrator, prompts } = createFakeIllustrator();
    const { db, startTopic } = createHarness({ illustrator });
    await startTopic();

    const pooled = lessons(db);
    expect(pooled.length).toBeGreaterThan(0);
    const rows = db.select().from(illustrations).all();
    expect(rows).toHaveLength(pooled.length);
    for (const lesson of pooled) {
      const explanation = (lesson.content as LessonContent).explanation;
      const row = rows.find((r) => r.itemId === lesson.id)!;
      expect(explanation).toContain(`](illustration:${row.id})`);
      expect(explanation).not.toContain(`illustration:${ILLUSTRATION.key}`);
      expect(row.prompt).toBe(illustrationPrompt(ILLUSTRATION));
      expect(row.prompt).toContain(ILLUSTRATION.prompt);
      // 后台已画好
      expect(row.status).toBe('ready');
      expect(new Uint8Array(row.image!)).toEqual(FAKE_PNG);
      expect(row.mediaType).toBe('image/png');
    }
    // 交给图像模型的正是存下的提示词
    expect(prompts.sort()).toEqual(rows.map((r) => r.prompt).sort());
  });

  it('接口：查询插画状态、读取画好的图片', async () => {
    const { illustrator } = createFakeIllustrator();
    const { db, app, call, startTopic } = createHarness({ illustrator });
    await startTopic();
    const id = db.select().from(illustrations).get()!.id;

    expect((await call('GET', `/api/illustrations/${id}`)).body).toEqual({ status: 'ready' });
    const res = await app.request(`/api/illustrations/${id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_PNG);
    expect((await call('GET', '/api/illustrations/not-exist')).status).toBe(404);
  });

  it('图像接口一直出错：重试用尽后标记为没画成，讲解照常可学', async () => {
    const { illustrator, prompts } = createFakeIllustrator({ alwaysFail: true });
    const { db, app, call, startTopic } = createHarness({ illustrator });
    await startTopic();

    const rows = db.select().from(illustrations).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'failed' && r.image === null)).toBe(true);
    // 每张都试了 3 次
    expect(prompts).toHaveLength(rows.length * 3);
    expect((await call('GET', `/api/illustrations/${rows[0]!.id}`)).body).toEqual({ status: 'failed' });
    expect((await app.request(`/api/illustrations/${rows[0]!.id}/image`)).status).toBe(404);
    expect((await call('POST', '/api/sessions/next', {})).body.session.items.length).toBeGreaterThan(0);
  });

  it('学习时只重试选中的失败插画，重复点击不重复生成，也不改变讲解和其他插画', async () => {
    const options = { alwaysFail: true };
    const { illustrator, prompts } = createFakeIllustrator(options);
    const { db, app, call, worker, startTopic } = createHarness({ illustrator });
    await startTopic();
    const session = (await call('POST', '/api/sessions/next', {})).body.session;
    const lesson = session.items.find((item: { kind: string }) => item.kind === 'lesson');
    const row = db.select().from(illustrations).where(eq(illustrations.itemId, lesson.id)).get()!;
    const originalLesson = db.select().from(items).where(eq(items.id, row.itemId)).get();
    const originalImages = db.select().from(illustrations).all();
    const imageJobs = () => db.select().from(jobs).where(eq(jobs.type, 'generate_illustration')).all();
    const originalJobs = imageJobs();
    const originalCalls = prompts.length;
    options.alwaysFail = false;

    expect(await call('POST', `/api/illustrations/${row.id}/retry`)).toEqual({ status: 200, body: { status: 'pending' } });
    expect((await call('GET', `/api/illustrations/${row.id}`)).body).toEqual({ status: 'pending' });
    expect((await call('POST', `/api/illustrations/${row.id}/retry`)).body).toEqual({ status: 'pending' });
    expect(imageJobs()).toHaveLength(originalJobs.length + 1);
    expect(prompts).toHaveLength(originalCalls);

    await worker.runUntilIdle();

    expect((await call('GET', `/api/illustrations/${row.id}`)).body).toEqual({ status: 'ready' });
    const image = await app.request(`/api/illustrations/${row.id}/image`);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(FAKE_PNG);
    expect(prompts.slice(originalCalls)).toEqual([row.prompt]);
    expect(db.select().from(items).where(eq(items.id, row.itemId)).get()).toEqual(originalLesson);
    expect(db.select().from(illustrations).all().filter((image) => image.id !== row.id))
      .toEqual(originalImages.filter((image) => image.id !== row.id));
    expect(imageJobs().slice(0, originalJobs.length)).toEqual(originalJobs);

    // 已画好的图片不再重画，避免旧地址的浏览器缓存与图片内容不一致。
    expect((await call('POST', `/api/illustrations/${row.id}/retry`)).body).toEqual({ status: 'ready' });
    expect(imageJobs()).toHaveLength(originalJobs.length + 1);
  });

  it('手动重试仍失败时结束本轮任务，保留再次手动重试的能力', async () => {
    const { illustrator, prompts } = createFakeIllustrator({ alwaysFail: true });
    const { db, call, worker, startTopic } = createHarness({ illustrator });
    await startTopic();
    const { id } = db.select().from(illustrations).get()!;
    const originalCalls = prompts.length;

    expect((await call('POST', `/api/illustrations/${id}/retry`)).body).toEqual({ status: 'pending' });
    await worker.runUntilIdle();
    expect((await call('GET', `/api/illustrations/${id}`)).body).toEqual({ status: 'failed' });
    expect(prompts).toHaveLength(originalCalls + 3);
    expect(await worker.runOnce()).toBe(false);
    expect((await call('POST', `/api/illustrations/${id}/retry`)).body).toEqual({ status: 'pending' });
  });

  it('不存在或已作废讲解的插画不能重试', async () => {
    const { illustrator } = createFakeIllustrator({ alwaysFail: true });
    const { db, call, startTopic } = createHarness({ illustrator });
    await startTopic();
    const row = db.select().from(illustrations).get()!;
    db.update(items).set({ status: 'void' }).where(eq(items.id, row.itemId)).run();
    const originalJobs = db.select().from(jobs).all();

    expect((await call('POST', '/api/illustrations/not-exist/retry')).status).toBe(404);
    const response = await call('POST', `/api/illustrations/${row.id}/retry`);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('作废');
    expect((await call('GET', `/api/illustrations/${row.id}`)).body).toEqual({ status: 'failed' });
    expect(db.select().from(jobs).all()).toEqual(originalJobs);
  });

  it('没有配置画图模型时说明原因，失败插画不会进入无人处理的等待状态', async () => {
    const { db, call, startTopic } = createHarness();
    await startTopic();
    const item = lessons(db)[0]!;
    db.insert(illustrations).values({
      id: 'old-failed-image', itemId: item.id, prompt: '原来的绘图说明', status: 'failed', createdAt: item.createdAt,
    }).run();
    const originalJobs = db.select().from(jobs).all();

    const response = await call('POST', '/api/illustrations/old-failed-image/retry');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('画图模型');
    expect((await call('GET', '/api/illustrations/old-failed-image')).body).toEqual({ status: 'failed' });
    expect(db.select().from(jobs).all()).toEqual(originalJobs);
  });

  it('按补充说明重新生成的讲解同样配插画', async () => {
    const { illustrator } = createFakeIllustrator();
    const { db, call, worker, startTopic } = createHarness({ illustrator });
    await startTopic();
    const session = (await call('POST', '/api/sessions/next', { guidance: '多结合后端开发的真实例子' })).body.session;
    await worker.runUntilIdle();

    const lesson = session.items.find((i: { kind: string }) => i.kind === 'lesson');
    expect(lesson).toBeDefined();
    const row = db.select().from(illustrations).where(eq(illustrations.itemId, lesson.id)).get();
    expect(row?.status).toBe('ready');
    expect(lesson.explanation).toContain(`](illustration:${row!.id})`);
  });

  it('没有配置图像模型：提示词不提插画，讲解只用代码画的图', async () => {
    const { db, prompts, startTopic } = createHarness();
    await startTopic();

    expect(db.select().from(illustrations).all()).toHaveLength(0);
    for (const lesson of lessons(db)) expect((lesson.content as LessonContent).explanation).not.toContain('illustration:');
    const lessonPrompts = prompts.filter((p) => p.includes('请为这个知识点写一段讲解'));
    expect(lessonPrompts.length).toBeGreaterThan(0);
    for (const prompt of lessonPrompts) expect(prompt).not.toContain('illustrations');
  });
});
