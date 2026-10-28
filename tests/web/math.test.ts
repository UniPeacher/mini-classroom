import { describe, expect, it } from 'vitest';
import { normalizeDisplayMath } from '../../src/web/math';

/** remark-math 只把定界符独占一行的 $$ 当独立公式，模型常写成单行，需要先规整 */
describe('独立公式的写法规整', () => {
  it('单行的 $$...$$ 展开为定界符独占一行', () => {
    expect(normalizeDisplayMath('$$E = mc^2$$')).toBe('$$\nE = mc^2\n$$');
  });

  it('两侧有空格的单行写法同样规整', () => {
    expect(normalizeDisplayMath('  $$ a + b $$  ')).toBe('$$\na + b\n$$');
  });

  it('已经是多行的写法保持不变', () => {
    expect(normalizeDisplayMath('$$\nE = mc^2\n$$')).toBe('$$\nE = mc^2\n$$');
  });

  it('句中的行内公式不动', () => {
    expect(normalizeDisplayMath('流量由 $P_p$ 和 $P_b$ 决定')).toBe('流量由 $P_p$ 和 $P_b$ 决定');
  });

  it('不以 $$ 开头的行不动', () => {
    expect(normalizeDisplayMath('价格 $$ 元')).toBe('价格 $$ 元');
  });

  it('代码块里的 LaTeX 源码不改：那里要展示原始写法', () => {
    const source = '```latex\n$$E = mc^2$$\n```';
    expect(normalizeDisplayMath(source)).toBe(source);
  });

  it('代码块之后的正文照常规整', () => {
    const markdown = '```latex\n$$a$$\n```\n$$b = 1$$';
    expect(normalizeDisplayMath(markdown)).toBe('```latex\n$$a$$\n```\n$$\nb = 1\n$$');
  });
});
