import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastScope, rememberScope, todayHash } from '../../src/web/router';

/** 地址里的 scope 是事实来源；这里只验证"上次明确选择"能被入口恢复 */
describe('侧栏回到今天时保持上次的学习范围', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('选过某门课后，今天页地址带着这门课', () => {
    rememberScope({ kind: 'course', id: 'c1' });
    expect(todayHash()).toBe('#/today?scope=course%3Ac1');
    expect(lastScope()).toEqual({ kind: 'course', id: 'c1' });
  });

  it('选过学科时同样保留', () => {
    rememberScope({ kind: 'discipline', id: 'd1' });
    expect(todayHash()).toBe('#/today?scope=discipline%3Ad1');
  });

  it('明确选了"全部"也会记住，不会被旧值悄悄覆盖', () => {
    rememberScope({ kind: 'course', id: 'c1' });
    rememberScope({ kind: 'all' });
    expect(lastScope()).toEqual({ kind: 'all' });
    expect(todayHash()).toBe('#/today');
  });

  it('没有记录时回到全部范围', () => {
    expect(lastScope()).toEqual({ kind: 'all' });
    expect(todayHash()).toBe('#/today');
  });

  it('损坏的记录不会让页面打不开，退回全部', () => {
    store.set('weiketang.lastScope', '{not json');
    expect(lastScope()).toEqual({ kind: 'all' });
    store.set('weiketang.lastScope', JSON.stringify({ kind: 'course' }));
    expect(lastScope()).toEqual({ kind: 'all' });
    store.set('weiketang.lastScope', JSON.stringify({ kind: 'nope', id: 'x' }));
    expect(lastScope()).toEqual({ kind: 'all' });
  });

  it('显式传入范围时以传入为准，不读存储', () => {
    rememberScope({ kind: 'course', id: 'c1' });
    expect(todayHash({ kind: 'course', id: 'c2' })).toBe('#/today?scope=course%3Ac2');
    expect(todayHash({ kind: 'all' })).toBe('#/today');
  });
});
