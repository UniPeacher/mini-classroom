import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Preview } from '../../src/web/api';
import { SessionContents } from '../../src/web/components/SessionPreview';
import { HomeLearning } from '../../src/web/screens/HomeScreen';

const ready: Preview = {
  open: null, capped: false, sessionsToday: 0, dailySessionCap: 2, preparing: false,
  newPaused: false, dueCount: 1, counts: { review: 1, contrast: 0, spotCheck: 0, advance: 0, new: 1 },
  estMinutes: 8, budgetMinutes: 10,
  items: [
    { title: '区分 any 和 unknown', topicTitle: 'TypeScript', purpose: 'review', formLabel: '选择题' },
    { title: '类型守卫', topicTitle: 'TypeScript', purpose: 'new', formLabel: '图解' },
  ],
};

function render(preview: Preview | null, options: { error?: string; hasTopics?: boolean | null } = {}) {
  return renderToStaticMarkup(createElement(HomeLearning, {
    preview, error: options.error ?? '', hasTopics: options.hasTopics ?? true,
    onRetry: () => {}, onStart: () => {},
  }));
}

/** 首页先说明此刻可学的内容，再给出真实可用的操作；空、忙、失败不能冒充已就绪。 */
describe('首页的今日学习入口', () => {
  it('已准备好时同时显示具体知识点、主题、预计用时和开始入口', () => {
    const html = render(ready);
    for (const text of ['区分 any 和 unknown', '类型守卫', 'TypeScript', '约 8 分钟', '开始今天的学习']) expect(html).toContain(text);
    expect(html).toContain('1 道复习、1 个新知识点');
    expect(html).toContain('href="#/today"');
  });

  it('达到每日上限时不承诺还能开始候选池中的内容', () => {
    const html = render({ ...ready, capped: true, sessionsToday: 2 });
    expect(html).toContain('今天已学完');
    expect(html).toContain('回看今天所学');
    expect(html).not.toContain('开始今天的学习');
    expect(html).not.toContain('类型守卫');
  });

  it('恢复未完成的一节优先于开新一节，只预览尚待完成且未排除的内容', () => {
    const preview: Preview = { ...ready, capped: true, open: {
      id: 'open', startedAt: '2026-10-23T00:00:00Z', scope: { kind: 'course', id: 'c1', label: '理工科 / 液压传动' }, items: [
        { ...ready.items[0]!, title: '已完成的内容', done: true, excluded: false },
        { ...ready.items[0]!, title: '已排除的内容', done: true, excluded: true },
        { ...ready.items[1]!, title: '尚待学习的内容', done: false, excluded: false },
      ],
    } };
    const html = render(preview);
    expect(html).toContain('继续这一节');
    expect(html).toContain('还剩 1 项');
    expect(html).toContain('尚待学习的内容');
    // 续课面板要显示原始范围，不能让用户以为按当前选择恢复
    expect(html).toContain('原范围：理工科 / 液压传动');
    expect(html).not.toContain('已完成的内容');
    expect(html).not.toContain('已排除的内容');
    expect(html).not.toContain('约 8 分钟');
    const today = renderToStaticMarkup(createElement(SessionContents, { preview, source: 'open' }));
    expect(today).toContain('已完成的内容');
    expect(today).toContain('已排除的内容');
    expect(today).toContain('不学');
  });

  it('已答完但尚未结束的一节仍可进入结果页', () => {
    const html = render({ ...ready, open: { id: 'open', startedAt: '2026-10-23T00:00:00Z', items: ready.items.map(item => ({ ...item, done: true, excluded: false })) } });
    expect(html).toContain('查看本节结果');
    expect(html).not.toContain('开始今天的学习');
  });

  it('没有主题时引导添加主题，不展示无效的开始按钮', () => {
    const html = render({ ...ready, items: [] }, { hasTopics: false });
    expect(html).toContain('添加主题');
    expect(html).toContain('摸底');
    expect(html).not.toContain('开始今天的学习');
  });

  it('准备中会说明后台状态，不把构建操作伪装成已经备好的学习', () => {
    const html = render({ ...ready, items: [], preparing: true });
    expect(html).toContain('正在准备');
    expect(html).not.toContain('开始今天的学习');
  });

  it('首次加载和加载失败有不同反馈，失败时可以重试', () => {
    expect(render(null)).toContain('正在读取');
    const failed = render(null, { error: '服务暂时不可用' });
    expect(failed).toContain('服务暂时不可用');
    expect(failed).toContain('重新加载');
    expect(failed).not.toContain('开始今天的学习');
  });

  it('刷新失败后不把上一次预览当作当前可开始的安排', () => {
    const html = render(ready, { error: '网络断开' });
    expect(html).toContain('重新加载');
    expect(html).not.toContain('开始今天的学习');
  });
});
