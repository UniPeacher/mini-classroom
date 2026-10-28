import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '../../src/settings';
import type { UserSettings } from '../../src/web/api';
import { ContentGuidanceSettings, GuidancePreviewCard, PresetCatalog } from '../../src/web/screens/ContentGuidanceSettings';

const defaults = {
  tutorialGuidance: '先说明这个知识有什么用。\n\n用具体案例解释关键关系。',
  figureGuidance: '根据学习目标选择配图形式。\n\n可以组合整体场景与局部细节。',
};

const presets = [
  { id: 'default', label: '通用', description: '通用讲法', tutorial: '', figure: '' },
  { id: 'stem', label: '理工科', description: '重推导', tutorial: '## 要求\n- 先说明符号单位', figure: '- 结构图' },
];

function render(patch: Partial<UserSettings> = {}) {
  return renderToStaticMarkup(createElement(ContentGuidanceSettings, {
    settings: { ...DEFAULT_USER_SETTINGS, tutorialGuidance: null, figureGuidance: null, ...patch },
    defaults,
    maxLength: 12000,
    presets,
    onSaved: () => {},
  }));
}

describe('共用表达规则', () => {
  it('只编辑全局教程与配图两份引导词，并展示完整默认内容', () => {
    const html = render();
    expect(html.match(/<textarea\b/g)).toHaveLength(2);
    expect(html).toContain('教程引导词</label>');
    expect(html).toContain('配图引导词</label>');
    expect(html).toContain(defaults.tutorialGuidance);
    expect(html).toContain(defaults.figureGuidance);
    expect(html.match(/使用默认/g)).toHaveLength(2);
    expect(html).toMatch(/maxlength="12000"/i);
    expect(html).toContain('共用表达规则');
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
    expect(html).toContain('尚未开始的课程');
    expect(html).toContain('正在学习的课程和历史记录保持原样');
    expect(html).toContain('模型调用费用');
    expect(html).toContain('学科教学要求');
  });

  it('预设目录可浏览全文，且不包含任何保存或选择动作', () => {
    const html = renderToStaticMarkup(createElement(PresetCatalog, { presets }));
    expect(html).toContain('教学预设目录');
    expect(html).toContain('理工科');
    expect(html).toContain('先说明符号单位');
    expect(html).toContain('浏览不会更改保存的配置');
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/<input/);
  });
});

/**
 * 回归：课程预览必须显示服务端给出的真实课程与学科，
 * 不能在缺少嵌套字段时回落到"未归类"一类默认值。
 */
describe('实际教学引导词的来源', () => {
  it('课程配置照服务端字段显示学科 / 课程与预设', () => {
    const html = renderToStaticMarkup(createElement(GuidancePreviewCard, {
      guidance: {
        courseId: 'c1',
        courseName: '液压传动',
        disciplineId: 'd1',
        disciplineName: '理工科',
        presetId: 'stem',
        presetLabel: '理工科',
        tutorialGuidance: '共用规则\n\n## 学科补充要求：理工科',
        figureGuidance: '- 结构图',
        fingerprint: 'abcdef1234567890',
      },
    }));
    expect(html).toContain('来源：理工科 / 液压传动');
    expect(html).toContain('预设「理工科」');
    expect(html).toContain('data-guidance-course="c1"');
    expect(html).toContain('学科补充要求：理工科');
    expect(html).not.toContain('未归类');
  });

  it('未归类配置显示服务端给的名字，不冒充某门课程', () => {
    const html = renderToStaticMarkup(createElement(GuidancePreviewCard, {
      guidance: {
        courseId: null,
        courseName: '未归类',
        disciplineId: null,
        disciplineName: null,
        presetId: 'default',
        presetLabel: '通用',
        tutorialGuidance: '共用规则',
        figureGuidance: '配图规则',
        fingerprint: 'ffffffffffffffff',
      },
    }));
    expect(html).toContain('来源：未归类');
    expect(html).toContain('预设「通用」');
    expect(html).toContain('data-guidance-course="unclassified"');
    expect(html).not.toContain('液压传动');
  });

  it('缺名称字段时如实留空，不补默认值掩盖来源', () => {
    const html = renderToStaticMarkup(createElement(GuidancePreviewCard, {
      guidance: {
        courseId: 'c9',
        courseName: '',
        disciplineId: null,
        disciplineName: null,
        presetId: 'stem',
        presetLabel: '理工科',
        tutorialGuidance: 'x',
        figureGuidance: 'y',
        fingerprint: '0'.repeat(16),
      },
    }));
    expect(html).toContain('来源： · 预设「理工科」');
  });
});
