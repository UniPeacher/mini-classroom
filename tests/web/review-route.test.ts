import { describe, expect, it } from 'vitest';
import { parseReviewHash, reviewHash } from '../../src/web/DayReview';

/** 回看页在新标签页打开，靠地址里的日期和主题还原要看的内容 */
describe('回看页地址', () => {
  it('全部主题：只带日期', () => {
    expect(reviewHash({ day: '2026-10-20' })).toBe('#/review/2026-10-20');
    expect(parseReviewHash('#/review/2026-10-20')).toEqual({ day: '2026-10-20', topicId: undefined });
  });

  it('单个主题：生成的地址能原样解析回来', () => {
    const route = { day: '2026-10-20', topicId: 'b8b65dc1-25c2-4f9e-be15-ef96f024e20d' };
    expect(parseReviewHash(reviewHash(route))).toEqual(route);
  });

  it('不是回看页的地址返回 null', () => {
    for (const hash of ['', '#', '#/review', '#/review/20261020', '#/review/2026-10-20/extra', '#/topic/x']) {
      expect(parseReviewHash(hash)).toBeNull();
    }
  });
});
