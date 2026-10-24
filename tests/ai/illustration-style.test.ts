import { describe, expect, it } from 'vitest';
import { illustrationPrompt } from '../../src/ai/illustration-style';
import { ILLUSTRATION } from '../fixtures/fake-model';

describe('教学配图提示词', () => {
  it.each([
    ILLUSTRATION.prompt,
    '用科学示意图展示 y = x² 的曲线与 x = 1 处的切线，标注切点 (1, 1) 和斜率 2，用局部放大解释该处的变化率。',
  ])('完整保留内容决定的教学作用、组合构图和必要标注：%s', (description) => {
    const prompt = illustrationPrompt({ key: 'example', prompt: description });
    expect(prompt).toContain(description);
    expect(prompt).not.toMatch(/guizang|op7418|Swiss editorial|off-white|one vivid|no code text|no English labels|no numbers/);
  });

  it('统一要求只约束准确性和阅读质量，保留完整画面与专业符号', () => {
    const prompt = illustrationPrompt(ILLUSTRATION);
    expect(prompt).toContain('3:2');
    expect(prompt).toContain('不被裁切');
    expect(prompt).toContain('清晰可读');
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('代码和数学符号');
    expect(prompt).toContain('准确');
  });
});
