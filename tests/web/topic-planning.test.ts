import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TopicDraft } from '../../src/web/api';
import { NewTopicForm } from '../../src/web/screens/HomeScreen';
import { TopicPlanConfirmation } from '../../src/web/screens/TopicPlanningScreen';

const draft: TopicDraft = {
  id: 'draft', idea: '想学 Python', revision: 3, topicId: null,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
  messages: [{ role: 'user', content: '我想整理销售报表' }, { role: 'assistant', content: '请核对目标' }],
  brief: { goal: '独立整理销售报表', background: '会 Excel', scope: ['读取数据', '汇总销售额'] },
};

function render(current = draft, options: { busy?: boolean; confirming?: boolean; hasUnsentMessage?: boolean } = {}) {
  return renderToStaticMarkup(createElement(TopicPlanConfirmation, {
    draft: current, busy: false, confirming: false, hasUnsentMessage: false,
    onConfirm: () => {}, onCorrect: () => {}, ...options,
  }));
}

/** 确认前可核对实际目的和范围；不能在等待回复或输入了纠正时确认过时摘要。 */
describe('主题目标确认界面', () => {
  it('展示目的、范围、基础及确认后生成名称的说明，同时保留继续纠正入口', () => {
    const html = render();
    for (const text of ['独立整理销售报表', '读取数据', '汇总销售额', '会 Excel', '确认后会生成主题名称', '确认并加入学习计划', '我想再调整']) expect(html).toContain(text);
    expect(html).not.toContain('disabled');
  });

  it('没有摘要、正在等待回复或已经加入计划时不展示确认入口', () => {
    expect(render({ ...draft, brief: null })).toBe('');
    expect(render({ ...draft, messages: [...draft.messages, { role: 'user', content: '换个目标' }] })).toBe('');
    expect(render({ ...draft, topicId: 'topic' })).toBe('');
  });

  it('用户还有未发送的纠正时禁用确认，提醒先发送', () => {
    const html = render(draft, { hasUnsentMessage: true });
    expect(html).toContain('你还有未发送的补充');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认并加入学习计划/);
  });

  it('正在确认时显示生成名称，阻止重复操作', () => {
    const html = render(draft, { busy: true, confirming: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>正在生成主题名称/);
  });

  it('未知基础如实显示，首页初始想法允许超过最终主题名称长度', () => {
    expect(render({ ...draft, brief: { ...draft.brief!, background: '' } })).toContain('尚未说明');
    const html = renderToStaticMarkup(createElement(NewTopicForm));
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('想解决的问题');
  });
});
