import { describe, expect, it } from 'vitest';
import {
  appendStyle,
  assignTag,
  composeTeachingGuidance,
  DEFAULT_SUBJECT_STYLE,
  groupOfTag,
  hasOwnStyle,
  isSubjectStyleId,
  normalizeGroups,
  styleIdOfTag,
  SUBJECT_STYLE_INFO,
  SUBJECT_STYLES,
  subjectStyleVersion,
  withTagStyle,
} from '../../src/shared/subject-styles';
import { DEFAULT_CONTENT_GUIDANCE } from '../../src/shared/content-guidance';

describe('教学预设目录', () => {
  it('每个预设都有名称、适用说明和版本号', () => {
    for (const id of SUBJECT_STYLES) {
      const style = SUBJECT_STYLE_INFO[id];
      expect(style.id).toBe(id);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.description.length).toBeGreaterThan(0);
      expect(Number.isInteger(style.version)).toBe(true);
      expect(style.version).toBeGreaterThan(0);
    }
  });

  it('通用预设不追加任何内容，回到只有共用规则的行为', () => {
    expect(SUBJECT_STYLE_INFO.default.tutorial).toBeUndefined();
    expect(SUBJECT_STYLE_INFO.default.figure).toBeUndefined();
    expect(composeTeachingGuidance(DEFAULT_CONTENT_GUIDANCE, 'default')).toEqual(DEFAULT_CONTENT_GUIDANCE);
  });

  it('除通用外的预设都写了教程与配图要求', () => {
    for (const id of SUBJECT_STYLES.filter((s) => s !== 'default')) {
      expect(SUBJECT_STYLE_INFO[id].tutorial?.trim().length).toBeGreaterThan(0);
      expect(SUBJECT_STYLE_INFO[id].figure?.trim().length).toBeGreaterThan(0);
    }
  });

  it('未知预设的版本按 0 处理，不会让内容被判为最新', () => {
    expect(subjectStyleVersion('stem')).toBeGreaterThan(0);
    expect(subjectStyleVersion('nope' as never)).toBe(0);
  });

  it('合成结果始终保留共用规则，只在其后追加学科要求', () => {
    const merged = composeTeachingGuidance(DEFAULT_CONTENT_GUIDANCE, 'stem');
    expect(merged.tutorialGuidance).toContain(DEFAULT_CONTENT_GUIDANCE.tutorialGuidance.trimEnd());
    expect(merged.tutorialGuidance).toContain('学科补充要求：理工科');
    expect(merged.tutorialGuidance.indexOf(DEFAULT_CONTENT_GUIDANCE.tutorialGuidance.trimEnd()))
      .toBeLessThan(merged.tutorialGuidance.indexOf('学科补充要求'));
    expect(merged.figureGuidance).toContain(DEFAULT_CONTENT_GUIDANCE.figureGuidance.trimEnd());
    expect(merged.figureGuidance).toContain('理工科的图优先表达结构与过程');
  });

  it('未知预设退回通用，不会套用别的学科要求', () => {
    expect(composeTeachingGuidance(DEFAULT_CONTENT_GUIDANCE, 'quantum' as never)).toEqual(DEFAULT_CONTENT_GUIDANCE);
  });
});

describe('预设文案的质量约束', () => {
  const presetText = (id: (typeof SUBJECT_STYLES)[number]) =>
    `${SUBJECT_STYLE_INFO[id].tutorial ?? ''}\n${SUBJECT_STYLE_INFO[id].figure ?? ''}`;

  it('不写无法核验的绝对结论或编造引用', () => {
    for (const id of SUBJECT_STYLES) {
      const text = presetText(id);
      expect(text).not.toMatch(/百分之百|一定正确|无需核实|保证准确|研究证明|研究表明/);
      expect(text).not.toMatch(/参见《|第\s*\d+\s*条|(19|20)\d{2}\s*年修订/);
    }
  });

  it('语言预设要求例句保留目标语言原文，同时说明正文用中文', () => {
    const language = SUBJECT_STYLE_INFO.language.tutorial ?? '';
    expect(language).toContain('例句保留目标语言的原文');
    expect(language).toContain('讲解正文仍用简体中文');
    expect(language).not.toMatch(/例句.*翻译成中文/);
  });

  it('时效性学科要求标注适用条件并要求用户核验，不声称现行有效', () => {
    const business = SUBJECT_STYLE_INFO.business.tutorial ?? '';
    expect(business).toContain('适用地区和时间点');
    expect(business).toContain('自行核验');
    expect(business).not.toContain('现行规定');

    const law = SUBJECT_STYLE_INFO.law.tutorial ?? '';
    expect(law).toContain('不编造具体条文');
    expect(law).toContain('以现行有效文本为准');
    expect(law).not.toMatch(/本条现行有效/);

    const medicine = SUBJECT_STYLE_INFO.medicine.tutorial ?? '';
    expect(medicine).toContain('不构成诊疗建议');
    expect(medicine).toContain('最新指南为准');
  });

  it('人文学科不编造引文出处', () => {
    expect(SUBJECT_STYLE_INFO.humanities.tutorial ?? '').toContain('不编造引文');
  });
});

describe('追加与拼接', () => {
  it('追加风格时保留全部共用原则，只在其后接上学科要求', () => {
    const base = '## 共用原则\n- 句子不超过 30 字。';
    const out = appendStyle(base, '## 学科补充\n- 公式要写单位。');
    expect(out).toContain('句子不超过 30 字');
    expect(out).toContain('公式要写单位');
    expect(out.indexOf('共用原则')).toBeLessThan(out.indexOf('学科补充'));
  });

  it('没有追加内容时原样返回，不加多余空行', () => {
    expect(appendStyle('内容', undefined)).toBe('内容');
    expect(appendStyle('内容', '   ')).toBe('内容');
  });

  it('预设判定只接受已知的名字', () => {
    expect(isSubjectStyleId('language')).toBe(true);
    expect(isSubjectStyleId('quantum')).toBe(false);
    expect(isSubjectStyleId(null)).toBe(false);
  });
});

/**
 * 旧版组织方式（分组 / 逐标签覆盖 / 扁平映射）已不在运行期使用。
 * 这些测试只保留旧纯函数的判定语义，供升级迁移和迁移兼容性验证使用。
 */
describe('旧版风格判定（仅迁移兼容）', () => {
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
    expect(styleIdOfTag({ groups }, '西语')).toBe('default');
  });

  it('分组风格非法时退回通用', () => {
    const groups = [{ name: '理工科', styleId: 'not-a-style' as unknown as 'stem', subjects: ['液压传动'] }];
    expect(styleIdOfTag({ groups }, '液压传动')).toBe('default');
  });

  it('兼容旧版扁平映射：没有分组时仍按旧配置生效', () => {
    expect(styleIdOfTag({ groups: [], legacyStyles: { 西语: 'language' } }, '西语')).toBe('language');
    const groups = [{ name: '语言', styleId: 'humanities' as const, subjects: ['西语'] }];
    expect(styleIdOfTag({ groups, legacyStyles: { 西语: 'language' } }, '西语')).toBe('humanities');
  });

  it('标签自己的覆盖优先于所属分组', () => {
    const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动', '数字信号处理'] }];
    const settings = { groups, tagStyles: { 液压传动: 'programming' } };
    expect(styleIdOfTag(settings, '液压传动')).toBe('programming');
    expect(styleIdOfTag(settings, '数字信号处理')).toBe('stem');
    expect(hasOwnStyle(settings, '液压传动')).toBe(true);
    expect(hasOwnStyle(settings, '数字信号处理')).toBe(false);
    expect(hasOwnStyle(undefined, '液压传动')).toBe(false);
  });

  it('取消覆盖后重新跟随分组', () => {
    const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动'] }];
    const next = withTagStyle({ 液压传动: 'programming' }, '液压传动', null);
    expect(next).toEqual({});
    expect(styleIdOfTag({ groups, tagStyles: next }, '液压传动')).toBe('stem');
    expect(withTagStyle({ 液压传动: 'programming' }, '数字信号处理', 'arts')).toEqual({ 液压传动: 'programming', 数字信号处理: 'arts' });
    expect(withTagStyle(undefined, 'x', 'stem')).toEqual({ x: 'stem' });
  });

  it('一个标签只能属于一个分组', () => {
    const groups = [
      { name: '甲', styleId: 'stem' as const, subjects: ['x'] },
      { name: '乙', styleId: 'language' as const, subjects: [] },
    ];
    const moved = assignTag(groups, 'x', '乙');
    expect(moved.find((g) => g.name === '甲')!.subjects).toEqual([]);
    expect(moved.find((g) => g.name === '乙')!.subjects).toEqual(['x']);
    expect(assignTag(moved, 'x', null).every((g) => !g.subjects.includes('x'))).toBe(true);
  });

  it('能查到标签所在的分组', () => {
    const groups = [{ name: '理工科', styleId: 'stem' as const, subjects: ['液压传动'] }];
    expect(groupOfTag(groups, '液压传动')?.name).toBe('理工科');
    expect(groupOfTag(groups, '西语')).toBeNull();
    expect(groupOfTag(groups, null)).toBeNull();
  });

  it('清理旧分组：去掉空标签、重复标签和同名分组', () => {
    const cleaned = normalizeGroups([
      { name: ' 理工科 ', styleId: 'stem', subjects: ['液压传动', ' 液压传动 ', '', '  '] },
      { name: '理工科', styleId: 'language', subjects: ['重复名'] },
      { name: '  ', styleId: 'stem', subjects: ['空名'] },
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.name).toBe('理工科');
    expect(cleaned[0]!.subjects).toEqual(['液压传动']);
  });

  it('默认风格是通用', () => {
    expect(DEFAULT_SUBJECT_STYLE).toBe('default');
  });
});
