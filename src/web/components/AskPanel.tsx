import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type AskSuggestions, type AskThread, api } from '../api';
import { formatTime } from '../labels';
import { RichMarkdown } from '../RichMarkdown';
import { routeHash } from '../router';

export interface AskPanelHandle {
  /** 把焦点移到提问框（"有疑问？问一下"按钮用） */
  focus(): void;
  /** 把选中的一段内容作为引用放进提问框 */
  quote(text: string): void;
}

interface AskPanelProps {
  /** 在哪里提问：学习页的某一节，或正在看的知识点 */
  scope: { sessionId?: string; pointId?: string };
  /** 学习页正在学的那一项 */
  itemId?: string | null;
  /** 正在学或正在看的知识点名称，用在提示语里 */
  contextTitle: string;
}

/**
 * 随时提问：按会话组织，可新建会话（之后不再带上之前的上下文），也可切回以前的会话。
 * 结合正在学的内容和选中的引用回答；可把会话里暴露的不了解的知识整理出来，逐个点选加入认知地图。
 */
export const AskPanel = forwardRef<AskPanelHandle, AskPanelProps>(function AskPanel({ scope, itemId, contextTitle }, ref) {
  const [threads, setThreads] = useState<AskThread[]>([]);
  // null 表示新会话：第一次提问时才真正建出来
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [quote, setQuote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${scope.sessionId ?? ''}|${scope.pointId ?? ''}`;
  const current = threads.find((t) => t.id === currentId) ?? null;

  const focusInput = () => {
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputRef.current?.focus({ preventScroll: true });
  };
  useImperativeHandle(ref, () => ({
    focus: focusInput,
    quote(text: string) {
      setQuote(text);
      focusInput();
    },
  }));

  // 换了提问的位置（另一节、另一个知识点）：读出那里的会话，默认接着最近的一个
  useEffect(() => {
    let cancelled = false;
    api.askThreads(scope).then(
      (r) => {
        if (cancelled) return;
        setThreads(r.threads);
        setCurrentId(r.threads[0]?.id ?? null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [current?.asks.length, busy, currentId]);

  async function send() {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      let thread = current;
      if (!thread) {
        thread = await api.createAskThread(scope);
        setThreads((prev) => [thread!, ...prev]);
        setCurrentId(thread.id);
      }
      const row = await api.ask({ threadId: thread.id, question: text, itemId: itemId ?? undefined, pointId: scope.pointId, quote: quote ?? undefined });
      setThreads((prev) => prev.map((t) => (t.id === thread!.id ? { ...t, asks: [...t.asks, row] } : t)));
      setQuestion('');
      setQuote(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function newThread() {
    setCurrentId(null);
    setQuestion('');
    setError('');
    focusInput();
  }

  const asks = current?.asks ?? [];
  return (
    <section className="panel ask-panel" aria-labelledby="ask-title">
      <header>
        <h2 id="ask-title">随时提问</h2>
        <button type="button" className="btn small ghost" onClick={newThread} disabled={busy || currentId === null}>
          新建会话
        </button>
      </header>
      {threads.length > 0 && (
        <select className="select ask-threads" value={currentId ?? ''} onChange={(e) => setCurrentId(e.target.value || null)} disabled={busy} aria-label="切换会话">
          {currentId === null && <option value="">新会话</option>}
          {threads.map((t, i) => (
            <option key={t.id} value={t.id}>
              会话 {threads.length - i} · {t.asks.length} 问 · {formatTime(t.createdAt)}
            </option>
          ))}
        </select>
      )}
      {asks.length === 0 && !busy && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          {currentId === null ? '新会话。' : ''}读不懂、想追问，直接问；也可以在内容里选中一段文字来问。会结合「{contextTitle}」来答。
        </p>
      )}
      {(asks.length > 0 || busy) && (
        <div className="ask-list" ref={listRef} aria-live="polite">
          {asks.map((a) => (
            <div key={a.id} className="ask-turn">
              {a.quote && <blockquote className="ask-quote">{a.quote}</blockquote>}
              <p className="ask-q">{a.question}</p>
              <div className="ask-a reading">
                <RichMarkdown>{a.answer}</RichMarkdown>
              </div>
            </div>
          ))}
          {busy && (
            <div className="ask-turn">
              {quote && <blockquote className="ask-quote">{quote}</blockquote>}
              <p className="ask-q">{question}</p>
              <p className="muted small">正在想…</p>
            </div>
          )}
        </div>
      )}
      {quote && !busy && (
        <div className="quote-chip">
          <span className="muted small">引用</span>
          <span className="quote-text">{quote}</span>
          <button type="button" className="btn small ghost" onClick={() => setQuote(null)} aria-label="去掉引用">
            去掉
          </button>
        </div>
      )}
      <textarea
        ref={inputRef}
        className="textarea"
        rows={2}
        maxLength={1000}
        value={question}
        disabled={busy}
        placeholder={quote ? '这段哪里不明白？' : '比如：这里为什么要先收窄类型？'}
        aria-label="提问"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          // Enter 发送，Shift + Enter 换行；输入法选词时的 Enter 不发送
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="actions-row" style={{ marginTop: 8 }}>
        <button type="button" className="btn small" onClick={send} disabled={!question.trim() || busy}>
          {busy ? '回答中…' : '发送'}
        </button>
        <span className="muted small">Enter 发送 · Shift + Enter 换行</span>
      </div>
      {error && <p className="error-text small" style={{ marginTop: 6 }}>{error}</p>}
      {current && asks.length > 0 && <AddToMap key={current.id} threadId={current.id} />}
    </section>
  );
});

/** 把会话里暴露的不了解的知识整理成一张列表，逐个点选加入认知地图 */
function AddToMap({ threadId }: { threadId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [data, setData] = useState<AskSuggestions | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');

  async function suggest() {
    setState('loading');
    setError('');
    try {
      setData(await api.suggestKnowledge(threadId));
      setAdded(new Set());
      setState('ready');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  }

  async function add(indexes: number[]) {
    if (!data) return;
    const todo = indexes.filter((i) => !added.has(i) && !saving.has(i));
    if (todo.length === 0) return;
    setSaving((prev) => new Set([...prev, ...todo]));
    setError('');
    try {
      await api.acceptKnowledge(data.anchor.id, todo.map((i) => data.suggestions[i]!));
      setAdded((prev) => new Set([...prev, ...todo]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving((prev) => new Set([...prev].filter((i) => !todo.includes(i))));
    }
  }

  const remaining = data ? data.suggestions.map((_, i) => i).filter((i) => !added.has(i)) : [];
  return (
    <div className="add-to-map">
      {state === 'idle' && (
        <button type="button" className="btn small" onClick={suggest}>
          把不懂的整理出来，加入认知地图
        </button>
      )}
      {state === 'loading' && <p className="muted small">正在从这个会话的提问里整理不了解的知识…</p>}
      {state === 'ready' && data && (
        <>
          {data.suggestions.length === 0 ? (
            <p className="muted small">从这些提问里没有看出需要单独再学的知识。</p>
          ) : (
            <>
              <div className="suggest-head">
                <span className="small" style={{ fontWeight: 500 }}>
                  点选要加入「{data.anchor.topicTitle}」的知识点
                </span>
                {remaining.length > 1 && (
                  <button type="button" className="btn small ghost" onClick={() => add(remaining)}>
                    全部加入
                  </button>
                )}
              </div>
              <ul className="suggest-list">
                {data.suggestions.map((s, i) => (
                  <li key={i}>
                    <button type="button" className={`suggest-item ${added.has(i) ? 'added' : ''}`} onClick={() => add([i])} disabled={added.has(i) || saving.has(i)} aria-pressed={added.has(i)}>
                      <span className="suggest-main">
                        <span className="suggest-title">
                          {s.title} <span className="pill">{s.kind === 'prerequisite' ? `「${data.anchor.title}」的前置` : '延伸'}</span>
                        </span>
                        <span className="muted small">{s.summary}</span>
                        <span className="faint small">{s.reason}</span>
                      </span>
                      <span className="suggest-action">{added.has(i) ? '已加入' : saving.has(i) ? '加入中…' : '加入'}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {added.size > 0 && (
                <p className="small" style={{ marginTop: 8 }}>
                  已加入 {added.size} 个，之后的微课堂会按顺序安排学习。{' '}
                  <a className="card-link" href={routeHash({ name: 'map' })}>
                    看认知地图
                  </a>
                </p>
              )}
            </>
          )}
        </>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
