import { useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { languageOf, renderMermaid, svgToDataUri } from './diagram';

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** 代码块中的 mermaid、svg 渲染为图解，其余照常显示为代码 */
const components: Components = {
  pre({ node, children }) {
    const code = (node as HastNode | undefined)?.children?.[0];
    if (code?.type === 'element' && code.tagName === 'code') {
      const language = languageOf(code.properties?.className);
      if (language === 'mermaid') return <MermaidDiagram code={textOf(code)} />;
      if (language === 'svg') return <SvgDiagram code={textOf(code)} />;
    }
    return <pre>{children}</pre>;
  },
};

/** 支持图解的 Markdown。不渲染原始 HTML，AI 生成的内容不能注入脚本。 */
export function RichMarkdown({ children }: { children?: string | null }) {
  return <Markdown components={components}>{children ?? ''}</Markdown>;
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    renderMermaid(code).then(
      (result) => !cancelled && setSvg(result),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) return <Fallback code={code} />;
  if (!svg) return <figure className="diagram muted">图解加载中…</figure>;
  return <figure className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SvgDiagram({ code }: { code: string }) {
  const uri = svgToDataUri(code);
  if (!uri) return <Fallback code={code} />;
  return (
    <figure className="diagram svg">
      <img src={uri} alt="图解" />
    </figure>
  );
}

/** 图解无法渲染时，退回显示原始内容 */
function Fallback({ code }: { code: string }) {
  return (
    <figure className="diagram">
      <figcaption className="muted">这张图解没能渲染，下面是原始内容：</figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
