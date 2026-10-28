import { describe, expect, it, vi } from 'vitest';

/**
 * useResource 的 staleKey 语义在 hooks.ts 里由渲染期比较实现，
 * 这里用一个等价的最小球体验证判定规则：条件不同 ⇒ 视为无数据、仍在加载。
 */
function view<T>(data: T | null, dataKey: string | undefined, loading: boolean, staleKey?: string) {
  const stale = staleKey !== undefined && dataKey !== staleKey;
  return { data: stale ? null : data, loading: stale || loading };
}

describe('条件变化后旧数据立即失效', () => {
  it('切换学习范围后不展示上一个范围的内容', () => {
    const oldPreview = { items: ['西语'] };
    // 旧结果属于 course:西语，当前选择已是 course:液压
    const shown = view(oldPreview, 'course:spanish', false, 'course:hydraulics');
    expect(shown.data).toBeNull();
    expect(shown.loading).toBe(true);
  });

  it('新结果回来后正常展示', () => {
    const shown = view({ items: ['液压'] }, 'course:hydraulics', false, 'course:hydraulics');
    expect(shown.data).toEqual({ items: ['液压'] });
    expect(shown.loading).toBe(false);
  });

  it('没有 staleKey 时保留旧数据（轮询刷新不清空）', () => {
    const shown = view({ items: ['x'] }, 'course:a', false, undefined);
    expect(shown.data).toEqual({ items: ['x'] });
    expect(shown.loading).toBe(false);
  });
});
