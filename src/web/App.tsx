import { useCallback, useEffect, useState } from 'react';
import { type Session, type Topic, api, devNow } from './api';
import { SessionView } from './SessionView';
import { TopicMapView } from './TopicMapView';
import './styles.css';

type View =
  | { name: 'home' }
  | { name: 'topic'; topicId: string }
  | { name: 'session'; session: Session }
  | { name: 'done'; correct: number; total: number };

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    api.health().then((h) => setDevMode(h.devMode), () => setDevMode(false));
  }, []);

  return (
    <main className="page">
      <header className="header">
        <h1 onClick={() => setView({ name: 'home' })}>微课堂</h1>
        {devMode && <DevClock />}
      </header>
      {view.name === 'home' && (
        <Home
          onStart={(session) => setView({ name: 'session', session })}
          onOpenTopic={(topicId) => setView({ name: 'topic', topicId })}
        />
      )}
      {view.name === 'topic' && <TopicMapView topicId={view.topicId} onBack={() => setView({ name: 'home' })} />}
      {view.name === 'session' && (
        <SessionView session={view.session} onFinish={(correct, total) => setView({ name: 'done', correct, total })} />
      )}
      {view.name === 'done' && (
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
function Home({ onStart, onOpenTopic }: { onStart: (session: Session) => void; onOpenTopic: (topicId: string) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');

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
    try {
      const { session, preparing } = await api.nextSession();
      if (session) onStart(session);
      else setPreparing(preparing);
      if (!session && !preparing) setError('暂时没有可学的内容。');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <section className="card center">
        <button className="primary" onClick={start} disabled={topics.length === 0}>
          开始一节微课堂
        </button>
        {preparing && <p className="muted">内容正在后台准备，稍等一会儿再点。</p>}
        {topics.length === 0 && <p className="muted">先在下面输入一个想学的主题。</p>}
        {error && <p className="error">{error}</p>}
      </section>
      <TopicList topics={topics} onCreated={refresh} onOpen={onOpenTopic} />
    </>
  );
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
