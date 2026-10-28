import { useCallback, useRef, useState } from 'react';
import { type OrganizationTopic, type Preview, type Session, api, devNow } from '../api';
import { Icon } from '../components/Icon';
import { SessionContents, describeCounts, useSessionStart } from '../components/SessionPreview';
import { usePolling, useResource } from '../hooks';
import { type OrganizationSnapshot, scopeLabel, useOrganization, topicStateText } from '../organization';
import { navigate, routeHash, todayHash } from '../router';

/** 首页并列承载探索和继续学习，具体安排与记录交给「今天」。 */
export function HomeScreen({ onStart }: { onStart: (session: Session, notice?: string) => void }) {
  const organization = useOrganization();
  const preview = useResource(() => api.preview(), []);
  const reloadPreview = preview.reload;
  const refresh = useCallback(() => {
    void reloadPreview();
    void organization.reload();
  }, [reloadPreview, organization.reload]);
  const preparing = preview.data?.preparing === true || hasPendingTopics(organization.data);
  usePolling(preparing, refresh);
  const date = new Date(devNow.get() || Date.now()).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const hasTopics = organization.data === null ? null : organization.data.totals.topics > 0;

  return (
    <div className="home-page">
      <header className="home-heading">
        <div className="home-date"><span>首页</span><time>{date}</time></div>
        <h1 className="greeting">今天，学点想学的。</h1>
        <p className="greeting-sub">打开一个新主题，也让已经学过的留在脑海里。</p>
      </header>
      <div className="home-entries">
        <section className="panel white home-entry home-explore" aria-labelledby="home-topic-title">
          <div className="home-entry-label"><Icon name="plus" />探索新的</div>
          <h2 id="home-topic-title" className="home-entry-title">你想学什么？</h2>
          <p className="home-entry-sub">一个领域，或一个想弄懂的问题。</p>
          <NewTopicForm />
          <div className="home-explore-note"><strong>先聊清楚，再开始学。</strong><p>通过对话明确目标，确认后加入学习计划，再做约 3 分钟摸底。</p></div>
        </section>
        <HomeLearning preview={preview.data} error={preview.error} hasTopics={hasTopics} onRetry={refresh} onStart={onStart} />
      </div>
      <PendingTopicDrafts />
      <section className="home-topics" aria-labelledby="home-topics-title">
        <header>
          <h2 id="home-topics-title">你的学习主题</h2>
          <div className="home-topics-links">
            <a className="card-link small" href={routeHash({ name: 'organization' })}>整理学科与课程<Icon name="chevron" /></a>
            <a className="card-link small" href={routeHash({ name: 'map' })}>查看认知地图<Icon name="chevron" /></a>
          </div>
        </header>
        {organization.error ? (
          <p className="error-text" role="alert">
            没能读取学习主题：{organization.error}{' '}
            <button type="button" className="card-link" onClick={() => void organization.reload()}>重新加载</button>
          </p>
        ) : organization.loading && !organization.data ? (
          <p className="muted">正在读取学习主题…</p>
        ) : !organization.data || organization.data.totals.topics === 0 ? (
          <p className="muted">添加第一个主题后，就能从这里查看摸底和学习情况。</p>
        ) : (
          <OrganizationTopics />
        )}
      </section>
    </div>
  );
}

function hasPendingTopics(snapshot: OrganizationSnapshot | null): boolean {
  if (!snapshot) return false;
  const all = [...snapshot.unclassified, ...snapshot.orphanTopics, ...snapshot.disciplines.flatMap((d) => d.courses.flatMap((c) => c.topics))];
  return all.some((topic) => topic.graphStatus === 'pending' || topic.placementStatus === 'preparing');
}

const TOPIC_EXAMPLES = ['Python 数据分析', '摄影构图', '逻辑与论证'];

/** 保存初步想法后立即进入澄清页；可以先把主题放进某门专业课程。 */
export function NewTopicForm() {
  const organization = useOrganization();
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || !title.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const { id } = await api.createTopicDraft(title.trim(), courseId || null);
      navigate({ name: 'topic-draft', draftId: id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const courses = organization.data
    ? organization.data.disciplines.flatMap((node) => node.courses.map((courseNode) => ({ ...courseNode.course, disciplineName: node.discipline.name })))
    : [];

  return (
    <form className="home-topic-form" onSubmit={create} aria-busy={busy}>
      <div className="home-search">
        <Icon name="search" />
        <input ref={input} id="new-topic" aria-labelledby="home-topic-title" aria-describedby={error ? 'topic-create-error' : undefined} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} maxLength={2000} placeholder="输入想学的内容或想解决的问题" autoComplete="off" />
        <button type="submit" className="btn primary" disabled={!title.trim() || busy}>{busy ? '正在进入…' : '添加主题'}</button>
      </div>
      {courses.length > 0 && (
        <label className="home-course-field">
          <span className="muted small">放进哪门课程（可选）</span>
          <select className="select" value={courseId} disabled={busy} onChange={(event) => setCourseId(event.target.value)}>
            <option value="">先不归类</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>{course.disciplineName} / {course.name}</option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="error-text" id="topic-create-error" role="alert">{error}</p>}
      <p className="muted small home-examples-label">试试这样描述</p>
      <div className="home-examples">{TOPIC_EXAMPLES.map(example => <button key={example} type="button" className="btn small" disabled={busy} onClick={() => { setTitle(example); setError(''); input.current?.focus(); }}>{example}</button>)}</div>
    </form>
  );
}

/** 尚未确认的讨论可从首页接着聊，不混入正式学习主题。 */
function PendingTopicDrafts() {
  const drafts = useResource(() => api.topicDrafts().then(result => result.drafts), []);
  if (drafts.error) return <p className="error-text home-drafts-error" role="alert">未完成的讨论加载失败：{drafts.error} <button type="button" className="card-link" onClick={drafts.reload}>重新加载</button></p>;
  if (!drafts.data?.length) return null;
  return (
    <section className="home-topics" aria-labelledby="pending-topic-title">
      <header><h2 id="pending-topic-title">继续明确学习目标</h2><span className="muted small">尚未加入学习计划</span></header>
      <div className="home-topic-list home-drafts">{drafts.data.map(draft => (
        <a key={draft.id} className="home-topic" href={routeHash({ name: 'topic-draft', draftId: draft.id })}>
          <Icon name="topic" /><span className="row-main"><span className="row-title">{draft.idea}</span><span className="row-sub">继续上次的对话</span></span><Icon name="chevron" />
        </a>
      ))}</div>
    </section>
  );
}

/** 下一节的真实预览：恢复优先、上限可见，加载失败时不承诺旧内容仍可开始。 */
export function HomeLearning(props: { preview: Preview | null; error: string; hasTopics: boolean | null; onRetry: () => void; onStart: (session: Session, notice?: string) => void }) {
  const { preview, error, hasTopics, onRetry, onStart } = props;
  const organization = useOrganization();
  const start = useSessionStart(onStart);
  let title = '今天学什么';
  let summary = '下一节会根据当前的复习和学习情况安排。';
  let message = '';
  let startLabel = '';
  let showContents = false;
  let showRetry = false;
  let todayLabel = '查看今天的安排和记录';
  let resuming = false;

  if (error) {
    message = `没能读取下一节：${error}`;
    showRetry = true;
  } else if (!preview) {
    summary = '正在读取下一节…';
  } else if (preview.open) {
    // 未完成的一节单独显示为"续课"面板，用它的原始范围说明；不会替换按当前范围挑好的内容
    const remaining = preview.open.items.filter(item => !item.done && !item.excluded).length;
    const originalScope = scopeLabel(organization.data, preview.open.scope);
    title = '接着上次学';
    summary = remaining > 0 ? `上一节还剩 ${remaining} 项 · 原范围：${originalScope}` : `上一节已作答完成，可以查看结果 · 原范围：${originalScope}`;
    startLabel = remaining > 0 ? '继续这一节' : '查看本节结果';
    showContents = remaining > 0;
    resuming = true;
  } else if (preview.capped) {
    title = '今天已学完';
    summary = `已完成 ${preview.sessionsToday} 节，达到你设置的每日上限。`;
    message = '可以回顾今天所学，也可以添加一个新的学习主题。';
    todayLabel = '回看今天所学';
  } else if (hasTopics === false) {
    summary = '从第一个主题开始。';
    message = '添加主题并完成摸底后，这里会告诉你下一节学什么。';
  } else if (preview.items.length > 0) {
    summary = `下一节 · 约 ${preview.estMinutes} 分钟`;
    startLabel = '开始今天的学习';
    showContents = true;
  } else if (preview.preparing) {
    title = '正在准备下一节';
    message = '准备好后，具体内容会自动出现在这里。现在也可以添加新主题。';
  } else {
    message = '暂时没有准备好的内容。可以先完成主题摸底，或在「今天」里构建新一节。';
  }

  return (
    <section className={`panel home-entry home-learning ${resuming ? 'resume-panel' : ''}`} aria-labelledby="home-learning-title">
      <div className="home-entry-label"><Icon name="today" />继续积累</div>
      <h2 id="home-learning-title" className="home-entry-title">{title}</h2>
      <p className="home-entry-sub" aria-live="polite">{summary}</p>
      <div className="home-preview">
        {showContents && <SessionContents preview={preview} limit={3} remainingOnly source={resuming ? 'open' : 'scope'} />}
        {!preview && !error && <SessionContents preview={null} limit={3} />}
        {message && <p className={error ? 'error-text' : 'muted'} role={error ? 'alert' : 'status'}>{message}</p>}
        {showRetry && <button type="button" className="btn" onClick={onRetry}>重新加载</button>}
      </div>
      <div className="home-learning-action">
        {startLabel && (
          <button type="button" className="btn primary large home-start" disabled={start.busy !== null} onClick={() => start.run(resuming ? 'resume' : 'start')}>
            {start.busy ? '正在打开…' : startLabel}<Icon name="chevron" />
          </button>
        )}
        {showContents && !resuming && preview && <p className="home-counts muted small">{describeCounts(preview)}</p>}
        {start.error && <p className="error-text" role="alert">{start.error}</p>}
        <a className={`home-today-link ${preview?.capped && !preview.open ? 'btn primary' : 'card-link small'}`} href={todayHash()}>{todayLabel}<Icon name="chevron" /></a>
      </div>
    </section>
  );
}

/**
 * 首页的学科 → 课程 → 主题结构，和管理页、侧栏共用同一份快照。
 * 未归类的主题单独放最后一组，避免被藏起来。
 */
function OrganizationTopics() {
  const { data } = useOrganization();
  if (!data) return null;
  return (
    <div className="topic-groups">
      {data.disciplines.map((node) => (
        <section key={node.discipline.id} className="topic-group" aria-labelledby={`home-discipline-${node.discipline.id}`}>
          <h3 id={`home-discipline-${node.discipline.id}`} className="topic-group-title">
            {node.discipline.name}
            <span className="muted small num">{node.counts.topics}</span>
          </h3>
          {node.courses.length === 0 && <p className="muted small">还没有专业课程，可以到「学科与课程」里添加。</p>}
          {node.courses.map((courseNode) => (
            <div key={courseNode.course.id} className="topic-subgroup">
              <h4 className="topic-subgroup-title">
                <a href={routeHash({ name: 'organization', courseId: courseNode.course.id })}>{courseNode.course.name}</a>
                <span className="muted small num">{courseNode.counts.topics}</span>
              </h4>
              {courseNode.topics.length === 0
                ? <p className="muted small">还没有学习主题。</p>
                : <TopicRows topics={courseNode.topics} />}
            </div>
          ))}
        </section>
      ))}
      {data.unclassified.length > 0 && (
        <section className="topic-group" aria-labelledby="home-unclassified">
          <h3 id="home-unclassified" className="topic-group-title">
            未归类
            <span className="muted small num">{data.unclassified.length}</span>
            <a className="card-link small" href={routeHash({ name: 'organization' })}>整理</a>
          </h3>
          <TopicRows topics={data.unclassified} />
        </section>
      )}
      {data.orphanTopics.length > 0 && (
        <section className="topic-group" aria-labelledby="home-orphan">
          <h3 id="home-orphan" className="topic-group-title">
            待整理
            <span className="muted small num">{data.orphanTopics.length}</span>
          </h3>
          <p className="muted small">这些主题指向的大类或课程已不存在，可在「学科与课程」里重新归类。</p>
          <TopicRows topics={data.orphanTopics} />
        </section>
      )}
    </div>
  );
}

/** 一组内的主题：最近添加的在前 */
function TopicRows({ topics }: { topics: OrganizationTopic[] }) {
  return (
    <div className="home-topic-list">
      {[...topics].reverse().map((topic) => (
        <a key={topic.id} className="home-topic" href={routeHash({ name: 'topic', topicId: topic.id })}>
          <Icon name="topic" />
          <span className="row-main">
            <span className="row-title">{topic.title}</span>
            <span className="row-sub">{topicStateText(topic)}</span>
          </span>
          <Icon name="chevron" />
        </a>
      ))}
    </div>
  );
}
