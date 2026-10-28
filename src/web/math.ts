/**
 * 把单行写法的独立公式改成独占三行的写法。
 *
 * remark-math 只把"定界符单独占一行"的 $$ 识别为独立公式；
 * 单行的 $$E=mc^2$$ 会被当成行内公式，字号偏小且不居中。模型经常写成单行，这里先规整。
 * 代码块里的内容不动：那里可能是示例代码，也可能是要展示的 LaTeX 源码。
 */
const SINGLE_LINE_DISPLAY_MATH = /^\$\$\s*((?:(?!\$\$).)+?)\s*\$\$$/;
const FENCE = /^\s*(```|~~~)/;

export function normalizeDisplayMath(markdown: string): string {
  if (!markdown.includes('$$')) return markdown;

  const lines = markdown.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      inCodeBlock = !inCodeBlock;
      output.push(line);
      continue;
    }
    const match = inCodeBlock ? null : SINGLE_LINE_DISPLAY_MATH.exec(line.trim());
    if (match?.[1]) {
      output.push('$$', match[1], '$$');
      continue;
    }
    output.push(line);
  }

  return output.join('\n');
}
