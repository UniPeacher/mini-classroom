/** 从 Markdown 代码块的 className（如 ['language-mermaid']）取出语言名 */
export function languageOf(className: unknown): string | null {
  const names = Array.isArray(className) ? className : typeof className === 'string' ? className.split(' ') : [];
  const match = names.map(String).find((name) => name.startsWith('language-'));
  return match ? match.slice('language-'.length) : null;
}

/**
 * 把 SVG 源码转成 data URI，用 <img> 显示。<img> 中的 SVG 不会执行脚本、不会加载外部资源，
 * 本身就是隔离环境，AI 生成的图解即使含有不安全内容也不会影响页面。不是 SVG 时返回 null。
 */
export function svgToDataUri(source: string): string | null {
  const svg = source.trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return null;
  // 作为独立图片显示时必须声明命名空间
  const withNamespace = /\sxmlns=/.test(svg.slice(0, svg.indexOf('>'))) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`;
}

type MermaidApi = typeof import('mermaid').default;
let mermaidReady: Promise<MermaidApi> | undefined;
let renderCount = 0;

/** 按需加载 Mermaid 并渲染为 SVG 字符串；语法错误时抛出。 */
export async function renderMermaid(code: string): Promise<string> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    // strict：不允许图中出现可执行内容，标签会经过清洗
    // 按原始尺寸输出，不随容器缩小：宽图横向滚动，文字保持可读
    const natural = { useMaxWidth: false };
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      flowchart: natural,
      sequence: natural,
      state: natural,
      class: natural,
    });
    return mermaid;
  });
  const mermaid = await mermaidReady;
  await mermaid.parse(code); // 先校验语法，避免渲染失败时在页面上残留错误图
  renderCount += 1;
  const { svg } = await mermaid.render(`diagram-${renderCount}`, code);
  return svg;
}
