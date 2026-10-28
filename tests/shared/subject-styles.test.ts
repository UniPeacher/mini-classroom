import { describe, expect, it } from 'vitest';
import { appendStyle, assignTag, groupOfTag, hasOwnStyle, isSubjectStyleId, normalizeGroups, styleIdOfTag, SUBJECT_STYLE_INFO, SUBJECT_STYLES, withTagStyle } from '../../src/shared/subject-styles';

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

  it('未分组、未设置样式时按通用处理', () => {
    expect(styleIdOfTag({ groups: [] }, '西语')).toBe('default');
    expect(styleIdOfTag(undefined, '西语')).toBe('default');
    expect(styleIdOfTag({ groups: [] }, null)).toBe('default');
    expect(styleIdOfTag({ groups: [] }, undefined)).toBe('default');
  });

  it('标签跟随所属分组的风格', () => {
    const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动', '数字信号处理'] }];
    expect(styleIdOfTag({ groups }, '液压传动')).toBe('stem');
    expect(styleIdOfTag({ groups }, '数字信号处理')).toBe('stem');
    // 不在任何分组里的标签按通用处理
    expect(styleIdOfTag({ groups }, '西语')).toBe('default');
  });

  it('分组风格非法时退回通用', () => {
    const groups = [{ name: '理工科', styleId: 'not-a-style' as unknown as 'stem', subjects: ['液压传动'] }];
    expect(styleIdOfTag({ groups }, '液压传动')).toBe('default');
  });

  it('兼容旧版扁平映射：没有分组时仍按旧配置生效', () => {
    expect(styleIdOfTag({ groups: [], legacyStyles: { 西语: 'language' } }, '西语')).toBe('language');
    // 分组优先于旧配置
    const groups = [{ name: '语言', styleId: 'humanities' as const, subjects: ['西语'] }];
    expect(styleIdOfTag({ groups, legacyStyles: { 西语: 'language' } }, '西语')).toBe('humanities');
  });

  it('一个标签只能属于一个分组', () => {
    const groups = [
      { name: '甲', styleId: 'stem' as const, subjects: ['x'] },
      { name: '乙', styleId: 'language' as const, subjects: [] },
    ];
    const moved = assignTag(groups, 'x', '乙');
    expect(moved.find((g) => g.name === '甲')!.subjects).toEqual([]);
    expect(moved.find((g) => g.name === '乙')!.subjects).toEqual(['x']);
    // 传 null 表示从分组里移除
    expect(assignTag(moved, 'x', null).every((g) => !g.subjects.includes('x'))).toBe(true);
  });

  it('能查到标签所在的分组', () => {
    const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动'] }];
    expect(groupOfTag(groups, '液压传动')?.name).toBe('理工科');
    expect(groupOfTag(groups, '西语')).toBeNull();
    expect(groupOfTag(groups, null)).toBeNull();
  });

  it('清理分组：去掉空标签、重复标签和同名分组', () => {
    const cleaned = normalizeGroups([
      { name: ' 理工科 ', styleId: 'stem', subjects: ['液压传动', ' 液压传动 ', '', '  '] },
      { name: '理工科', styleId: 'language', subjects: ['重复名'] },
      { name: '  ', styleId: 'stem', subjects: ['空名'] },
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.name).toBe('理工科');
    expect(cleaned[0]!.subjects).toEqual(['液压传动']);
  });

  it('没有学科标签时不套用任何分组的预设', () => {
    const groups = [{ name: '语言', styleId: 'language' as const, subjects: ['西语'] }];
    expect(styleIdOfTag({ groups }, null)).toBe('default');
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

describe('标签可以单独覆盖分组风格', () => {
  const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动', '数字信号处理'] }];

  it('标签自己的风格优先于所属分组', () => {
    const settings = { groups, tagStyles: { 液压传动: 'programming' } };
    expect(styleIdOfTag(settings, '液压传动')).toBe('programming');
    // 同组另一个标签仍然跟随分组
    expect(styleIdOfTag(settings, '数字信号处理')).toBe('stem');
  });

  it('能判断标签是否用了自己的覆盖', () => {
    const settings = { groups, tagStyles: { 液压传动: 'programming' } };
    expect(hasOwnStyle(settings, '液压传动')).toBe(true);
    expect(hasOwnStyle(settings, '数字信号处理')).toBe(false);
    expect(hasOwnStyle(undefined, '液压传动')).toBe(false);
  });

  it('取消覆盖后重新跟随分组', () => {
    const before = withTagStyle({ 液压传动: 'programming' }, '液压传动', null);
    expect(before).toEqual({});
    expect(styleIdOfTag({ groups, tagStyles: before }, '液压传动')).toBe('stem');
  });

  it('设置覆盖不影响其他标签的覆盖', () => {
    const next = withTagStyle({ 液压传动: 'programming' }, '数字信号处理', 'arts');
    expect(next).toEqual({ 液压传动: 'programming', 数字信号处理: 'arts' });
    expect(withTagStyle(undefined, 'x', 'stem')).toEqual({ x: 'stem' });
  });
});
