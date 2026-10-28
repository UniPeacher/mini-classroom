import { describe, expect, it } from 'vitest';
import { appendStyle, isSubjectStyleId, styleIdOf, SUBJECT_STYLE_INFO, SUBJECT_STYLES } from '../../src/shared/subject-styles';

/** 学科预设只追加，不替换通用写作原则；未设置时行为与改动前一致 */
describe('学科内容风格预设', () => {
  it('每个预设都有名称和适用说明', () => {
    for (const id of SUBJECT_STYLES) {
      const style = SUBJECT_STYLE_INFO[id];
      expect(style.id).toBe(id);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.description.length).toBeGreaterThan(0);
    }
  });

  it('通用风格不追加任何内容，回到改动前的行为', () => {
    expect(SUBJECT_STYLE_INFO.default.tutorial).toBeUndefined();
    expect(SUBJECT_STYLE_INFO.default.figure).toBeUndefined();
  });

  it('除通用外的预设都写了教程与配图要求', () => {
    for (const id of SUBJECT_STYLES.filter((s) => s !== 'default')) {
      expect(SUBJECT_STYLE_INFO[id].tutorial?.trim().length).toBeGreaterThan(0);
      expect(SUBJECT_STYLE_INFO[id].figure?.trim().length).toBeGreaterThan(0);
    }
  });

  it('未设置学科的样式时按通用处理', () => {
    expect(styleIdOf({}, '西语')).toBe('default');
    expect(styleIdOf(undefined, '西语')).toBe('default');
    expect(styleIdOf({}, null)).toBe('default');
    expect(styleIdOf({}, undefined)).toBe('default');
  });

  it('读取已设置的样式；值非法时退回通用', () => {
    expect(styleIdOf({ 西语: 'language' }, '西语')).toBe('language');
    expect(styleIdOf({ 西语: 'not-a-style' }, '西语')).toBe('default');
  });

  it('没有学科标签时不套用任何学科的预设', () => {
    expect(styleIdOf({ 西语: 'language' }, null)).toBe('default');
  });

  it('追加风格时保留全部通用原则，只在其后接上学科要求', () => {
    const base = '## 通用原则\n- 句子不超过 30 字。';
    const out = appendStyle(base, '## 学科补充\n- 公式要写单位。');
    expect(out).toContain('句子不超过 30 字');
    expect(out).toContain('公式要写单位');
    expect(out.indexOf('通用原则')).toBeLessThan(out.indexOf('学科补充'));
  });

  it('没有追加内容时原样返回，不加多余空行', () => {
    expect(appendStyle('内容', undefined)).toBe('内容');
    expect(appendStyle('内容', '   ')).toBe('内容');
  });

  it('风格判定只接受已知的预设名', () => {
    expect(isSubjectStyleId('language')).toBe(true);
    expect(isSubjectStyleId('quantum')).toBe(false);
    expect(isSubjectStyleId(null)).toBe(false);
  });
});
