import { useCallback, useState } from 'react';
import { type CognitiveMap, type Preview, type ReviewDay, type Session, type Today, type Topic, api } from '../api';
import { Icon } from '../components/Icon';
import { StageLadder } from '../components/StageLadder';
import { usePolling, useResource } from '../hooks';
import { PURPOSE_LABEL, formatDay } from '../labels';
import { openReview, routeHash } from '../router';

/**
 * 首页要回答：下一节准备好了吗？现在学什么？
 * 注意力顺序：问候语说出此刻的一件事 → 紧跟着唯一的主操作（开始/继续/构建）→ 这一节会学什么（依据）
 * → 今天的提醒 → 学习概况 → 主题与回看。统计数字放在主操作之后，不抢第一眼。
 */
export function TodayScreen(props: { topics: Topic[] | null; onTopicsChanged: () => void; onStart: (session: Session, notice?: string) => void }) {
  const { topics, onTopicsChanged, onStart } = props;
  const preview = useResource(() => api.preview(), []);
  const map = useResource(() => api.map(), []);
  const today = useResource(() => api.today(), []);
  const days = useResource(() => api.reviewDays().then((r) => r.days), []);

  const reloadPreview = preview.reload;
  const reloadMap = map.reload;
  const refreshAll = useCallback(() => {
    void reloadPreview();
    void reloadMap();
    onTopicsChanged();
  }, [reloadPreview, reloadMap, onTopicsChanged]);
  const generating = (topics ?? []).some((t) => t.graphStatus === 'pending' || t.placementStatus === 'preparing') || preview.data?.preparing === true;
  usePolling(generating, refreshAll);
  const hasTopics = (topics ?? []).length > 0;

  return (
    <>
      <Greeting preview={preview.data} topics={topics} />
      <ActionArea preview={preview.data} hasTopics={hasTopics} topics={topics} onStart={onStart} onTopicCreated={refreshAll} />
      {preview.error && <p className="error-text" style={{ marginTop: 12 }}>没能读取下一节：{preview.error}</p>}
      {hasTopics && (
        <div className="grid top section-gap">
          <section className="panel span-9" aria-labelledby="next-title">
            <NextContents preview={preview.data} />
          </section>
          <section className="panel span-3" aria-labelledby="slots-title">
            <Reminders today={today.data} />
          </section>
        </div>
      )}
      <h2 className="visually-hidden">学习概况</h2>
      <div style={{ marginTop: 16 }}>
        <Tiles preview={preview.data} map={map.data} />
      </div>
      <div className="grid top" style={{ marginTop: 16 }}>
        <section className="panel span-6" aria-labelledby="topics-title">
          <Topics topics={topics} map={map.data} onCreated={refreshAll} />
        </section>
        <section className="panel span-6" aria-labelledby="days-title">
          <Days days={days.data} />
        </section>
      </div>
    </>
  );
}

/** 问候语：说出此刻的一件事，由数据生成 */
function Greeting({ preview, topics }: { preview: Preview | null; topics: Topic[] | null }) {
  const hour = new Date().getHours();
  const hello = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  let fact = '';
  if (topics && topics.length === 0) fact = '先告诉我你想学什么。';
  else if (!preview) fact = '';
  else if (preview.open) fact = '上一节还没学完，接着学吧。';
  else if (preview.capped) fact = `今天的 ${preview.dailySessionCap} 节都学完了。`;
  else if (preview.items.length > 0) fact = `下一节已备好：${describeCounts(preview)}。`;
  else if (preview.preparing) fact = '下一节正在准备，也可以现在就构建。';
  else fact = '现在没有到期的内容，可以构建新的一节。';
  return (
    <header>
      <h1 className="greeting">
        {hello}。{fact}
      </h1>
      <p className="greeting-sub">
        {date}
        {preview && preview.items.length > 0 && !preview.open && !preview.capped ? ` · 约 ${preview.estMinutes} 分钟` : ''}
      </p>
    </header>
  );
}

function describeCounts(preview: Preview): string {
  const { counts } = preview;
  const parts = [
    counts.review + counts.contrast > 0 ? `${counts.review + counts.contrast} 道复习` : '',
    counts.spotCheck > 0 ? `${counts.spotCheck} 道抽查` : '',
    counts.advance > 0 ? `${counts.advance} 个重讲` : '',
    counts.new > 0 ? `${counts.new} 个新知识点` : '',
  ].filter(Boolean);
  return parts.join('、');
}

function Tiles({ preview, map }: { preview: Preview | null; map: CognitiveMap | null }) {
  const learned = map?.topics.reduce((n, t) => n + t.learned, 0) ?? 0;
  const total = map?.topics.reduce((n, t) => n + t.total, 0) ?? 0;
  const edge = map?.topics.reduce((n, t) => n + t.edge, 0) ?? 0;
  const topicCount = map?.topics.filter((t) => t.total > 0).length ?? 0;
  const loading = !preview || !map;
  return (
    <div className="grid tiles">
      <Tile label="今天到期" value={preview?.dueCount} caption={preview?.newPaused ? '复习积压，暂停新学' : '最容易忘的排在最前'} loading={loading} />
      <Tile label="已学会" value={learned} unit={total > 0 ? `/ ${total}` : undefined} caption={topicCount > 1 ? `跨 ${topicCount} 个主题` : '进入回忆及以后的阶段'} loading={loading} />
      <Tile label="下一步可学" value={edge} caption="前置都已学会" loading={loading} />
      <Tile
        label="今天已学"
        value={preview?.sessionsToday}
        unit={preview?.dailySessionCap ? `/ ${preview.dailySessionCap} 节` : '节'}
        caption={preview?.dailySessionCap ? '达到上限后不再开新的一节' : '不设每日上限'}
        loading={loading}
      />
    </div>
  );
}

function Tile(props: { label: string; value: number | undefined; unit?: string; caption: string; loading: boolean }) {
  return (
    <div className="tile span-3">
      <span className="tile-label">{props.label}</span>
      {props.loading || props.value === undefined ? (
        <span className="skeleton" style={{ width: 56, height: 35, marginTop: 8 }} />
      ) : (
        <span className="tile-value">
          {props.value}
          {props.unit && <small>{props.unit}</small>}
        </span>
      )}
      <span className="tile-caption">{props.caption}</span>
    </div>
  );
}

const GUIDANCE_PRESETS = [
  { label: '讲得更浅显', text: '讲得更浅显：少用术语，多用生活中的类比和例子。' },
  { label: '多结合实际场景', text: '多结合实际工作中会遇到的真实场景来举例和出题。' },
  { label: '多用图解释', text: '每段讲解都配图，用图把机制讲清楚。' },
  { label: '讲得更深入', text: '讲得更深入：多讲背后的原理、边界情况和常见的坑。' },
];

/**
 * 主操作区：紧跟问候语，是第一眼之后的落点。任何时候只有一个主按钮：
 * 有未完成的一节 → 继续；内容已备好 → 开始；没备好 → 现在构建。"构建新一节"是次要操作，
 * 点开后在原地展开说明框，主按钮换成"构建"，避免两个主按钮抢注意力。
 */
function ActionArea(props: {
  preview: Preview | null;
  hasTopics: boolean;
  topics: Topic[] | null;
  onStart: (session: Session, notice?: string) => void;
  onTopicCreated: () => void;
}) {
  const { preview, hasTopics, topics, onStart, onTopicCreated } = props;
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState<'start' | 'build' | null>(null);
  const [error, setError] = useState('');

  if (topics && !hasTopics) {
    return (
      <div className="action-area">
        <NewTopicForm onCreated={onTopicCreated} primary />
        <p className="muted" style={{ marginTop: 10 }}>
          可以是任何领域，比如"TypeScript 常用技能""摄影曝光基础"。系统会拆成知识点，先做 3 分钟摸底，再按你的情况安排每一节。
        </p>
      </div>
    );
  }
  if (!preview) return <div className="action-area"><span className="skeleton" style={{ display: 'inline-block', width: 160, height: 38 }} /></div>;

  async function run(kind: 'start' | 'build', guidance?: string) {
    setBusy(kind);
    setError('');
    try {
      const result = await api.nextSession({ guidance, fresh: kind === 'build' });
      if (result.session) onStart(result.session, guidanceNotice(Boolean(guidance), result.resumed, result.guided));
      else if (result.capped) setError('今天已达到每日节数上限，可以在设置里调整。');
      else setError(result.preparing ? '内容还在后台准备，稍等一会儿再试。' : '现在没有可学的内容：所有主题都在等摸底、已暂停，或已全部学完。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (composing) {
    return <Composer open={preview.open} busy={busy === 'build'} error={error} onBuild={(guidance) => run('build', guidance)} onCancel={() => setComposing(false)} />;
  }

  const remaining = preview.open ? preview.open.items.filter((i) => !i.done).length : 0;
  const ready = preview.items.length > 0;

  return (
    <div className="action-area">
      {preview.capped ? (
        <p className="muted">
          今天已学满 {preview.dailySessionCap} 节。想多学可以在<a className="card-link" href={routeHash({ name: 'settings' })}>设置</a>里调高每日上限。
        </p>
      ) : (
        <div className="actions-row" style={{ marginTop: 0 }}>
          {preview.open ? (
            <button type="button" className="btn primary large" onClick={() => run('start')} disabled={busy !== null}>
              {busy === 'start' ? '正在打开…' : `继续这一节 · 还剩 ${remaining} 项`}
            </button>
          ) : ready ? (
            <button type="button" className="btn primary large" onClick={() => run('start')} disabled={busy !== null}>
              {busy === 'start' ? '正在打开…' : `开始这一节 · 约 ${preview.estMinutes} 分钟`}
            </button>
          ) : (
            <button type="button" className="btn primary large" onClick={() => run('build')} disabled={busy !== null}>
              {busy === 'build' ? '正在构建，大约半分钟…' : '现在构建一节'}
            </button>
          )}
          <button type="button" className="btn large" onClick={() => setComposing(true)} disabled={busy !== null}>
            构建新一节…
          </button>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        {preview.open
          ? '"构建新一节"会提前结束上一节，没做的项之后重新安排。'
          : ready
            ? '想换个讲法或侧重点？用"构建新一节"写一句说明，按你的说明重新生成。'
            : '构建会当场生成这一节的内容，大约需要半分钟到一分钟。'}
      </p>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

/** 构建新一节：写一句说明引导内容（可选），常用说明一键填入后还能改 */
function Composer(props: { open: Preview['open']; busy: boolean; error: string; onBuild: (guidance?: string) => void; onCancel: () => void }) {
  const { open, busy, error, onBuild, onCancel } = props;
  const [text, setText] = useState('');
  const guidance = text.trim();
  return (
    <section className="panel white action-area composer" aria-labelledby="composer-title">
      <header>
        <h2 id="composer-title">构建新一节</h2>
        <button type="button" className="btn small ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </header>
      <div className="field">
        <label htmlFor="composer-text">想让这一节怎么讲？（可选）</label>
        <span className="hint">知识点按复习和学习进度挑选，说明只改变讲法、例子和出题的角度。</span>
        <div className="time-chips" style={{ margin: '4px 0' }}>
          {GUIDANCE_PRESETS.map((p) => (
            <button key={p.label} type="button" className={`btn small ${text === p.text ? 'selected' : ''}`} aria-pressed={text === p.text} onClick={() => setText(text === p.text ? '' : p.text)} disabled={busy}>
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          id="composer-text"
          autoFocus
          className="textarea"
          rows={3}
          maxLength={500}
          value={text}
          disabled={busy}
          placeholder="例如：我是后端开发，多用 Node.js 的例子"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {open && <p className="notice" style={{ marginTop: 12 }}>上一节还有 {open.items.filter((i) => !i.done).length} 项没做，构建后上一节提前结束，没做的之后重新安排。</p>}
      <div className="actions-row">
        <button type="button" className="btn primary large" onClick={() => onBuild(guidance || undefined)} disabled={busy}>
          {busy ? (guidance ? '正在按说明生成，大约半分钟到一分钟…' : '正在构建…') : guidance ? '按说明构建' : '直接构建'}
        </button>
      </div>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </section>
  );
}

/** 这一节会学什么：开始前的依据；有未完成的一节时显示它的进度 */
function NextContents({ preview }: { preview: Preview | null }) {
  const items = preview?.open ? preview.open.items : (preview?.items.map((i) => ({ ...i, done: false })) ?? []);
  const shown = items.slice(0, 6);
  return (
    <>
      <header>
        <h2 id="next-title">
          {preview?.open ? '上一节的进度' : '这一节会学什么'}
          {preview && !preview.open && preview.items.length > 0 && <span className="chip">约 {preview.estMinutes} 分钟</span>}
        </h2>
        {preview && !preview.open && <span className="meta">时长上限 {preview.budgetMinutes} 分钟</span>}
        {preview?.open && <span className="meta num">已做 {preview.open.items.filter((i) => i.done).length} / {preview.open.items.length}</span>}
      </header>
      {!preview && (
        <div className="rows">
          {[0, 1, 2].map((i) => (
            <div key={i} className="row-card">
              <span className="skeleton line" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      )}
      {preview && items.length === 0 && (
        <div className="empty">{preview.capped ? '今天已学满，明天见。' : preview.preparing ? '内容正在后台准备，好了会自动显示。' : '暂时没有到期的复习，也没有备好的新知识点。'}</div>
      )}
      {shown.length > 0 && (
        <div className="rows">
          {shown.map((item, i) => (
            <div key={i} className="row-card">
              <span className={`pill ${item.purpose === 'new' ? 'accent' : ''}`}>{PURPOSE_LABEL[item.purpose]}</span>
              <div className="row-main">
                <div className="row-title">{item.title}</div>
                <div className="row-sub">
                  {item.topicTitle} · {item.formLabel}
                </div>
              </div>
              {preview?.open && <span className={`pill ${item.done ? 'pos' : ''}`}>{item.done ? '已做' : '待做'}</span>}
            </div>
          ))}
          {items.length > shown.length && <p className="muted small">还有 {items.length - shown.length} 项</p>}
        </div>
      )}
    </>
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

function Reminders({ today }: { today: Today | null }) {
  return (
    <>
      <header>
        <h2 id="slots-title">今天的提醒</h2>
        <a className="card-link" href={routeHash({ name: 'settings' })}>
          设置
          <Icon name="chevron" />
        </a>
      </header>
      {!today && <span className="skeleton line" style={{ display: 'block', width: '60%' }} />}
      {today && today.slots.length === 0 && <div className="empty">还没有设提醒时段</div>}
      {today && today.slots.length > 0 && (
        <div className="rows">
          {today.slots.map((slot) => (
            <div key={slot.time} className="row-card" style={{ minHeight: 48 }}>
              <span className="row-main num" style={{ fontSize: 16 }}>
                {slot.time}
              </span>
              <span className={`pill ${slot.done ? 'pos' : ''}`}>{slot.done ? '已学完' : slot.time <= today.now ? '没赶上' : '待学'}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Topics({ topics, map, onCreated }: { topics: Topic[] | null; map: CognitiveMap | null; onCreated: () => void }) {
  return (
    <>
      <header>
        <h2 id="topics-title">
          学习主题
          {topics && <span className="chip">{topics.length}</span>}
        </h2>
        <a className="card-link" href={routeHash({ name: 'map' })}>
          认知地图
          <Icon name="chevron" />
        </a>
      </header>
      <div className="rows">
        {(topics ?? []).map((topic) => {
          const stages = map?.points.filter((p) => p.topicId === topic.id).map((p) => p.stage) ?? [];
          const info = map?.topics.find((t) => t.id === topic.id);
          return (
            <a key={topic.id} className="row-card" href={routeHash({ name: 'topic', topicId: topic.id })} style={{ alignItems: 'stretch', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="row-title" style={{ flex: 1 }}>
                  {topic.title}
                </span>
                <TopicState topic={topic} />
              </div>
              {topic.graphStatus === 'ready' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <StageLadder stages={stages} label={topic.title} />
                  </div>
                  <span className="muted small num">{info ? `已学会 ${info.learned} / ${info.total}` : ''}</span>
                </div>
              )}
            </a>
          );
        })}
      </div>
      <div style={{ marginTop: 16 }}>
        <NewTopicForm onCreated={onCreated} />
      </div>
    </>
  );
}

/** 添加学习主题；没有任何主题时作为首页的主操作 */
function NewTopicForm({ onCreated, primary = false }: { onCreated: () => void; primary?: boolean }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createTopic(title);
      setTitle('');
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="actions-row" style={{ marginTop: 0 }} onSubmit={create}>
        <input
          className={`input ${primary ? 'large' : ''}`}
          style={{ flex: '1 1 240px', maxWidth: primary ? 560 : undefined }}
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="想学什么？例如：TypeScript 常用技能"
          aria-label="新的学习主题"
        />
        <button type="submit" className={`btn ${primary ? 'primary large' : ''}`} disabled={!title.trim() || busy}>
          <Icon name="plus" />
          {primary ? '开始学这个主题' : '添加主题'}
        </button>
      </form>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </>
  );
}

function TopicState({ topic }: { topic: Topic }) {
  if (topic.graphStatus === 'pending') return <span className="pill">正在生成知识图谱</span>;
  if (topic.graphStatus === 'failed') return <span className="pill neg">图谱生成失败</span>;
  if (topic.placementStatus === 'pending') return <span className="pill warn">待摸底</span>;
  if (topic.placementStatus === 'preparing') return <span className="pill">正在准备摸底</span>;
  if (topic.placementStatus === 'testing') return <span className="pill warn">摸底进行中</span>;
  if (topic.status === 'paused') return <span className="pill">已暂停</span>;
  return null;
}

function Days({ days }: { days: ReviewDay[] | null }) {
  const recent = days?.slice(0, 5) ?? [];
  const older = days?.slice(5) ?? [];
  return (
    <>
      <header>
        <h2 id="days-title">按天回看</h2>
        <span className="meta">在新标签页打开</span>
      </header>
      {days && days.length === 0 && <div className="empty">学完第一节后，这里可以按天重读当时的讲解。</div>}
      <div className="rows">
        {recent.map((d) => (
          <button key={d.day} type="button" className="row-card" onClick={() => openReview(d.day)}>
            <span className="row-main">
              <span className="row-title">{formatDay(d.day)}</span>
            </span>
            <span className="row-end">
              {d.pointCount} 个知识点
              <Icon name="external" />
            </span>
          </button>
        ))}
      </div>
      {older.length > 0 && (
        <select className="select" style={{ marginTop: 12 }} defaultValue="" aria-label="更早的日期" onChange={(e) => e.target.value && openReview(e.target.value)}>
          <option value="">更早的日期…</option>
          {older.map((d) => (
            <option key={d.day} value={d.day}>
              {formatDay(d.day)}（{d.pointCount} 个知识点）
            </option>
          ))}
        </select>
      )}
    </>
  );
}
