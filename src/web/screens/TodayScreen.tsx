import { useCallback, useState } from 'react';
import { type CognitiveMap, type Preview, type ReviewDay, type Session, type Today, type Topic, api } from '../api';
import { Icon } from '../components/Icon';
import { StageLadder } from '../components/StageLadder';
import { usePolling, useResource } from '../hooks';
import { PURPOSE_LABEL, formatDay } from '../labels';
import { openReview, routeHash } from '../router';

/** 首页要回答：下一节准备好了吗？现在学什么？ */
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

  return (
    <>
      <Greeting preview={preview.data} topics={topics} />
      <Tiles preview={preview.data} map={map.data} />
      <div className="grid top" style={{ marginTop: 16 }}>
        <section className="panel span-9" aria-labelledby="next-title">
          <NextSession preview={preview.data} error={preview.error} hasTopics={(topics ?? []).length > 0} onStart={onStart} />
        </section>
        <section className="panel span-3" aria-labelledby="slots-title">
          <Reminders today={today.data} />
        </section>
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
  else if (preview.preparing) fact = '下一节正在准备。';
  else fact = '现在没有要学的内容。';
  return (
    <header style={{ marginBottom: 40 }}>
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
const CUSTOM = 'custom';

/** 下一节：此刻打开会学什么，可选补充说明，一键开始 */
function NextSession(props: { preview: Preview | null; error: string; hasTopics: boolean; onStart: (session: Session, notice?: string) => void }) {
  const { preview, error, hasTopics, onStart } = props;
  const [guidance, setGuidance] = useState('');
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState('');
  const shown = preview?.items.slice(0, 6) ?? [];
  const guided = guidance.trim() !== '';

  async function start() {
    setBusy(true);
    setStartError('');
    try {
      const result = await api.nextSession(guided ? guidance.trim() : undefined);
      if (result.session) onStart(result.session, guidanceNotice(guided, result.resumed, result.guided));
      else if (result.capped) setStartError('今天已达到每日节数上限。');
      else setStartError(result.preparing ? '内容还在后台准备，稍等一会儿。' : '现在没有可学的内容。');
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header>
        <h2 id="next-title">
          下一节
          {preview && preview.items.length > 0 && !preview.open && <span className="chip">约 {preview.estMinutes} 分钟</span>}
        </h2>
        {preview && !preview.open && <span className="meta">时长上限 {preview.budgetMinutes} 分钟</span>}
      </header>

      {error && <p className="error-text">没能读取下一节：{error}</p>}
      {!preview && !error && (
        <div className="rows">
          {[0, 1, 2].map((i) => (
            <div key={i} className="row-card">
              <span className="skeleton line" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      )}
      {preview && !hasTopics && <div className="empty">还没有学习主题。在下方"学习主题"里输入一个想学的主题。</div>}
      {preview?.open && (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>
            上一节开始于 {new Date(preview.open.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，做完了 {preview.open.items.filter((i) => i.done).length} / {preview.open.items.length} 项。
          </p>
          <div className="rows">
            {preview.open.items.map((item, i) => (
              <div key={i} className="row-card">
                <span className={`pill ${item.purpose === 'new' ? 'accent' : ''}`}>{PURPOSE_LABEL[item.purpose]}</span>
                <div className="row-main">
                  <div className="row-title">{item.title}</div>
                  <div className="row-sub">
                    {item.topicTitle} · {item.formLabel}
                  </div>
                </div>
                <span className={`pill ${item.done ? 'pos' : ''}`}>{item.done ? '已做' : '待做'}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {preview && hasTopics && !preview.open && preview.items.length === 0 && (
        <div className="empty">{preview.capped ? '今天已学满，明天见。' : preview.preparing ? '内容正在后台准备，好了会自动显示。' : '暂时没有到期的复习，也没有可学的新知识点。'}</div>
      )}
      {preview && !preview.open && shown.length > 0 && (
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
            </div>
          ))}
          {preview.items.length > shown.length && <p className="muted small">还有 {preview.items.length - shown.length} 项</p>}
        </div>
      )}

      {preview && (preview.open || (preview.items.length > 0 && !preview.capped)) && (
        <div className="actions-row" style={{ alignItems: 'flex-end' }}>
          {!preview.open && (
            <div className="field" style={{ flex: '1 1 260px' }}>
              <label htmlFor="guidance">补充说明（可选）</label>
              <select
                id="guidance"
                className="select"
                disabled={busy}
                value={custom ? CUSTOM : guidance}
                onChange={(e) => {
                  const isCustom = e.target.value === CUSTOM;
                  setCustom(isCustom);
                  setGuidance(isCustom ? '' : e.target.value);
                }}
              >
                <option value="">不加，立即开始</option>
                {GUIDANCE_PRESETS.map((p) => (
                  <option key={p.label} value={p.text}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>自己写…</option>
              </select>
            </div>
          )}
          <button type="button" className="btn primary" onClick={start} disabled={busy}>
            {busy ? (guided ? '正在按补充说明生成…' : '正在打开…') : preview.open ? '继续这一节' : '开始这一节'}
          </button>
        </div>
      )}
      {custom && (
        <textarea
          className="textarea"
          style={{ marginTop: 12 }}
          rows={2}
          maxLength={500}
          value={guidance}
          disabled={busy}
          aria-label="自己写的补充说明"
          placeholder="例如：我是后端开发，多用 Node.js 的例子"
          onChange={(e) => setGuidance(e.target.value)}
        />
      )}
      {guided && !busy && <p className="muted small" style={{ marginTop: 8 }}>会按这段说明重新生成本节内容，大约需要半分钟到一分钟。</p>}
      {startError && <p className="error-text" style={{ marginTop: 8 }}>{startError}</p>}
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
      <form className="actions-row" onSubmit={create}>
        <input
          className="input"
          style={{ flex: '1 1 200px' }}
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="想学什么？例如：TypeScript 常用技能"
          aria-label="新的学习主题"
        />
        <button type="submit" className="btn" disabled={!title.trim() || busy}>
          <Icon name="plus" />
          添加主题
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
