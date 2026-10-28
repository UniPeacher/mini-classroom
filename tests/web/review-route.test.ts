import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, scopeParam } from '../../src/web/router';

/** 页面地址：每个页面可收藏、可刷新，回看页能在新标签页里还原要看的内容 */
describe('页面地址', () => {
  it('各页面的地址能原样解析回来', () => {
    const routes = [
      { name: 'home' },
      { name: 'today', scope: { kind: 'all' } },
      { name: 'today', scope: { kind: 'discipline', id: 'd1' } },
      { name: 'today', scope: { kind: 'course', id: 'c1' } },
      { name: 'learn' },
      { name: 'map' },
      { name: 'map', pointId: 'p1' },
      { name: 'topic', topicId: 't1' },
      { name: 'topic-draft', draftId: 'draft-1' },
      { name: 'library' },
      { name: 'library', cheatsheetId: 'c1' },
      { name: 'organization' },
      { name: 'organization', disciplineId: 'd1' },
      { name: 'organization', courseId: 'c1' },
      { name: 'organization', unclassified: true },
      { name: 'settings' },
      { name: 'personalization', tab: 'learning' },
      { name: 'personalization', tab: 'prompts' },
      { name: 'review', day: '2026-10-20' },
      { name: 'review', day: '2026-10-20', topicId: 'b8b65dc1-25c2-4f9e-be15-ef96f024e20d' },
    ] as const;
    for (const route of routes) {
      const parsed = parseRoute(routeHash(route));
      expect(Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined))).toEqual(route);
    }
  });

  it('首页和今天有独立地址，刷新时各自恢复', () => {
    expect(routeHash({ name: 'home' })).toBe('#/');
    expect(routeHash({ name: 'today', scope: { kind: 'all' } })).toBe('#/today');
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/today')).toEqual({ name: 'today', scope: { kind: 'all' } });
  });

  it('不认识的地址、格式不对的日期回到首页', () => {
    for (const hash of ['', '#', '#/nope', '#/review', '#/review/20261020', '#/topics', '#/topic-drafts']) {
      expect(parseRoute(hash)).toEqual({ name: 'home' });
    }
  });

  it('个性化的两个标签有独立地址，刷新后保持当前分类', () => {
    expect(routeHash({ name: 'personalization', tab: 'learning' })).toBe('#/personalization');
    expect(routeHash({ name: 'personalization', tab: 'prompts' })).toBe('#/personalization/prompts');
    expect(parseRoute('#/personalization')).toEqual({ name: 'personalization', tab: 'learning' });
    expect(parseRoute('#/personalization/prompts')).toEqual({ name: 'personalization', tab: 'prompts' });
    expect(parseRoute('#/personalization/unknown')).toEqual({ name: 'personalization', tab: 'learning' });
  });

  it('学习范围随今天页地址保留，返回时不用重新选择', () => {
    expect(scopeParam({ kind: 'all' })).toBeUndefined();
    expect(scopeParam({ kind: 'course', id: 'c1' })).toBe('course:c1');
    expect(routeHash({ name: 'today', scope: { kind: 'course', id: 'c1' } })).toBe('#/today?scope=course%3Ac1');
    expect(parseRoute('#/today?scope=course%3Ac1')).toEqual({ name: 'today', scope: { kind: 'course', id: 'c1' } });
    expect(parseRoute('#/today?scope=discipline%3Ad1')).toEqual({ name: 'today', scope: { kind: 'discipline', id: 'd1' } });
    // 损坏或空范围退回全部，而不是让页面打不开
    expect(parseRoute('#/today?scope=course')).toEqual({ name: 'today', scope: { kind: 'all' } });
    expect(parseRoute('#/today?scope=unknown%3Ax')).toEqual({ name: 'today', scope: { kind: 'all' } });
  });

  it('学科与课程页可以分别定位学科、课程、未归类', () => {
    expect(routeHash({ name: 'organization' })).toBe('#/organization');
    expect(parseRoute('#/organization?discipline=d1')).toEqual({ name: 'organization', disciplineId: 'd1' });
    expect(parseRoute('#/organization?course=c1')).toEqual({ name: 'organization', courseId: 'c1' });
    expect(parseRoute('#/organization?view=unclassified')).toEqual({ name: 'organization', unclassified: true });
  });
});
