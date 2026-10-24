/** 可以为这一节提供新知识点的主题 */
export interface TopicCandidate {
  topicId: string;
  /** 优先级：1 低、2 中、3 高 */
  priority: number;
  /** 已经为多少节微课堂提供过新知识点 */
  servedSessions: number;
  createdAt: number;
}

/**
 * 新学按主题优先级轮换：每节的新知识点只来自一个主题，选"已供给的节数 ÷ 优先级"最小的。
 * 优先级 3 的主题出现的次数大约是优先级 1 的三倍。比值相同时，优先级高的、更早建的优先（再相同按 id，保证结果确定）。
 */
export function chooseNewTopic(candidates: TopicCandidate[]): string | null {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.servedSessions / a.priority - b.servedSessions / b.priority ||
      b.priority - a.priority ||
      a.createdAt - b.createdAt ||
      a.topicId.localeCompare(b.topicId),
  );
  return sorted[0]?.topicId ?? null;
}

/** 距上次主题回访超过这么多天，并且有暂停的主题时，在一节结束时回访 */
export function revisitDue(lastRevisitAt: Date | null, now: Date, intervalDays: number, pausedCount: number): boolean {
  if (pausedCount === 0) return false;
  if (lastRevisitAt === null) return true;
  return now.getTime() - lastRevisitAt.getTime() >= intervalDays * 24 * 3600 * 1000;
}
