import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type Ask, type AskSuggestions, api } from '../api';
import { RichMarkdown } from '../RichMarkdown';
import { routeHash } from '../router';

export interface AskPanelHandle {
  /** 把焦点移到提问框（"有疑问？问一下"按钮用） */
  focus(): void;
}

/**
 * 学习时随时提问：结合正在学的这一项回答；小题作答前只引导、不给答案。
 * 问过之后，可以把提问中暴露的不了解的知识整理出来，确认后加入认知地图，以后再学。
 */
export const AskPanel = forwardRef<AskPanelHandle, { sessionId: string; itemId: string | null; itemTitle: string }>(function AskPanel(props, ref) {
  const { sessionId, itemId, itemTitle } = props;
  const [asks, setAsks] = useState<Ask[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputRef.current?.focus({ preventScroll: true });
    },
  }));

  useEffect(() => {
    api.asks(sessionId).then((r) => setAsks(r.asks), () => undefined);
  }, [sessionId]);

  // 新的问答出现时滚到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [asks.length, busy]);

  async function send() {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      const row = await api.ask(sessionId, text, itemId ?? undefined);
      setAsks((prev) => [...prev, row]);
      setQuestion('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel ask-panel" aria-labelledby="ask-title">
      <header>
        <h2 id="ask-title">随时提问</h2>
        {asks.length > 0 && <span className="meta num">{asks.length} 问</span>}
      </header>
      {asks.length === 0 && !busy && <p className="muted small" style={{ marginBottom: 10 }}>读不懂、想追问，直接问。会结合「{itemTitle}」来答。</p>}
      {(asks.length > 0 || busy) && (
        <div className="ask-list" ref={listRef} aria-live="polite">
          {asks.map((a) => (
            <div key={a.id} className="ask-turn">
              <p className="ask-q">{a.question}</p>
              <div className="ask-a reading">
                <RichMarkdown>{a.answer}</RichMarkdown>
              </div>
            </div>
          ))}
          {busy && (
            <div className="ask-turn">
              <p className="ask-q">{question}</p>
              <p className="muted small">正在想…</p>
            </div>
          )}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="textarea"
        rows={2}
        maxLength={1000}
        value={question}
        disabled={busy}
        placeholder="比如：这里为什么要先收窄类型？"
        aria-label="提问"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          // Enter 发送，Shift + Enter 换行
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
      {asks.length > 0 && <AddToMap sessionId={sessionId} />}
    </section>
  );
});

/** 把提问中不了解的知识整理出来，勾选确认后加入认知地图 */
function AddToMap({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'review' | 'saving' | 'done'>('idle');
  const [data, setData] = useState<AskSuggestions | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  async function suggest() {
    setState('loading');
    setError('');
    try {
      const r = await api.suggestKnowledge(sessionId);
      setData(r);
      setPicked(new Set(r.suggestions.map((_, i) => i)));
      setState('review');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  }

  async function accept() {
    if (!data) return;
    setState('saving');
    setError('');
    try {
      const r = await api.acceptKnowledge(data.anchor.id, data.suggestions.filter((_, i) => picked.has(i)));
      setResult(`已加入 ${r.added} 个知识点到「${data.anchor.topicTitle}」，之后的微课堂会按顺序安排学习。`);
      setState('done');
    } catch (e) {
      setError((e as Error).message);
      setState('review');
    }
  }

  return (
    <div className="add-to-map">
      {state === 'idle' && (
        <button type="button" className="btn small" onClick={suggest}>
          把不懂的加入认知地图
        </button>
      )}
      {state === 'loading' && <p className="muted small">正在从你的提问里整理不了解的知识…</p>}
      {(state === 'review' || state === 'saving') && data && (
        <>
          {data.suggestions.length === 0 ? (
            <p className="muted small">从这些提问里没有看出需要单独再学的知识。</p>
          ) : (
            <>
              <p className="small" style={{ fontWeight: 500, marginBottom: 4 }}>
                勾选要加入的知识点
              </p>
              {data.suggestions.map((s, i) => (
                <label key={i} className="check">
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    disabled={state === 'saving'}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setPicked(next);
                    }}
                  />
                  <span>
                    <span style={{ fontWeight: 500 }}>{s.title}</span> <span className="pill">{s.kind === 'prerequisite' ? `「${data.anchor.title}」的前置` : '延伸'}</span>
                    <span className="muted small" style={{ display: 'block' }}>
                      {s.summary}
                    </span>
                  </span>
                </label>
              ))}
              <div className="actions-row" style={{ marginTop: 6 }}>
                <button type="button" className="btn small primary" onClick={accept} disabled={picked.size === 0 || state === 'saving'}>
                  {state === 'saving' ? '加入中…' : `加入 ${picked.size} 个`}
                </button>
                <button type="button" className="btn small ghost" onClick={() => setState('idle')} disabled={state === 'saving'}>
                  取消
                </button>
              </div>
            </>
          )}
        </>
      )}
      {state === 'done' && (
        <p className="notice ok small">
          {result}{' '}
          <a className="card-link" href={routeHash({ name: 'map' })}>
            看认知地图
          </a>
        </p>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
