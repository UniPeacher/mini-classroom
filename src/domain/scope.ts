/**
 * 一节微课堂的组装范围：全部、某个学科、某门课程。
 * 范围对新学、复习、抽查、重讲一起生效；范围外的到期复习不会混进来，也不会被标记为已复习。
 */
export type LearningScopeKind = 'all' | 'discipline' | 'course';

export interface LearningScope {
  kind: LearningScopeKind;
  /** kind 为 discipline / course 时是学科或课程的 id；kind 为 all 时忽略 */
  id?: string;
}

/** 默认范围：全部 */
export const ALL_SCOPE: LearningScope = { kind: 'all' };

/** 规整请求里的范围：未知 kind 和不带 id 的学科/课程范围当作全部 */
export function normalizeScope(scope: LearningScope | null | undefined): LearningScope {
  if (!scope || scope.kind === 'all') return { kind: 'all' };
  if (scope.kind === 'discipline' || scope.kind === 'course') {
    const id = scope.id?.trim();
    return id ? { kind: scope.kind, id } : { kind: 'all' };
  }
  return { kind: 'all' };
}

/** 两个范围是否相同（全部范围内 id 不参与比较） */
export function sameScope(left: LearningScope | null | undefined, right: LearningScope | null | undefined): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a.kind !== b.kind) return false;
  return a.kind === 'all' || a.id === b.id;
}

/** 范围是否覆盖某个知识点所属的课程与学科 */
export function scopeIncludes(scope: LearningScope, point: { courseId?: string | null; disciplineId?: string | null }): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'discipline') return !!scope.id && point.disciplineId === scope.id;
  return !!scope.id && point.courseId === scope.id;
}
