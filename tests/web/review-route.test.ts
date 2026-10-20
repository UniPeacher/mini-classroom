import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from '../../src/web/router';

/** 页面地址：每个页面可收藏、可刷新，回看页能在新标签页里还原要看的内容 */
describe('页面地址', () => {
  it('各页面的地址能原样解析回来', () => {
    const routes = [
      { name: 'today' },
      { name: 'learn' },
      { name: 'map' },
      { name: 'map', pointId: 'p1' },
      { name: 'topic', topicId: 't1' },
      { name: 'library' },
      { name: 'library', cheatsheetId: 'c1' },
      { name: 'settings' },
      { name: 'review', day: '2026-10-20' },
      { name: 'review', day: '2026-10-20', topicId: 'b8b65dc1-25c2-4f9e-be15-ef96f024e20d' },
    ] as const;
    for (const route of routes) {
      const parsed = parseRoute(routeHash(route));
      expect(Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined))).toEqual(route);
    }
  });

  it('不认识的地址、格式不对的日期回到今天', () => {
    for (const hash of ['', '#', '#/nope', '#/review', '#/review/20261020', '#/topics']) {
      expect(parseRoute(hash)).toEqual({ name: 'today' });
    }
  });
});
