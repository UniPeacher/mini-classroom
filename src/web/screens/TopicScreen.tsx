import { useCallback, useEffect, useState } from 'react';
import { type PlacementState, api } from '../api';
import { OPTION_LETTERS, PRIORITY_LABEL, formatDay } from '../labels';
import { usePolling, useResource } from '../hooks';
import { openReview } from '../router';
import { RichMarkdown } from '../RichMarkdown';
import { TopicSection } from './MapScreen';
import { TopicBrief } from '../components/TopicBrief';

const UNKNOWN = -1;

/** 学习主题页要回答：这个主题学到哪了？摸底做了吗？ */
export function TopicScreen({ topicId, onTopicsChanged }: { topicId: string; onTopicsChanged: () => void }) {
  const map = useResource(() => api.map(), [topicId]);
  const placement = useResource(() => api.placement(topicId), [topicId]);
  const days = useResource(() => api.reviewDays(topicId).then((r) => r.days), [topicId]);
  const topic = map.data?.topics.find((t) => t.id === topicId);
  const [error, setError] = useState('');

  const reloadMap = map.reload;
  const reloadPlacement = placement.reload;
  const refresh = useCallback(() => {
    void reloadMap();
    void reloadPlacement();
    onTopicsChanged();
  }, [reloadMap, reloadPlacement, onTopicsChanged]);
  usePolling(topic?.graphStatus === 'pending' || placement.data?.status === 'preparing', refresh);

  async function update(patch: { status?: 'active' | 'paused'; priority?: number; subject?: string | null }) {
    setError('');
    try {
      await api.updateTopic(topicId, patch);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (map.error) return <p className="error-text">{map.error}</p>;
  if (!map.data) return <p className="muted">正在读取…</p>;
  if (!topic) return <div className="empty">这个学习主题不存在。</div>;

  const settled = placement.data?.status === 'done' || placement.data?.status === 'skipped';

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{topic.title}</h1>
          <p className="sub">
            {topic.graphStatus === 'ready'
              ? `${topic.total} 个知识点 · 已学会 ${topic.learned} · 下一步可学 ${topic.edge} · 今天到期 ${topic.due}${topic.excluded > 0 ? ` · 不学 ${topic.excluded}` : ''}`
              : topic.graphStatus === 'pending'
                ? '知识图谱正在生成，大约一两分钟'
                : '知识图谱生成失败'}
          </p>
        </div>
        {topic.graphStatus === 'ready' && (
          <div className="actions">
            <div className="segmented" role="group" aria-label="新学优先级">
              {[1, 2, 3].map((p) => (
                <button key={p} type="button" aria-pressed={topic.priority === p} onClick={() => update({ priority: p })}>
                  优先级{PRIORITY_LABEL[p]}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => update({ status: topic.status === 'paused' ? 'active' : 'paused' })}>
              {topic.status === 'paused' ? '恢复新学' : '暂停新学'}
            </button>
          </div>
        )}
      </div>
      <SubjectEditor topicId={topicId} subject={topic.subject ?? null} onSave={(subject) => update({ subject })} />
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {topic.learningBrief && <details className="topic-saved-brief"><summary>已确认的学习目标</summary><TopicBrief brief={topic.learningBrief} /></details>}
      {topic.status === 'paused' && <p className="notice" style={{ marginBottom: 16 }}>这个主题已暂停：不再新学，学过的知识点照常复习。</p>}

      {topic.graphStatus === 'ready' && placement.data && !settled && (
        <PlacementPanel topicId={topicId} state={placement.data} onChanged={refresh} />
      )}

      {topic.graphStatus === 'ready' && (
        <div className="grid top" style={{ marginTop: 16 }}>
          <div className="span-9">
            <TopicSection topic={topic} map={map.data} showTitle={false} />
          </div>
          <aside className="span-3 stack">
            {placement.data?.status === 'done' && placement.data.summary && (
              <section className="panel" aria-labelledby="placement-summary">
                <header>
                  <h2 id="placement-summary">摸底结果</h2>
                </header>
                <p className="num">直接答对 {placement.data.summary.correct} 个</p>
                <p className="num">推断已会 {placement.data.summary.inferred} 个</p>
                <p className="num">从头学 {placement.data.summary.unknown} 个</p>
                <p className="muted small" style={{ marginTop: 8 }}>
                  推断已会的会在接下来几节里各抽查一题。
                </p>
              </section>
            )}
            <section className="panel" aria-labelledby="topic-days">
              <header>
                <h2 id="topic-days">按天回看</h2>
              </header>
              {days.data && days.data.length === 0 && <p className="muted">学过之后，可以按天重读这个主题的讲解。</p>}
              <div className="rows">
                {(days.data ?? []).slice(0, 6).map((d) => (
                  <button key={d.day} type="button" className="row-card" style={{ minHeight: 48 }} onClick={() => openReview(d.day, topicId)}>
                    <span className="row-main">{formatDay(d.day)}</span>
                    <span className="row-end num">{d.pointCount}</span>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}

/** 摸底诊断：自述背景 → 后台备题 → 自适应作答（每题都有"不知道"）→ 结果 */
function PlacementPanel({ topicId, state, onChanged }: { topicId: string; state: PlacementState; onChanged: () => void }) {
  const [background, setBackground] = useState(state.background ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 作答后用接口返回的最新进度；后台准备好题目时（轮询刷新）以外面传进来的为准
  const [view, setView] = useState<PlacementState>(state);
  useEffect(() => setView(state), [state]);

  async function run(action: () => Promise<PlacementState>) {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      setView(next);
      if (next.status !== 'testing') onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel white" aria-labelledby="placement-title">
      <header>
        <h2 id="placement-title">开始前先做个摸底（约 3 分钟）</h2>
        {view.status === 'testing' && (
          <span className="meta num">
            第 {view.answered + 1} 题 · 最多 {view.maxQuestions} 题
          </span>
        )}
      </header>

      {view.status === 'pending' && (
        <div className="grid">
          <div className="span-8 stack">
            <label className="field">
              <span className="label">用一两句话说说你的背景</span>
              <span className="hint">比如学过什么、做过什么相关的事。会据此找出你已经会的知识，摸底也从合适的地方开始。</span>
              <textarea className="textarea" rows={3} maxLength={500} value={background} onChange={(e) => setBackground(e.target.value)} placeholder="例如：写过两年 JavaScript，用过一点 TypeScript" />
            </label>
            <div className="actions-row" style={{ marginTop: 0 }}>
              <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => api.beginPlacement(topicId, background))}>
                开始摸底
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => api.skipPlacement(topicId))}>
                跳过，从头学
              </button>
            </div>
            {state.preparationFailed && <p className="muted small">上次准备摸底题没有成功，可以再试一次。</p>}
          </div>
          <div className="span-4 muted">
            <p>8~10 道选择题，顺着知识点的前后关系出：答对就往更难处探，答不上就往基础处探。</p>
            <p style={{ marginTop: 8 }}>不会就选"不知道"，不算答错。直接答对的不再教，由它推断已会的会在之后抽查。</p>
          </div>
        </div>
      )}

      {view.status === 'preparing' && <p className="muted">正在根据你的背景准备摸底题，大约半分钟到一分钟，好了会自动显示。</p>}

      {view.status === 'testing' && view.question && (
        <div className="question">
          <p className="muted small" style={{ marginBottom: 6 }}>
            知识点：{view.question.title}
          </p>
          <div className="question-stem reading">
            <RichMarkdown>{view.question.stem}</RichMarkdown>
            {view.question.material && (
              <div className="question-material">
                <RichMarkdown>{view.question.material}</RichMarkdown>
              </div>
            )}
          </div>
          <div className="options">
            {view.question.options.map((option, i) => (
              <button key={i} type="button" className="option" disabled={busy} onClick={() => run(() => api.answerPlacement(topicId, view.question!.pointId, i))}>
                <span className="letter">{OPTION_LETTERS[i]}</span>
                <span className="option-text">{option}</span>
              </button>
            ))}
            <button type="button" className="option" disabled={busy} onClick={() => run(() => api.answerPlacement(topicId, view.question!.pointId, UNKNOWN))}>
              <span className="letter">?</span>
              <span className="option-text">不知道</span>
            </button>
          </div>
          <div className="actions-row">
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => run(() => api.skipPlacement(topicId))}>
              不做了，从头学
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </section>
  );
}

/**
 * 学科标签：用户自己填，用来把主题归到一起、并让一天的课在同一个学科内完成。
 * 已有的标签做成快捷按钮，避免手打出同义标签（"数学" 和 "数学 " 会变成两个学科）。
 */
function SubjectEditor(props: { topicId: string; subject: string | null; onSave: (subject: string | null) => void }) {
  const { subject, onSave } = props;
  const subjects = useResource(() => api.listSubjects().then((r) => r.subjects), []);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(subject ?? '');
  const known = (subjects.data ?? []).map((s) => s.subject).filter((s) => s !== subject);

  if (!editing) {
    return (
      <p className="muted small subject-line" style={{ marginBottom: 12 }}>
        {subject ? <>学科：<span className="pill accent">{subject}</span></> : '还没有学科标签。加上之后，可以按学科学习，一天只学一个学科。'}
        <button type="button" className="card-link" style={{ marginLeft: 8 }} onClick={() => { setText(subject ?? ''); setEditing(true); }}>
          {subject ? '修改' : '添加学科'}
        </button>
      </p>
    );
  }

  function commit() {
    onSave(text.trim() || null);
    setEditing(false);
  }

  return (
    <div className="field subject-editor" style={{ marginBottom: 12 }}>
      <label htmlFor="topic-subject">学科标签</label>
      <span className="hint">比如「数字信号处理」「液压传动」。留空表示不归类。</span>
      {known.length > 0 && (
        <div className="time-chips" style={{ margin: '4px 0' }}>
          {known.slice(0, 6).map((s) => (
            <button key={s} type="button" className={`btn small ${text === s ? 'selected' : ''}`} aria-pressed={text === s} onClick={() => setText(text === s ? '' : s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="actions-row" style={{ marginTop: 6 }}>
        <input
          id="topic-subject"
          className="input"
          type="text"
          maxLength={40}
          value={text}
          autoFocus
          placeholder="例如：数字信号处理"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        />
        <button type="button" className="btn small" onClick={commit}>保存</button>
        <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>取消</button>
      </div>
    </div>
  );
}
