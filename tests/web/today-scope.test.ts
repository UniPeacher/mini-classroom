import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LearningScope, Preview } from '../../src/web/api';
import { ActionArea, NextContents } from '../../src/web/screens/TodayScreen';

const ready: Preview = {
  open: null, capped: false, sessionsToday: 0, dailySessionCap: 3, preparing: false,
  newPaused: false, dueCount: 2, counts: { review: 2, contrast: 0, spotCheck: 0, advance: 0, new: 1 },
  estMinutes: 9, budgetMinutes: 10,
  items: [{ title: '液压泵的流量', topicTitle: '液压传动', purpose: 'review', formLabel: '选择题' }],
};

const scope: LearningScope = { kind: 'course', id: 'c1' };

function render(preview: Preview | null, options: { hasTopics?: boolean; scopeName?: string } = {}) {
  return renderToStaticMarkup(createElement(ActionArea, {
    preview,
    hasTopics: options.hasTopics ?? true,
    scope,
    scopeName: options.scopeName ?? '理工科 / 液压传动',
    snapshot: null,
    onRetry: async () => {},
    onStart: () => {},
  }));
}

/** 今天页：范围只作用于新课堂；未完成的一节单独出现，不静默替换 */
describe('今天的学习操作', () => {
  it('准备就绪时按当前范围开始，并说明范围外的到期复习', () => {
    const html = render({ ...ready, outsideDueCount: 4 });
    expect(html).toContain('开始这一节 · 约 9 分钟');
    expect(html).toContain('构建新一节');
    expect(html).toContain('范围外还有 4 个到期复习');
  });

  it('有未完成的一节时显示续课面板，并写明原范围', () => {
    const preview: Preview = {
      ...ready,
      open: {
        id: 'open', startedAt: '2026-10-23T00:00:00Z',
        scope: { kind: 'discipline', id: 'd1', label: '理工科' },
        items: [
          { ...ready.items[0]!, done: true, excluded: false },
          { ...ready.items[0]!, title: '还没做的一项', done: false, excluded: false },
        ],
      },
    };
    const html = render(preview);
    expect(html).toContain('继续上次课堂');
    expect(html).toContain('原范围：理工科');
    expect(html).toContain('还没做的一项');
    expect(html).toContain('不会替换它');
    // 开新一节必须先确认
    expect(html).toContain('按新范围开始');
    expect(html).not.toContain('开始这一节 · 约');
  });

  it('达到每日上限时只提示调整上限，不显示开始按钮', () => {
    const html = render({ ...ready, capped: true, sessionsToday: 3 });
    expect(html).toContain('今天已学满 3 节');
    expect(html).toContain('href="#/personalization"');
    expect(html).not.toContain('开始这一节');
  });

  it('没有学习主题时引导先添加主题', () => {
    const html = render(ready, { hasTopics: false });
    expect(html).toContain('还没有学习主题');
    expect(html).toContain('href="#/"');
    expect(html).not.toContain('开始这一节');
  });

  it('预览加载中先给骨架，不冒充已准备好', () => {
    const html = render(null);
    expect(html).toContain('skeleton');
    expect(html).not.toContain('开始这一节');
  });
});

/** 续课面板与"这一节会学什么"必须各用各的内容，不能互相顶替 */
describe('今天页的两块内容互不顶替', () => {
  it('有未完成的一节时，预览区仍只显示当前范围的内容', () => {
    const preview: Preview = {
      ...ready,
      open: {
        id: 'open', startedAt: '2026-10-23T00:00:00Z',
        scope: { kind: 'course', id: 'spanish', label: '语言 / 西班牙语' },
        items: [{ ...ready.items[0]!, title: '旧范围里还没做的一项', done: false, excluded: false }],
      },
      items: [{ ...ready.items[0]!, title: '新范围会学的内容' }],
    };
    const html = renderToStaticMarkup(createElement(NextContents, { preview, scopeName: '理工科 / 液压传动' }));
    // 预览区不显示未完成课堂的内容
    expect(html).not.toContain('旧范围里还没做的一项');
    expect(html).not.toContain('上一节的进度');
    // 只显示按当前范围挑好的内容，并标明范围
    expect(html).toContain('新范围会学的内容');
    expect(html).toContain('理工科 / 液压传动');
    expect(html).toContain('这一节会学什么');
  });

  it('达到上限时预览区清空，而不是转为显示未完成的内容', () => {
    const preview: Preview = { ...ready, capped: true, open: { id: 'o', startedAt: '2026-10-23T00:00:00Z', items: [{ ...ready.items[0]!, title: '不该出现在这里', done: false, excluded: false }] } };
    const html = renderToStaticMarkup(createElement(NextContents, { preview, scopeName: '全部范围' }));
    expect(html).not.toContain('不该出现在这里');
    expect(html).toContain('今天已达到学习上限');
  });
});
