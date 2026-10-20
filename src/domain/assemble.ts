import { type GraphPoint, cognitiveEdge } from './edge';
import { type MemoryState, UNLEARNED, isDue, retrievability } from './memory';

/** 候选池中的一项内容（组装只关心这些字段） */
export interface PoolItem {
  id: string;
  knowledgePointId: string;
  kind: 'lesson' | 'review';
  form: string;
  estSeconds: number;
}

export interface AssembleInput {
  points: GraphPoint[];
  states: Map<string, MemoryState>;
  pool: PoolItem[];
  now: Date;
  budgetSeconds: number;
  maxNewPerSession: number;
}

export interface AssembleResult {
  items: PoolItem[];
  /** 是否因复习积压而暂停新学 */
  newPaused: boolean;
}

/** 到期复习超过这么多节的量，就视为复习积压 */
export const BACKLOG_SESSIONS = 3;
/** 到期知识点在候选池里没有内容时，按这个时长估算积压 */
const DEFAULT_REVIEW_SECONDS = 60;

/**
 * 按组装规则从候选池挑出一节微课堂：
 * 1. 到期复习按可提取性从低到高（最容易忘的在前）；
 * 2. 再放推进项（理解阶段的重讲）；
 * 3. 再放新知识点，保底 1 个；复习积压时暂停新学；
 * 4. 三类内容穿插排列；
 * 5. 同一知识点优先选与上次不同的形式。
 */
export function assemble(input: AssembleInput): AssembleResult {
  const { points, states, pool, now, budgetSeconds, maxNewPerSession } = input;
  const stateOf = (id: string) => states.get(id) ?? UNLEARNED;
  const byPosition = new Map(points.map((p) => [p.id, p.position]));

  // 1. 到期复习
  const dueStates = points
    .filter((p) => isDue(stateOf(p.id), now))
    .map((p) => ({ id: p.id, state: stateOf(p.id) }))
    .sort((a, b) => retrievability(a.state.card!, now) - retrievability(b.state.card!, now));
  const reviews: PoolItem[] = [];
  let dueSeconds = 0;
  for (const { id, state } of dueStates) {
    const item = pickItem(pool, id, 'review', state.lastQuestionForm);
    dueSeconds += item?.estSeconds ?? DEFAULT_REVIEW_SECONDS;
    if (item) reviews.push(item);
  }

  // 2. 推进项：理解阶段的知识点，用与上次不同的讲解形式重讲
  const advances = points
    .filter((p) => stateOf(p.id).stage === 'understand')
    .sort((a, b) => a.position - b.position)
    .map((p) => pickItem(pool, p.id, 'lesson', stateOf(p.id).lastExplainForm))
    .filter((item): item is PoolItem => item !== undefined);

  // 3. 新知识点：来自认知边缘
  const newPaused = dueSeconds > BACKLOG_SESSIONS * budgetSeconds;
  const news = newPaused
    ? []
    : cognitiveEdge(points, states)
        .map((p) => pickItem(pool, p.id, 'lesson', null))
        .filter((item): item is PoolItem => item !== undefined)
        .slice(0, maxNewPerSession);

  // 先为保底的新知识点预留时间，再依次填充
  const guaranteed = news[0];
  let remaining = budgetSeconds - (guaranteed?.estSeconds ?? 0);
  const takenReviews = takeWithin(reviews, remaining);
  remaining -= sum(takenReviews);
  const takenAdvances = takeWithin(advances, remaining);
  remaining -= sum(takenAdvances);
  const takenNews = guaranteed ? [guaranteed, ...takeWithin(news.slice(1), remaining)] : [];

  // 4. 穿插排列；推进项与新知识点在各自队列内按推荐顺序
  const sortByPosition = (list: PoolItem[]) =>
    [...list].sort((a, b) => (byPosition.get(a.knowledgePointId) ?? 0) - (byPosition.get(b.knowledgePointId) ?? 0));
  const items = interleave([takenReviews, sortByPosition(takenAdvances), sortByPosition(takenNews)]);
  return { items, newPaused };
}

/** 为某个知识点挑一项指定类型的内容：优先与上次不同的形式，没有时才退而用相同形式。 */
function pickItem(pool: PoolItem[], pointId: string, kind: PoolItem['kind'], lastForm: string | null) {
  const candidates = pool.filter((i) => i.knowledgePointId === pointId && i.kind === kind);
  return candidates.find((i) => i.form !== lastForm) ?? candidates[0];
}

/** 按顺序挑选放得进剩余时间的内容，放不下的跳过。 */
function takeWithin(list: PoolItem[], seconds: number): PoolItem[] {
  const taken: PoolItem[] = [];
  let left = seconds;
  for (const item of list) {
    if (item.estSeconds <= left) {
      taken.push(item);
      left -= item.estSeconds;
    }
  }
  return taken;
}

function sum(list: PoolItem[]) {
  return list.reduce((total, item) => total + item.estSeconds, 0);
}

/** 轮流从各队列取一项，直到全部取完。 */
function interleave(queues: PoolItem[][]): PoolItem[] {
  const result: PoolItem[] = [];
  const cursors = queues.map(() => 0);
  while (result.length < queues.reduce((n, q) => n + q.length, 0)) {
    queues.forEach((queue, i) => {
      const item = queue[cursors[i]!];
      if (item) {
        result.push(item);
        cursors[i]! += 1;
      }
    });
  }
  return result;
}
