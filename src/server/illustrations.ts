import { eq } from 'drizzle-orm';
import type { Illustrator } from '../ai/gateway';
import { enqueue } from '../jobs/queue';
import type { Db } from '../store/db';
import { illustrations, items } from '../store/schema';
import { LearningError } from './views';

/** 讲解里的插画：查询是否画好、读取图片、重试失败的插画。 */
export function createIllustrations({ db, illustrator }: { db: Db; illustrator?: () => Illustrator | undefined }) {
  /** 插画的状态：pending 还在画，ready 已画好，failed 没画成 */
  function status(id: string): { status: 'pending' | 'ready' | 'failed' } {
    const row = db.select({ status: illustrations.status }).from(illustrations).where(eq(illustrations.id, id)).get();
    if (!row) throw new LearningError('插画不存在', 404);
    return row;
  }

  /** 只重试失败的插画；状态更新与任务入队一起提交，重复请求不会重复排队。 */
  function retry(id: string, now: Date): ReturnType<typeof status> {
    return db.transaction((tx) => {
      const row = tx.select({ status: illustrations.status, itemStatus: items.status })
        .from(illustrations).innerJoin(items, eq(items.id, illustrations.itemId))
        .where(eq(illustrations.id, id)).get();
      if (!row) throw new LearningError('插画不存在', 404);
      if (row.itemStatus === 'void') throw new LearningError('这段讲解已作废，不能重新生成插图', 409);
      if (row.status !== 'failed') return { status: row.status };
      if (!illustrator?.()) throw new LearningError('还没有配置画图模型，请先到设置页完成配置', 400);

      tx.update(illustrations).set({ status: 'pending' }).where(eq(illustrations.id, id)).run();
      enqueue(tx, 'generate_illustration', { illustrationId: id }, now);
      return { status: 'pending' };
    });
  }

  /** 画好的图片；还没画好或不存在时报 404 */
  function image(id: string): { data: Buffer; mediaType: string } {
    const row = db.select({ image: illustrations.image, mediaType: illustrations.mediaType }).from(illustrations).where(eq(illustrations.id, id)).get();
    if (!row?.image || !row.mediaType) throw new LearningError('插画还没有画好', 404);
    return { data: row.image, mediaType: row.mediaType };
  }

  return { status, retry, image };
}
