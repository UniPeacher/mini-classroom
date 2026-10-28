import { useEffect, useRef, useState } from 'react';
import { api, type TopicDraft } from '../api';
import { TopicBrief } from '../components/TopicBrief';
import { useResource } from '../hooks';
import { coursePath, useOrganization } from '../organization';
import { RichMarkdown } from '../RichMarkdown';
import { navigate, routeHash } from '../router';

/** 专门的需求澄清页：已发送的对话保存在服务端，确认后才进入正式学习主题。 */
export function TopicPlanningScreen({ draftId }: { draftId: string }) {
  const resource = useResource(() => api.topicDraft(draftId), [draftId]);
  const organization = useOrganization();
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<'' | 'send' | 'reply' | 'confirm'>('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  const attemptedRevision = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (resource.data) setDraft(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!draft?.topicId) return;
    void organization.reload();
    navigate({ name: 'topic', topicId: draft.topicId });
  }, [draft?.topicId, organization.reload]);

  async function recover(cause: unknown) {
    setError((cause as Error).message);
    // 请求可能已成功写入但响应丢失，先读取服务端事实再让用户重试。
    try {
      const latest = await api.topicDraft(draftId);
      setDraft(latest);
      return latest;
    } catch {
      // 保留现有对话和错误提示，供用户再次重试。
      return null;
    }
  }

  async function reply(current: TopicDraft) {
    if (locked.current) return;
    locked.current = true;
    setAction('reply');
    setError('');
    try { setDraft(await api.replyTopicDraft(current.id, current.revision)); }
    catch (cause) {
      const latest = await recover(cause);
      if (latest && latest.revision > current.revision && latest.messages.at(-1)?.role === 'assistant') setError('');
    }
    finally { locked.current = false; setAction(''); }
  }

  useEffect(() => {
    if (!draft || draft.topicId || action || draft.messages.at(-1)?.role !== 'user' || attemptedRevision.current === draft.revision) return;
    attemptedRevision.current = draft.revision;
    void reply(draft);
  }, [draft, action]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [draft?.messages.length, error]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || locked.current || !message.trim() || draft.messages.at(-1)?.role !== 'assistant') return;
    locked.current = true;
    setAction('send');
    setError('');
    const text = message.trim();
    try {
      setDraft(await api.addTopicMessage(draftId, text, draft.revision));
      setMessage('');
    } catch (cause) {
      const latest = await recover(cause);
      const sent = latest?.messages[draft.messages.length];
      if (sent?.role === 'user' && sent.content === text) {
        setMessage('');
        setError('');
      }
    }
    finally { locked.current = false; setAction(''); }
  }

  async function confirm() {
    if (!draft?.brief || locked.current || message.trim()) return;
    locked.current = true;
    setAction('confirm');
    setError('');
    try {
      const { topicId } = await api.confirmTopicDraft(draftId, draft.revision);
      setDraft({ ...draft, topicId });
    } catch (cause) { await recover(cause); }
    finally { locked.current = false; setAction(''); }
  }

  const pendingReply = draft?.messages.at(-1)?.role === 'user';
  const busy = action !== '';

  return (
    <div className="topic-planning">
      <a className="back-link" href={routeHash({ name: 'home' })}>返回首页</a>
      <header className="title-row">
        <div><h1>先聊清楚，你想学会什么。</h1><p className="sub">一起明确学习目的和范围，你可以随时补充或纠正。</p></div>
      </header>
      <p className="topic-planning-note muted small">已发送的对话会自动保存；确认后才加入学习计划。</p>
      {draft?.courseId && <p className="muted small">将加入课程：<span className="pill accent">{coursePath(organization.data, draft.courseId)}</span></p>}
      {resource.error && <p className="error-text" role="alert">{resource.error} <button type="button" className="card-link" onClick={resource.reload}>重新加载</button></p>}
      {!draft && !resource.error && <p className="muted" role="status">正在读取讨论…</p>}
      {draft && <>
        <div className="topic-conversation" role="log" aria-label="学习目标讨论" aria-live="polite">
          {draft.messages.map((item, index) => (
            <article key={index} className={`topic-message ${item.role}`}>
              <p className="topic-message-author">{item.role === 'user' ? '你' : '微课堂'}</p>
              {item.role === 'user' ? <p className="topic-message-text">{item.content}</p> : <div className="reading"><RichMarkdown>{item.content}</RichMarkdown></div>}
              {item.brief && index < draft.messages.length - 1 && <details className="topic-past-brief"><summary>当时的目标摘要</summary><TopicBrief brief={item.brief} /></details>}
            </article>
          ))}
        </div>
        {action === 'reply' && <p className="topic-reply-status muted" role="status">正在梳理你的想法…</p>}
        {draft.brief && !pendingReply && <TopicPlanConfirmation draft={draft} busy={busy} confirming={action === 'confirm'} hasUnsentMessage={Boolean(message.trim())} onConfirm={confirm} onCorrect={() => input.current?.focus()} />}
        {error && <div className="topic-planning-error" role="alert"><p className="error-text">{error}</p>{pendingReply && !busy && <button type="button" className="btn" onClick={() => reply(draft)}>重试回复</button>}</div>}
        <form className="topic-composer" onSubmit={send} aria-busy={busy}>
          <label htmlFor="topic-message">{draft.brief ? '还需要调整？继续告诉我' : '说说你的想法'}</label>
          <textarea
            ref={input} id="topic-message" className="textarea" value={message} onChange={event => setMessage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!event.repeat) void send(event);
              }
            }}
            maxLength={2000} rows={3} disabled={busy || pendingReply} placeholder="比如：我想解决什么问题，学完希望能做到什么…"
            aria-describedby="topic-message-hint" aria-keyshortcuts="Control+Enter Meta+Enter"
          />
          <div className="topic-composer-actions"><p id="topic-message-hint" className="muted small">{pendingReply ? '收到回复后，可以继续补充。' : 'Ctrl / Cmd + Enter 发送，Enter 换行。'}</p><button type="submit" className="btn primary" disabled={busy || pendingReply || !message.trim()}>{action === 'send' ? '正在发送…' : '发送'}</button></div>
        </form>
        <div ref={end} />
      </>}
    </div>
  );
}

/** 确认入口只展示当前摘要；输入了纠正内容时，先发送并重新核对。 */
export function TopicPlanConfirmation({ draft, busy, confirming, hasUnsentMessage, onConfirm, onCorrect }: {
  draft: TopicDraft; busy: boolean; confirming: boolean; hasUnsentMessage: boolean; onConfirm: () => void; onCorrect: () => void;
}) {
  if (!draft.brief || draft.topicId || draft.messages.at(-1)?.role !== 'assistant') return null;
  return (
    <section className="panel topic-plan-confirmation" aria-labelledby="topic-plan-title">
      <header><h2 id="topic-plan-title">这是你想达成的学习目标吗？</h2><span className="meta">待你确认</span></header>
      <TopicBrief brief={draft.brief} />
      <p className="muted small">{hasUnsentMessage ? '你还有未发送的补充，请先发送，再核对更新后的目标。' : '确认后会生成主题名称，加入学习计划，并准备摸底。'}</p>
      <div className="topic-plan-actions"><button type="button" className="btn primary" disabled={busy || hasUnsentMessage} onClick={onConfirm}>{confirming ? '正在生成主题名称…' : '确认并加入学习计划'}</button><button type="button" className="btn ghost" disabled={busy} onClick={onCorrect}>我想再调整</button></div>
    </section>
  );
}
