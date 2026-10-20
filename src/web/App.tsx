import { useCallback, useEffect, useState } from 'react';
import { type Session, type Topic, api, devNow } from './api';
import { DayPicker, DayReviewPage, parseReviewHash } from './DayReview';
import { SessionView } from './SessionView';
import { TopicMapView } from './TopicMapView';
import './styles.css';

type View =
  | { name: 'home' }
  | { name: 'topic'; topicId: string }
  | { name: 'session'; session: Session; notice?: string }
  | { name: 'done'; correct: number; total: number };

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [devMode, setDevMode] = useState(false);
  // 回看页有自己的地址，在新标签页打开，不打断原页面
  const [review, setReview] = useState(() => parseReviewHash(location.hash));

  useEffect(() => {
    const onHashChange = () => setReview(parseReviewHash(location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function goHome() {
    if (review) history.pushState(null, '', location.pathname);
    setReview(null);
    setView({ name: 'home' });
  }

  useEffect(() => {
    api.health().then((h) => setDevMode(h.devMode), () => setDevMode(false));
  }, []);

  return (
    <main className="page">
      <header className="header">
        <h1 onClick={goHome}>微课堂</h1>
        {devMode && <DevClock />}
      </header>
      {review && <DayReviewPage route={review} />}
      {!review && view.name === 'home' && (
        <Home
          onStart={(session, notice) => setView({ name: 'session', session, notice })}
          onOpenTopic={(topicId) => setView({ name: 'topic', topicId })}
        />
      )}
      {!review && view.name === 'topic' && <TopicMapView topicId={view.topicId} onBack={() => setView({ name: 'home' })} />}
      {!review && view.name === 'session' && (
        <SessionView session={view.session} notice={view.notice} onFinish={(correct, total) => setView({ name: 'done', correct, total })} />
      )}
      {!review && view.name === 'done' && (
        <section className="card center">
          <h2>本节完成</h2>
          <p>
            答对 {view.correct} / {view.total} 项。下一节正在后台准备，到时打开即可学习。
          </p>
          <button onClick={() => setView({ name: 'home' })}>返回首页</button>
        </section>
      )}
    </main>
  );
}

/** 首页：开始学习是主操作；主题管理放在下方 */
function Home(props: { onStart: (session: Session, notice?: string) => void; onOpenTopic: (topicId: string) => void }) {
  const { onStart, onOpenTopic } = props;
  const [topics, setTopics] = useState<Topic[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listTopics().then((r) => setTopics(r.topics), (e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  // 图谱或候选池还在生成时，定时刷新状态
  const generating = topics.some((t) => t.graphStatus === 'pending') || preparing;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  async function start() {
    setError('');
    setBusy(true);
    try {
      const { session, preparing, resumed, guided } = await api.nextSession(guidance.trim() || undefined);
      if (session) onStart(session, guidanceNotice(guidance.trim() !== '', resumed, guided));
      else setPreparing(preparing);
      if (!session && !preparing) setError('暂时没有可学的内容。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card center">
        <button className="primary" onClick={start} disabled={topics.length === 0 || busy}>
          {busy && guidance.trim() ? '正在按补充说明生成本节内容…' : '开始一节微课堂'}
        </button>
        {topics.length > 0 && <GuidancePicker value={guidance} onChange={setGuidance} disabled={busy} />}
        {preparing && <p className="muted">内容正在后台准备，稍等一会儿再点。</p>}
        {topics.length === 0 && <p className="muted">先在下面输入一个想学的主题。</p>}
        {error && <p className="error">{error}</p>}
        <DayPicker />
      </section>
      <TopicList topics={topics} onCreated={refresh} onOpen={onOpenTopic} />
    </>
  );
}

/** 常用的补充说明；选中后发给模型的是 text */
const GUIDANCE_PRESETS = [
  { label: '讲得更浅显', text: '讲得更浅显：少用术语，多用生活中的类比和例子。' },
  { label: '多结合实际场景', text: '多结合实际工作中会遇到的真实场景来举例和出题。' },
  { label: '多用图解释', text: '每段讲解都配图，用图把机制讲清楚。' },
  { label: '讲得更深入', text: '讲得更深入：多讲背后的原理、边界情况和常见的坑。' },
];
const CUSTOM = 'custom';

/** 开始一节前可选的补充说明：下拉选常用说明，或自己写一段 */
function GuidancePicker({ value, onChange, disabled }: { value: string; onChange: (text: string) => void; disabled: boolean }) {
  const preset = GUIDANCE_PRESETS.find((p) => p.text === value);
  const [custom, setCustom] = useState(false);
  const selected = custom ? CUSTOM : (preset?.text ?? '');

  return (
    <div className="guidance">
      <label>
        补充说明：
        <select
          value={selected}
          disabled={disabled}
          onChange={(e) => {
            const isCustom = e.target.value === CUSTOM;
            setCustom(isCustom);
            onChange(isCustom ? '' : e.target.value);
          }}
        >
          <option value="">不加（立即开始）</option>
          {GUIDANCE_PRESETS.map((p) => (
            <option key={p.label} value={p.text}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM}>自己写…</option>
        </select>
      </label>
      {custom && (
        <textarea
          value={value}
          disabled={disabled}
          maxLength={500}
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例如：我是后端开发，多用 Node.js 的例子"
        />
      )}
      {value.trim() && <p className="muted">会按这段说明重新生成本节内容，大约需要半分钟到一分钟。</p>}
    </div>
  );
}

/** 开始一节后，告诉用户补充说明有没有用上 */
function guidanceNotice(sent: boolean, resumed: boolean, guided: { applied: number; total: number } | null): string | undefined {
  if (!sent) return undefined;
  if (resumed) return '还有一节没完成，先继续那一节；补充说明这次没有用上。';
  if (!guided) return undefined;
  if (guided.applied === guided.total) return '本节内容已按补充说明生成。';
  if (guided.applied === 0) return '按补充说明生成失败，这一节用的是原来准备好的内容。';
  return `有 ${guided.total - guided.applied} 项按补充说明生成失败，用的是原来准备好的内容。`;
}

const GRAPH_STATUS: Record<Topic['graphStatus'], string> = {
  pending: '正在生成知识图谱…',
  ready: '学习中',
  failed: '知识图谱生成失败',
};

function TopicList({ topics, onCreated, onOpen }: { topics: Topic[]; onCreated: () => void; onOpen: (topicId: string) => void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.createTopic(title);
      setTitle('');
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>学习主题</h2>
      <ul className="topics">
        {topics.map((t) => (
          <li key={t.id}>
            {/* 图谱生成好后才能点开查看知识点 */}
            {t.graphStatus === 'ready' ? (
              <button className="link" onClick={() => onOpen(t.id)}>
                {t.title}
              </button>
            ) : (
              <span>{t.title}</span>
            )}
            <span className="muted">{GRAPH_STATUS[t.graphStatus]}</span>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={create}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="想学什么？例如：TypeScript 常用技能" />
        <button type="submit" disabled={!title.trim()}>
          添加
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** 开发模式：模拟当前时间，用于验收"第二天"的复习安排 */
function DevClock() {
  const [value, setValue] = useState(devNow.get());
  return (
    <label className="dev-clock">
      模拟时间
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          devNow.set(e.target.value);
        }}
      />
      {value && (
        <button
          onClick={() => {
            setValue('');
            devNow.set('');
          }}
        >
          恢复
        </button>
      )}
    </label>
  );
}
