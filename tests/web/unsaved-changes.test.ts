import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { UnsavedChangesDialog } from '../../src/web/components/UnsavedChangesDialog';
import { clearAllDirty, discardAndNavigate, hasUnsavedChanges, markDirty, requestNavigation, stayOnPage } from '../../src/web/drafts';
import { ImpactConfirm, needsImpactConfirm } from '../../src/web/screens/OrganizationScreen';

/** 未保存草稿只登记、不弹浏览器 confirm；离页时由页面内对话框给出"留下 / 丢弃"两个明确选择 */
describe('未保存修改的离开确认', () => {
  afterEach(() => {
    stayOnPage();
    clearAllDirty();
  });

  it('没有未保存修改时不显示对话框', () => {
    requestNavigation('#/settings');
    expect(renderToStaticMarkup(createElement(UnsavedChangesDialog))).toBe('');
  });

  it('有未保存修改时停在原页，对话框给出留下与丢弃两个明确选择', () => {
    markDirty(Symbol('draft'), '有未保存的修改');
    requestNavigation('#/settings');
    const html = renderToStaticMarkup(createElement(UnsavedChangesDialog));
    expect(html).toContain('还有未保存的修改');
    expect(html).toContain('留在此页');
    expect(html).toContain('放弃修改并离开');
    expect(html).toContain('role="alertdialog"');
  });

  it('放弃修改后登记清空，对话框关闭', () => {
    markDirty(Symbol('draft'), '有未保存的修改');
    requestNavigation('#/settings');
    discardAndNavigate();
    expect(hasUnsavedChanges()).toBe(false);
    expect(renderToStaticMarkup(createElement(UnsavedChangesDialog))).toBe('');
  });

  it('留在此页后草稿仍在，可以继续编辑', () => {
    markDirty(Symbol('draft'), '有未保存的修改');
    requestNavigation('#/settings');
    stayOnPage();
    expect(hasUnsavedChanges()).toBe(true);
    expect(renderToStaticMarkup(createElement(UnsavedChangesDialog))).toBe('');
  });
});

/** 影响确认：保存前把会重新准备的内容数量和模型调用代价说清楚 */
describe('保存前的影响确认', () => {
  it('列出受影响课程、主题和待重备内容，并提示模型调用', () => {
    const html = renderToStaticMarkup(createElement(ImpactConfirm, {
      impact: {
        affectedCourses: 2,
        affectedTopics: 5,
        affectedItems: 12,
        modelCalls: true,
        estimatedModelCalls: 12,
      },
      saving: false,
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(html).toContain('2 门课程');
    expect(html).toContain('5 个学习主题');
    expect(html).toContain('12 项尚未开始的内容');
    // 不承诺精确次数，只说明可能调用模型
    expect(html).toContain('可能会调用模型');
    expect(html).not.toMatch(/约 d+ 次/);
    expect(html).toContain('确认并保存');
    expect(html).toContain('确认并保存');
    expect(html).toContain('取消');
  });

  it('保存中禁用两个按钮，避免重复提交', () => {
    const html = renderToStaticMarkup(createElement(ImpactConfirm, {
      impact: { affectedCourses: 0, affectedTopics: 1, affectedItems: 1, modelCalls: true },
      saving: true,
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain('保存中…');
  });
});

/** 没有待学内容可作废时不该弹确认：改名、换到相同预设都要直接保存 */
describe('影响确认的触发条件', () => {
  it('零待学内容且不调用模型时不需要确认', () => {
    expect(needsImpactConfirm({ affectedCourses: 3, affectedTopics: 8, affectedItems: 0, modelCalls: false })).toBe(false);
    expect(needsImpactConfirm({ affectedCourses: 0, affectedTopics: 0, affectedItems: 0, modelCalls: false })).toBe(false);
  });

  it('有待学内容或可能调用模型时需要确认', () => {
    expect(needsImpactConfirm({ affectedCourses: 1, affectedTopics: 2, affectedItems: 4, modelCalls: true })).toBe(true);
    expect(needsImpactConfirm({ affectedCourses: 1, affectedTopics: 2, affectedItems: 0, modelCalls: true })).toBe(true);
  });
});
