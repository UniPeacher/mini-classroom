import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '../../src/settings';
import type { UserSettings } from '../../src/web/api';
import { ContentGuidanceSettings } from '../../src/web/screens/ContentGuidanceSettings';

const defaults = {
  tutorialGuidance: '先说明这个知识有什么用。\n\n用具体案例解释关键关系。',
  figureGuidance: '根据学习目标选择配图形式。\n\n可以组合整体场景与局部细节。',
};

function render(patch: Partial<UserSettings> = {}) {
  return renderToStaticMarkup(createElement(ContentGuidanceSettings, {
    settings: { ...DEFAULT_USER_SETTINGS, tutorialGuidance: null, figureGuidance: null, ...patch },
    defaults,
    maxLength: 12000,
    onSaved: () => {},
  }));
}

describe('内容生成偏好', () => {
  it('仅提供教程和配图两个编辑区，并展示完整默认引导词', () => {
    const html = render();
    expect(html.match(/<textarea\b/g)).toHaveLength(2);
    expect(html).toContain('教程引导词</label>');
    expect(html).toContain('配图引导词</label>');
    expect(html).toContain(defaults.tutorialGuidance);
    expect(html).toContain(defaults.figureGuidance);
    expect(html.match(/使用默认/g)).toHaveLength(2);
    expect(html).toMatch(/maxlength="12000"/i);
  });

  it('已保存的自定义内容只替换对应一项，并为两项保留独立恢复默认入口', () => {
    const html = render({ tutorialGuidance: '用工作中的实例先讲结论，再讲原因。' });
    expect(html).toContain('用工作中的实例先讲结论，再讲原因。');
    expect(html).not.toContain(defaults.tutorialGuidance);
    expect(html).toContain(defaults.figureGuidance);
    expect(html).toContain('aria-label="恢复默认教程引导词"');
    expect(html).toContain('aria-label="恢复默认配图引导词"');
    expect(html.match(/使用默认/g)).toHaveLength(1);
  });

  it('没有修改时禁止重复保存，并说明生效范围和重新准备课程的影响', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存引导词<\/button>/);
    expect(html).toContain('新生成的讲解、复习材料及其中的配图');
    expect(html).toContain('尚未开始的课程');
    expect(html).toContain('正在学习的课程和历史记录保持原样');
    expect(html).toContain('模型调用费用');
  });
});
