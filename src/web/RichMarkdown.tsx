import { useEffect, useState } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { Icon } from './components/Icon';
import { languageOf, renderMermaid, svgToDataUri } from './diagram';

// 插画用 illustration:<id> 引用（与 src/shared/content.ts 的 ILLUSTRATION_SCHEME 一致，前端不引入 zod 那份模块）
// 默认的链接过滤会把这种自定义协议清空，这里放行
const ILLUSTRATION_SCHEME = 'illustration:';
const urlTransform = (url: string) => (url.startsWith(ILLUSTRATION_SCHEME) ? url : defaultUrlTransform(url));

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** 代码块中的 mermaid、svg 渲染为图解，其余照常显示为代码；illustration: 图片显示为插画 */
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
  img({ src, alt }) {
    if (typeof src === 'string' && src.startsWith(ILLUSTRATION_SCHEME)) {
      const id = src.slice(ILLUSTRATION_SCHEME.length);
      if (/^[\w-]+$/.test(id)) return <Illustration key={id} id={id} alt={alt ?? ''} />;
    }
    // 模型生成的远程图片地址可能夹带学习内容；只加载项目自己生成的插画。
    return <span>{alt ?? '图片未加载'}</span>;
  },
};

// GitHub 风格的 Markdown：表格、删除线、任务列表、自动链接。写作原则要求并列的规则写成表格，必须能渲染
const remarkPlugins = [remarkGfm];

/** 支持图解和表格的 Markdown。不渲染原始 HTML，AI 生成的内容不能注入脚本。 */
export function RichMarkdown({ children }: { children?: string | null }) {
  return (
    <Markdown components={components} remarkPlugins={remarkPlugins} urlTransform={urlTransform}>
      {children ?? ''}
    </Markdown>
  );
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

/** 插画还在后台画时每隔几秒查一次 */
const ILLUSTRATION_POLL_MS = 4000;

/**
 * 讲解里的插画：画好就显示，还在画时显示占位，没画成时允许单独重试。
 * Markdown 的图片在段落里，这里用 span 而不是 figure，避免 p 里套块级元素。
 */
function Illustration({ id, alt }: { id: string; alt: string }) {
  const [status, setStatus] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [unavailable, setUnavailable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollVersion, setPollVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      api.illustration(id).then(
        (r) => {
          if (cancelled) return;
          setUnavailable(false);
          setStatus(r.status);
          if (r.status !== 'failed') setError(null);
          if (r.status === 'pending') timer = setTimeout(check, ILLUSTRATION_POLL_MS);
        },
        () => {
          if (cancelled) return;
          // 状态查询失败不代表绘图失败；只重查状态，不触发生成请求。
          setUnavailable(true);
          timer = setTimeout(check, ILLUSTRATION_POLL_MS);
        },
      );
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, pollVersion]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const result = await api.retryIllustration(id);
      setStatus(result.status);
      setUnavailable(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : '暂时无法重试，请稍后再试。');
    } finally {
      setRetrying(false);
      // 即使响应丢失，服务端也可能已经接收任务，重新查询以确认实际状态。
      setPollVersion((version) => version + 1);
    }
  }

  if (status === 'ready') {
    return (
      <span className="diagram illustration">
        <img src={api.illustrationImageUrl(id)} alt={alt} loading="lazy" />
      </span>
    );
  }
  const generating = !unavailable && (retrying || status === 'pending');
  let message = '这张插图没有画成。';
  if (unavailable) message = '暂时无法查询插图状态，正在重新连接…';
  else if (generating) message = '正在生成图片…';

  return (
    <span className="diagram illustration placeholder" aria-busy={generating}>
      {status === 'failed' && !unavailable && (
        <button
          type="button"
          className="icon-btn illustration-retry"
          title="重新生成图片"
          aria-label="重新生成图片"
          disabled={retrying}
          onClick={retry}
        >
          <Icon name="refresh" />
        </button>
      )}
      {generating && <span className="illustration-spinner" aria-hidden="true" />}
      <span className="muted" role="status">{message}</span>
      {alt && <span className="small">{alt}</span>}
      {error && <span className="small error-text" role="alert">{error}</span>}
    </span>
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
