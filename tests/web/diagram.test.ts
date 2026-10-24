import { describe, expect, it } from 'vitest';
import { languageOf, svgToDataUri } from '../../src/web/diagram';

describe('代码块语言识别', () => {
  it('从 className 中取出语言名', () => {
    expect(languageOf(['language-mermaid'])).toBe('mermaid');
    expect(languageOf('hljs language-svg')).toBe('svg');
  });

  it('没有语言时返回 null', () => {
    expect(languageOf(undefined)).toBeNull();
    expect(languageOf([])).toBeNull();
  });
});

describe('SVG 图解转为图片地址', () => {
  const decode = (uri: string) => decodeURIComponent(uri.replace('data:image/svg+xml;charset=utf-8,', ''));

  it('完整的 SVG 转为 data URI，内容不变', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    expect(decode(svgToDataUri(svg)!)).toBe(svg);
  });

  it('缺少命名空间时自动补上，否则作为图片无法显示', () => {
    const uri = svgToDataUri('<svg viewBox="0 0 10 10"></svg>')!;
    expect(decode(uri)).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
  });

  it('子元素里出现 xmlns 时，根元素仍要补命名空间', () => {
    const uri = svgToDataUri('<svg viewBox="0 0 10 10"><g xmlns="x"></g></svg>')!;
    expect(decode(uri).startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('不是完整 SVG 时返回 null，由页面显示原始内容', () => {
    expect(svgToDataUri('<div>不是图</div>')).toBeNull();
    expect(svgToDataUri('<svg viewBox="0 0 10 10">')).toBeNull();
  });
});
