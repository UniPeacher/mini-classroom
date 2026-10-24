import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { StructuredModel } from '../ai/gateway';
import { clarifyTopic, nameTopic } from '../ai/topic-planning';
import { enqueue } from '../jobs/queue';
import { TopicIdeaSchema, type TopicMessage } from '../shared/topic-planning';
import type { Db } from '../store/db';
import { createTopic } from '../store/repo';
import { topicDrafts } from '../store/schema';
import { LearningError } from './views';

type TopicDraft = typeof topicDrafts.$inferSelect;

/** 目标澄清与最终确认；讨论草稿不会参与学习调度。 */
export function createTopicPlanning({ db, model }: { db: Db; model: StructuredModel }) {
  const replies = new Map<string, Promise<TopicDraft>>();
  const confirmations = new Map<string, Promise<{ topicId: string }>>();

  function get(id: string): TopicDraft {
    const draft = db.select().from(topicDrafts).where(eq(topicDrafts.id, id)).get();
    if (!draft) throw new LearningError('这段主题讨论不存在', 404);
    return draft;
  }

  function list() {
    return db.select({ id: topicDrafts.id, idea: topicDrafts.idea, updatedAt: topicDrafts.updatedAt })
      .from(topicDrafts).where(isNull(topicDrafts.topicId)).orderBy(desc(topicDrafts.updatedAt)).all();
  }

  function create(idea: string, now: Date) {
    const text = TopicIdeaSchema.parse(idea);
    const id = randomUUID();
    db.insert(topicDrafts).values({ id, idea: text, messages: [{ role: 'user', content: text }], createdAt: now, updatedAt: now }).run();
    return get(id);
  }

  function requireEditable(draft: TopicDraft, revision: number) {
    if (draft.topicId) throw new LearningError('这个主题已加入学习计划', 409);
    if (draft.revision !== revision) throw new LearningError('这段讨论已有更新，请读取最新内容后继续', 409);
  }

  /** 先保存输入并撤销旧摘要，回复失败或刷新时仍可继续这轮对话。 */
  function addMessage(id: string, message: string, revision: number, now: Date) {
    const text = TopicIdeaSchema.parse(message);
    return db.transaction(() => {
      const draft = get(id);
      requireEditable(draft, revision);
      if (draft.messages.at(-1)?.role === 'user') throw new LearningError('上一条消息还在等待回复，请先重试回复', 409);
      const messages: TopicMessage[] = [...draft.messages, { role: 'user', content: text }];
      db.update(topicDrafts).set({ messages, brief: null, revision: revision + 1, updatedAt: now }).where(eq(topicDrafts.id, id)).run();
      return get(id);
    });
  }

  /** 同一轮的重复请求共用生成结果；异步完成后只写入仍匹配的版本。 */
  function reply(id: string, revision: number, now: Date): Promise<TopicDraft> {
    const draft = get(id);
    requireEditable(draft, revision);
    if (draft.messages.at(-1)?.role !== 'user') return Promise.resolve(draft);
    const key = `${id}:${revision}`;
    const pending = replies.get(key);
    if (pending) return pending;

    const request = Promise.resolve().then(async () => {
      let result;
      try {
        result = await clarifyTopic(model, draft.messages);
      } catch {
        throw new LearningError('暂时没能生成回复，已保存你的消息。请重试；若持续失败，请检查设置中的文本模型。', 502);
      }
      const messages: TopicMessage[] = [...draft.messages, { role: 'assistant', content: result.reply, brief: result.brief }];
      const saved = db.update(topicDrafts).set({ messages, brief: result.brief, revision: revision + 1, updatedAt: now })
        .where(and(eq(topicDrafts.id, id), eq(topicDrafts.revision, revision), isNull(topicDrafts.topicId))).run();
      if (saved.changes !== 1) throw new LearningError('这段讨论已有更新，请读取最新内容后继续', 409);
      return get(id);
    }).finally(() => replies.delete(key));
    replies.set(key, request);
    return request;
  }

  /** 确认的是用户看过的摘要版本；创建主题、生成任务与确认记录一起提交。 */
  function confirm(id: string, revision: number, now: Date): Promise<{ topicId: string }> {
    const draft = get(id);
    if (draft.topicId) return Promise.resolve({ topicId: draft.topicId });
    requireEditable(draft, revision);
    const brief = draft.brief;
    if (!brief || draft.messages.at(-1)?.role !== 'assistant') throw new LearningError('请先完成目标澄清，核对学习目标后再确认', 409);
    const key = `${id}:${revision}`;
    const pending = confirmations.get(key);
    if (pending) return pending;

    const request = Promise.resolve().then(async () => {
      let result;
      try {
        result = await nameTopic(model, brief);
      } catch {
        throw new LearningError('暂时没能生成主题名称，学习目标已保留。请重试；若持续失败，请检查设置中的文本模型。', 502);
      }
      return db.transaction(tx => {
        const latest = get(id);
        if (latest.topicId) return { topicId: latest.topicId };
        requireEditable(latest, revision);
        const topicId = createTopic(tx, result.title, now, brief);
        enqueue(tx, 'generate_graph', { topicId }, now);
        tx.update(topicDrafts).set({ topicId, revision: revision + 1, updatedAt: now }).where(eq(topicDrafts.id, id)).run();
        return { topicId };
      });
    }).finally(() => confirmations.delete(key));
    confirmations.set(key, request);
    return request;
  }

  return { get, list, create, addMessage, reply, confirm };
}
