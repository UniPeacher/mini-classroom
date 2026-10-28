import { useCallback, useEffect, useMemo, useState } from 'react';
import { type LearningScope, type Preview, type ReviewDay, type Session, type Today, api } from '../api';
import { Icon } from '../components/Icon';
import { SessionContents, useSessionStart } from '../components/SessionPreview';
import { usePolling, useResource } from '../hooks';
import { formatDay } from '../labels';
import { useOrganization, scopeLabel } from '../organization';
import type { OrganizationSnapshot } from '../organization';
import { openReview, rememberScope, routeHash, sameScope } from '../router';

/**
 * 当天的学习安排与记录。
 * 先选范围（全部 / 学科 / 课程），这一节的预览、到期统计和开始都用同一个范围；
 * 存在未完成的一节时单独显示续课面板和它的原范围，不静默替换。
 */
export function TodayScreen({ scope, onStart }: { scope: LearningScope; onStart: (session: Session, notice?: string) => void }) {
  const organization = useOrganization();
  // 换范围后旧预览立即失效：不能一边显示新范围名、一边列着上一个范围的内容
  const scopeKey = `${scope.kind}:${scope.id ?? ''}`;
  // 只要地址里带了范围，就算一次明确选择：之后从侧栏回来保持同一范围
  useEffect(() => {
    rememberScope(scope);
  }, [scopeKey]);
  const preview = useResource(() => api.preview({ scope }), [scope.kind, scope.id], { staleKey: scopeKey });
  const today = useResource(() => api.today(), []);
  const days = useResource(() => api.reviewDays().then((r) => r.days), []);
  const reloadPreview = preview.reload;
  const refreshAll = useCallback(() => {
    void reloadPreview();
    void organization.reload();
  }, [reloadPreview, organization.reload]);
  const generating = preview.data?.preparing === true;
  usePolling(generating, refreshAll);
  const topics = useMemo(() => allTopics(organization.data), [organization.data]);
  const hasTopics = topics.length > 0;
  const scopeName = scopeLabel(organization.data, scope);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>今天的学习</h1>
          <p className="sub">
            {today.data ? `${formatDay(today.data.date)} · 已完成 ${today.data.sessionsToday} 节${today.data.dailySessionCap !== null ? ` · 每日上限 ${today.data.dailySessionCap} 节` : ''}` : '查看当天的学习安排和记录。'}
          </p>
        </div>
        <a className="card-link" href={routeHash({ name: 'home' })}>去首页添加新主题<Icon name="chevron" /></a>
      </div>
      <ScopePicker scope={scope} />
      {preview.error ? <p className="error-text" role="alert">没能读取下一节：{preview.error} <button className="card-link" type="button" onClick={preview.reload}>重新加载</button></p>
        : <ActionArea preview={preview.data} hasTopics={hasTopics} scope={scope} scopeName={scopeName} snapshot={organization.data} onRetry={reloadPreview} onStart={onStart} />}
      <div className="grid top section-gap">
        <section className="panel span-8" aria-labelledby="next-title">
          {preview.error ? <><header><h2 id="next-title">这一节会学什么</h2></header><p className="muted">重新加载后查看当前安排。</p></> : <NextContents preview={preview.data} scopeName={scopeName} />}
        </section>
        <section className="panel span-4" aria-labelledby="slots-title">
          {today.error ? <><header><h2 id="slots-title">今天的提醒</h2></header><p className="error-text" role="alert">{today.error} <button type="button" className="card-link" onClick={today.reload}>重新加载</button></p></> : <Reminders today={today.data} />}
        </section>
      </div>
      <div className="grid top" style={{ marginTop: 16 }}>
        <section className="panel span-8" aria-labelledby="today-records-title"><DailyRecords day={today.data?.date} dateError={today.error} /></section>
        <section className="panel span-4" aria-labelledby="days-title">
          {days.error ? <><header><h2 id="days-title">按天回看</h2></header><p className="error-text" role="alert">{days.error} <button type="button" className="card-link" onClick={days.reload}>重新加载</button></p></> : <Days days={days.data} />}
        </section>
      </div>
    </>
  );
}

function allTopics(snapshot: ReturnType<typeof useOrganization>['data']): { id: string; title: string; courseId: string | null }[] {
  if (!snapshot) return [];
  return snapshot.allTopics.map((topic) => ({ id: topic.id, title: topic.title, courseId: topic.courseId }));
}

/**
 * 学习范围：全部（含未归类）、某个学科、某门课程。
 * 范围写进页面地址，刷新或返回时不用重新选择；预览和开始课堂共用这一份。
 */
function ScopePicker({ scope }: { scope: LearningScope }) {
  const organization = useOrganization();
  const snapshot = organization.data;
  const link = (next: LearningScope) => routeHash({ name: 'today', scope: next });
  const isCurrent = (next: LearningScope) => sameScope(scope, next);
  if (organization.error) return <p className="error-text small" role="alert">没能读取学科与课程：{organization.error}</p>;
  if (!snapshot) return null;
  const hasStructure = snapshot.disciplines.length > 0 && snapshot.allCoursesCount > 0;
  return (
    <div className="scope-picker" style={{ marginBottom: 16 }}>
      {hasStructure ? (
        <div className="scope-row">
          <label className="scope-field">
            <span className="label">学习范围</span>
            <select
              className="select"
              value={scope.kind === 'all' ? '' : `${scope.kind}:${scope.id}`}
              aria-label="学习范围"
              onChange={(event) => {
                const value = event.target.value;
                const next: LearningScope = value ? { kind: value.split(':')[0] as 'course' | 'discipline', id: value.split(':').slice(1).join(':') } : { kind: 'all' };
                // 记下这次明确选择，侧栏等入口回来时保持同一范围
                rememberScope(next);
                window.location.hash = routeHash({ name: 'today', scope: next });
              }}
            >
              <option value="">全部范围（含未归类）</option>
              {snapshot.disciplines.map((node) => (
                <optgroup key={node.discipline.id} label={node.discipline.name}>
                  <option value={`discipline:${node.discipline.id}`}>{node.discipline.name} · 全部课程</option>
                  {node.courses.map((courseNode) => (
                    <option key={courseNode.course.id} value={`course:${courseNode.course.id}`}>
                      {node.discipline.name} / {courseNode.course.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <a className="card-link small" href={routeHash({ name: 'organization' })}>管理学科与课程<Icon name="chevron" /></a>
        </div>
      ) : (
        <p className="muted small">还没有学科与课程结构，这一节按全部主题安排。<a className="card-link" href={link({ kind: 'all' })}> 全部范围</a></p>
      )}
      {scope.kind !== 'all' && (
        <p className="muted small scope-note">
          这一节只在「{scopeLabel(snapshot, scope)}」内安排：复习和新学都来自这个范围。范围外到期的复习会单独提示数量，不混入这一节，也不改变到期时间。
        </p>
      )}
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
 * 当天的学习操作顺序：
 * 1. 有未完成的一节 → 续课面板（显式继续，显示原范围）；要结束它并开新一节需明确确认。
 * 2. 否则按当前范围开始或构建。
 */
export function ActionArea(props: {
  preview: Preview | null;
  hasTopics: boolean;
  scope: LearningScope;
  scopeName: string;
  snapshot: OrganizationSnapshot | null;
  onRetry: () => Promise<void>;
  onStart: (session: Session, notice?: string) => void;
}) {
  const { preview, hasTopics, scope, scopeName, snapshot, onRetry, onStart } = props;
  const [composing, setComposing] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const start = useSessionStart(onStart);

  if (!hasTopics) {
    return (
      <div className="action-area">
        <p className="muted">还没有学习主题。先到首页添加一个想学的主题，再完成摸底。</p>
        <a className="btn primary" href={routeHash({ name: 'home' })} style={{ marginTop: 12 }}>去首页添加主题</a>
      </div>
    );
  }
  if (!preview) return <div className="action-area"><span className="skeleton" style={{ display: 'inline-block', width: 160, height: 38 }} /></div>;

  const open = preview.open;
  if (open) {
    const remaining = open.items.filter((i) => !i.done && !i.excluded).length;
    const originalScope = scopeLabel(snapshot, open.scope ?? null);
    return (
      <div className="action-area">
        <section className="panel white resume-panel" aria-labelledby="resume-title">
          <header>
            <h2 id="resume-title">继续上次课堂</h2>
            <span className="meta">原范围：{originalScope}</span>
          </header>
          <p className="muted small" style={{ marginBottom: 12 }}>
            {remaining > 0
              ? `这一节还剩 ${remaining} 项没做。当前选择的范围只作用于新课堂，不会替换它。`
              : '这一节已作答完成，可以查看结果或结束它。'}
          </p>
          <SessionContents preview={preview} source="open" />
          <div className="actions-row">
            <button type="button" className="btn primary large" onClick={() => void start.run('resume')} disabled={start.busy !== null}>
              {start.busy === 'resume' ? '正在打开…' : remaining > 0 ? '继续这一节' : '查看本节结果'}
            </button>
            <a className="btn large" href={routeHash({ name: 'learn' })}>打开学习页</a>
          </div>
          {start.error && <p className="error-text" role="alert">{start.error}</p>}
        </section>
        <section className="panel" aria-labelledby="new-session-title" style={{ marginTop: 16 }}>
          <header><h2 id="new-session-title">按当前范围开新一节</h2><span className="meta">{scopeName}</span></header>
          <p className="muted small">
            结束上面这一节（没做的项之后重新安排），再按「{scopeName}」构建新的一节。
            新内容准备好之前，旧的一节仍然保留；准备失败不会提前结束它。
          </p>
          {!confirmNew ? (
            <div className="actions-row">
              <button type="button" className="btn" onClick={() => setConfirmNew(true)} disabled={start.busy !== null}>按新范围开始…</button>
            </div>
          ) : (
            <div className="confirm-inline">
              <p className="notice">确定结束上一节并开始新的吗？</p>
              <div className="actions-row" style={{ marginTop: 0 }}>
                <button type="button" className="btn primary" onClick={() => void start.run('build', { scope })} disabled={start.busy !== null}>
                  {start.busy === 'build' ? '正在构建，大约半分钟…' : '结束上一节并开始'}
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirmNew(false)} disabled={start.busy !== null}>取消</button>
              </div>
              {start.error && <p className="error-text" role="alert">{start.error}</p>}
            </div>
          )}
        </section>
      </div>
    );
  }

  if (composing) {
    return <Composer busy={start.busy === 'build'} error={start.error} scopeName={scopeName} onBuild={(guidance) => void start.run('build', { guidance, scope })} onCancel={() => setComposing(false)} />;
  }

  const ready = preview.items.length > 0;
  return (
    <div className="action-area">
      {preview.capped ? (
        <p className="muted">
          今天已学满 {preview.dailySessionCap} 节。想多学可以在<a className="card-link" href={routeHash({ name: 'personalization', tab: 'learning' })}>个性化 · 学习节奏</a>里调高每日上限。
        </p>
      ) : (
        <div className="actions-row" style={{ marginTop: 0 }}>
          {ready ? (
            <button type="button" className="btn primary large" onClick={() => void start.run('start', { scope })} disabled={start.busy !== null}>
              {start.busy === 'start' ? '正在打开…' : `开始这一节 · 约 ${preview.estMinutes} 分钟`}
            </button>
          ) : (
            <button type="button" className="btn primary large" onClick={() => void start.run('build', { scope })} disabled={start.busy !== null}>
              {start.busy === 'build' ? '正在构建，大约半分钟…' : '现在构建一节'}
            </button>
          )}
          <button type="button" className="btn large" onClick={() => setComposing(true)} disabled={start.busy !== null}>
            构建新一节…
          </button>
        </div>
      )}
      {!preview.capped && (
        <p className="muted small" style={{ marginTop: 10 }}>
          {ready
            ? '想换个讲法或侧重点？用"构建新一节"写一句说明，按你的说明重新生成。'
            : '构建会当场生成这一节的内容，大约需要半分钟到一分钟。'}
        </p>
      )}
      {preview.outsideDueCount !== undefined && preview.outsideDueCount > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          范围外还有 {preview.outsideDueCount} 个到期复习，切回全部范围后才会安排。
        </p>
      )}
      {start.error && <p className="error-text" style={{ marginTop: 8 }}>{start.error}</p>}
      {start.openConflict && (
        <p className="notice" style={{ marginTop: 12 }}>
          已有一节没完成。请在上面选择"继续这一节"，或明确结束它再开新的一节。
          <button type="button" className="card-link" style={{ marginLeft: 8 }} onClick={() => { start.clearConflict(); void onRetry(); }}>刷新安排</button>
        </p>
      )}
    </div>
  );
}

/** 构建新一节：写一句说明引导内容（可选），常用说明一键填入后还能改 */
export function Composer(props: { busy: boolean; error: string; scopeName: string; onBuild: (guidance?: string) => void; onCancel: () => void }) {
  const { busy, error, scopeName, onBuild, onCancel } = props;
  const [text, setText] = useState('');
  const guidance = text.trim();
  return (
    <section className="panel white action-area composer" aria-labelledby="composer-title">
      <header>
        <h2 id="composer-title">构建新一节</h2>
        <span className="meta">{scopeName}</span>
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
/**
 * 这一节会学什么：始终预览"按当前所选范围组装的新内容"。
 * 未完成的那一节只出现在上面的续课面板里；这里绝不改显示它，
 * 否则用户会以为新范围里就是这些旧内容。
 */
export function NextContents({ preview, scopeName }: { preview: Preview | null; scopeName: string }) {
  return (
    <>
      <header>
        <h2 id="next-title">
          {preview?.capped ? '今天已达到学习上限' : '这一节会学什么'}
          {preview && !preview.capped && preview.items.length > 0 && <span className="chip">约 {preview.estMinutes} 分钟</span>}
        </h2>
        {preview && !preview.capped && <span className="meta">范围：{scopeName} · 时长上限 {preview.budgetMinutes} 分钟</span>}
      </header>
      <SessionContents
        preview={preview && preview.capped ? { ...preview, items: [] } : preview}
        source="next"
      />
      {preview && preview.dueCount !== undefined && (
        <p className="muted small" style={{ marginTop: 10 }}>范围内今天到期 {preview.dueCount} 个知识点。</p>
      )}
    </>
  );
}

function Reminders({ today }: { today: Today | null }) {
  return (
    <>
      <header>
        <h2 id="slots-title">今天的提醒</h2>
        <a className="card-link" href={routeHash({ name: 'personalization', tab: 'learning' })}>
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

/** 今天的记录按服务端返回的业务日期读取，保留按天回看的完整内容入口。 */
function DailyRecords({ day, dateError }: { day?: string; dateError: string }) {
  const review = useResource(() => day ? api.dayReview(day) : Promise.resolve(null), [day]);
  const entries = review.data?.entries ?? [];
  const shown = entries.slice(-5).reverse();
  const pointCount = new Set(entries.map(entry => entry.point.id)).size;

  return (
    <>
      <header><h2 id="today-records-title">今天的学习记录</h2>{day && entries.length > 0 && <button type="button" className="card-link" onClick={() => openReview(day)}>完整回看<Icon name="external" /></button>}</header>
      {review.error ? <p className="error-text" role="alert">没能读取今天的记录：{review.error} <button type="button" className="card-link" onClick={review.reload}>重新加载</button></p>
        : !day && dateError ? <p className="muted">重新加载今天的安排后，即可读取当天的学习记录。</p>
          : !day || !review.data ? <p className="muted">正在读取今天的记录…</p>
          : entries.length === 0 ? <p className="muted">今天还没有学习记录，完成作答后会显示在这里。</p>
            : <>
              <p className="muted small" style={{ marginBottom: 12 }}>学过 {pointCount} 个知识点 · {entries.length} 次作答</p>
              <div className="rows">{shown.map(({ point, topicTitle, record }) => (
                <div key={record.attemptId} className="row-card">
                  <span className="row-main"><span className="row-title">{point.title}</span><span className="row-sub">{topicTitle}</span></span>
                  <time className="row-end small" dateTime={record.at}>{new Date(record.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
              ))}</div>
              {entries.length > shown.length && <p className="muted small" style={{ marginTop: 10 }}>最近 {shown.length} 次作答，完整回看中可查看全部记录。</p>}
            </>}
    </>
  );
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
