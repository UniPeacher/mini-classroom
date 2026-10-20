/** 摸底诊断用到的知识点信息 */
export interface PlacementPoint {
  id: string;
  position: number;
  prerequisiteIds: string[];
}

/** 一道摸底题的作答：选"不知道"与答错一样视为未学，但不算误解 */
export interface PlacementAnswer {
  pointId: string;
  result: 'correct' | 'wrong' | 'unknown';
}

export type PlacementResult = 'correct' | 'inferred' | 'unknown';

/** 摸底最多出几道题 */
export const MAX_PLACEMENT_QUESTIONS = 10;
/** 预先生成几道候选题，作答时从中自适应挑选 */
export const PROBE_COUNT = 12;

/** 所有前置（直接和间接） */
function ancestors(points: PlacementPoint[], id: string): Set<string> {
  const byId = new Map(points.map((p) => [p.id, p]));
  const found = new Set<string>();
  const stack = [...(byId.get(id)?.prerequisiteIds ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (found.has(next)) continue;
    found.add(next);
    stack.push(...(byId.get(next)?.prerequisiteIds ?? []));
  }
  return found;
}

/** 所有以它为前置的后续知识点（直接和间接） */
function descendants(points: PlacementPoint[], id: string): Set<string> {
  return new Set(points.filter((p) => ancestors(points, p.id).has(id)).map((p) => p.id));
}

/** 前置链的深度：没有前置为 0 */
function depth(points: PlacementPoint[], id: string, memo = new Map<string, number>()): number {
  if (memo.has(id)) return memo.get(id)!;
  const point = points.find((p) => p.id === id);
  const value = point && point.prerequisiteIds.length > 0 ? 1 + Math.max(...point.prerequisiteIds.map((pre) => depth(points, pre, memo))) : 0;
  memo.set(id, value);
  return value;
}

/** 选出预先生成摸底题的知识点：按前置深度和推荐顺序排好，从头到尾均匀取，覆盖从基础到进阶 */
export function chooseProbePoints(points: PlacementPoint[], count = PROBE_COUNT): string[] {
  const memo = new Map<string, number>();
  const ordered = [...points].sort((a, b) => depth(points, a.id, memo) - depth(points, b.id, memo) || a.position - b.position);
  if (ordered.length <= count) return ordered.map((p) => p.id);
  return Array.from({ length: count }, (_, i) => ordered[Math.round((i * (ordered.length - 1)) / (count - 1))]!.id);
}

/**
 * 由作答推断：答对的知识点及其全部前置视为已会；答错或不知道的知识点及其全部后续视为未学。
 * 两边冲突时（答对了某个知识点的后续，却答错了它本身），以直接作答为准。
 */
export function inferKnowledge(points: PlacementPoint[], answers: PlacementAnswer[]) {
  const known = new Set<string>();
  const unknown = new Set<string>();
  for (const answer of answers) {
    if (answer.result === 'correct') {
      known.add(answer.pointId);
      for (const id of ancestors(points, answer.pointId)) known.add(id);
    } else {
      unknown.add(answer.pointId);
      for (const id of descendants(points, answer.pointId)) unknown.add(id);
    }
  }
  for (const answer of answers) {
    if (answer.result === 'correct') unknown.delete(answer.pointId);
    else known.delete(answer.pointId);
  }
  for (const id of known) unknown.delete(id);
  return { known, unknown };
}

/**
 * 下一道摸底题：在还没有定论的候选题里，选最能把剩余范围一分为二的那道
 * （它的前置与后续里尚未定论的知识点，两边数量越接近越好）。
 * 第一题从背景自述推断的起点里选最进阶的一个；没有起点时同样按二分选。
 * 已出满题数、或候选题都已有定论时返回 null。
 */
export function nextProbe(
  points: PlacementPoint[],
  probeIds: string[],
  answers: PlacementAnswer[],
  startIds: string[] = [],
  maxQuestions = MAX_PLACEMENT_QUESTIONS,
): string | null {
  if (answers.length >= maxQuestions) return null;
  const { known, unknown } = inferKnowledge(points, answers);
  const answered = new Set(answers.map((a) => a.pointId));
  const open = probeIds.filter((id) => !answered.has(id) && !known.has(id) && !unknown.has(id));
  if (open.length === 0) return null;

  if (answers.length === 0) {
    const starts = open.filter((id) => startIds.includes(id));
    if (starts.length > 0) {
      const memo = new Map<string, number>();
      return starts.sort((a, b) => depth(points, b, memo) - depth(points, a, memo))[0]!;
    }
  }

  const undecided = (ids: Set<string>) => [...ids].filter((id) => !known.has(id) && !unknown.has(id)).length;
  const score = (id: string) => Math.min(undecided(ancestors(points, id)), undecided(descendants(points, id)));
  const position = new Map(points.map((p) => [p.id, p.position]));
  return [...open].sort((a, b) => score(b) - score(a) || (position.get(a) ?? 0) - (position.get(b) ?? 0))[0]!;
}

/** 摸底结束后每个知识点的结论：直接答对、推断掌握，或按未学处理（包括没能推断的） */
export function placementResults(points: PlacementPoint[], answers: PlacementAnswer[]): Map<string, PlacementResult> {
  const { known } = inferKnowledge(points, answers);
  const correct = new Set(answers.filter((a) => a.result === 'correct').map((a) => a.pointId));
  return new Map(points.map((p) => [p.id, correct.has(p.id) ? 'correct' : known.has(p.id) ? 'inferred' : 'unknown']));
}
