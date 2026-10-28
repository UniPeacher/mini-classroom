import { useEffect, useMemo, useState } from 'react';
import { type Course, type Discipline, type OrganizationImpact, type OrganizationTopic, type PresetId, api, combineImpacts } from '../api';
import { Icon } from '../components/Icon';
import { useResource } from '../hooks';
import { type OrganizationSnapshot, coursePath, presetCatalog, presetLabel, useOrganization } from '../organization';
import { useDraftGuard } from '../drafts';
import { navigate, routeHash } from '../router';

type Selection = { kind: 'all' } | { kind: 'unclassified' } | { kind: 'discipline'; id: string } | { kind: 'course'; id: string };

type Draft =
  | { kind: 'discipline'; id: string; name: string; presetId: PresetId }
  | { kind: 'course'; id: string; name: string; disciplineId: string };

type PendingImpact = { impact: OrganizationImpact; save: () => Promise<void> };

/**
 * 学科与课程：左侧「全部 / 未归类 / 学科 → 课程」树，右侧所选对象详情。
 * 所有修改都走"编辑 → 保存 / 取消"，保存前若会重新准备内容，先显示影响数量和确认。
 */
export function OrganizationScreen({ disciplineId, courseId, unclassified }: { disciplineId?: string; courseId?: string; unclassified?: boolean }) {
  const organization = useOrganization();
  const settings = useResource(() => api.settings(), []);
  const presets = useMemo(() => presetCatalog(settings.data), [settings.data]);
  const data = organization.data;
  const selection: Selection = courseId ? { kind: 'course', id: courseId } : disciplineId ? { kind: 'discipline', id: disciplineId } : unclassified ? { kind: 'unclassified' } : { kind: 'all' };

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [stamp, setStamp] = useState('');
  const [pendingImpact, setPendingImpact] = useState<PendingImpact | null>(null);

  const saved = useMemo<Draft | null>(() => {
    if (!data) return null;
    if (selection.kind === 'discipline') {
      const discipline = data.disciplineById.get(selection.id);
      return discipline ? { kind: 'discipline', id: discipline.id, name: discipline.name, presetId: discipline.presetId } : null;
    }
    if (selection.kind === 'course') {
      const course = data.courseById.get(selection.id);
      return course ? { kind: 'course', id: course.id, name: course.name, disciplineId: course.disciplineId } : null;
    }
    return null;
  }, [data, selection.kind, selection.kind === 'discipline' ? selection.id : selection.kind === 'course' ? selection.id : '']);

  const draftKey = saved ? `${saved.kind}:${saved.id}` : '';
  const draft = (draftKey ? drafts[draftKey] : null) ?? null;
  const dirty = Boolean(draft && saved && !sameDraft(draft, saved));
  // 其他对象上仍有未保存的草稿也要登记：切到别的对象再离开页面同样会丢
  const hasAnyDraft = Object.keys(drafts).length > 0;
  useDraftGuard(hasAnyDraft, '学科与课程的修改还没保存');

  /** 只改当前对象的草稿；传 null 清掉当前对象，保留其他对象上的编辑 */
  const setDraft = (next: Draft | null) => {
    setDrafts((current) => {
      const copy = { ...current };
      if (saved) delete copy[`${saved.kind}:${saved.id}`];
      if (next) copy[`${next.kind}:${next.id}`] = next;
      return copy;
    });
  };

  /** 保存或取消成功后清掉这个对象的草稿，其他对象不动 */
  const clearDraft = (target: Draft) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[`${target.kind}:${target.id}`];
      return next;
    });
  };

  const refresh = async () => {
    await organization.reload();
  };

  /** 删除成功后刷新快照并回到全部；非空删除由后端拒绝，这里只显示错误 */
  const handleDeleted = async (target: Draft) => {
    // 只丢弃被删除对象的草稿，其他对象上的编辑继续保留
    clearDraft(target);
    await organization.reload();
    navigate({ name: 'organization' });
  };

  if (organization.error) {
    return (
      <>
        <div className="title-row"><div><h1>学科与课程</h1><p className="sub">按大类 → 课程 → 主题整理学习内容。</p></div></div>
        <p className="error-text" role="alert">
          没能读取学科与课程：{organization.error}{' '}
          <button type="button" className="card-link" onClick={() => void organization.reload()}>重新加载</button>
        </p>
      </>
    );
  }

  const select = (next: Selection) => {
    if (next.kind === 'course') navigate({ name: 'organization', courseId: next.id });
    else if (next.kind === 'discipline') navigate({ name: 'organization', disciplineId: next.id });
    else if (next.kind === 'unclassified') navigate({ name: 'organization', unclassified: true });
    else navigate({ name: 'organization' });
  };

  /**
   * 保存分两种情形：
   * - 只改名称：不影响教学内容，直接保存，不请求影响统计。
   * - 改教学内容（换预设、移动课程、归类主题）：必须先拿到影响统计；
   *   拿不到就报错并保留草稿，绝不"先保存再说"——否则可能隐藏模型调用，
   *   或因缺少确认被后端拒绝，用户只看到一条难懂的冲突错误。
   */
  async function submitSave(plan: SavePlan) {
    if (plan.kind === 'name-only') {
      await runSave(plan.apply);
      return;
    }
    setSaving(true);
    setSaveError('');
    setStamp('');
    let decision: SaveDecision;
    try {
      decision = await decideTeachingSave(plan);
    } catch (e) {
      setSaveError(`没能读取这次修改的影响，尚未保存。请重试：${(e as Error).message}`);
      setSaving(false);
      return;
    }
    if (decision.action === 'confirm') {
      setSaving(false);
      setPendingImpact({ impact: decision.impact, save: async () => { setPendingImpact(null); await runSave(plan.apply); } });
      return;
    }
    await runSave(plan.apply);
  }

  async function runSave(apply: () => Promise<void>) {
    const target = saved;
    setSaving(true);
    setSaveError('');
    try {
      await apply();
      await refresh();
      if (target) clearDraft(target);
      setPendingImpact(null);
      setStamp(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      // 保存失败保留已编辑内容
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 取消只丢弃当前对象的草稿，其他对象上的编辑继续保留 */
  const cancelCurrent = () => {
    if (saved) clearDraft(saved);
    setPendingImpact(null);
    setSaveError('');
  };

  const edited = draft ?? saved;
  const otherDrafts = Object.entries(drafts).filter(([key]) => key !== draftKey);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>学科与课程</h1>
          <p className="sub">学科大类决定教学预设，专业课程容纳学习主题。未归类的主题照常学习，随时可以整理。</p>
        </div>
        <p className="muted small" role="status">{saveError ? <span className="error-text">{saveError}</span> : stamp}</p>
      </div>
      {otherDrafts.length > 0 && (
        <p className="notice unsaved-other">
          还有 {otherDrafts.length} 个对象的修改没保存：{otherDrafts.map(([key, item]) => `${item.kind === 'discipline' ? '学科' : '课程'}「${item.name}」`).join('、')}。
          切回对应对象可以继续编辑，离开本页前会提醒。
        </p>
      )}
      {organization.loading && !data ? <p className="muted">正在读取学科与课程…</p> : !data ? null : (
        <div className="organization-layout">
          <OrganizationTree data={data} selection={selection} presets={presets} onSelect={select} draftIds={new Set(Object.keys(drafts))} />
          <section className="panel organization-detail" aria-labelledby="organization-detail-title">
            {selection.kind === 'all' && <AllOverview data={data} presets={presets} />}
            {selection.kind === 'unclassified' && <UnclassifiedPane data={data} />}
            {selection.kind === 'discipline' && edited?.kind === 'discipline' && (
              <DisciplineDetail
                data={data}
                discipline={data.disciplineById.get(selection.id)!}
                draft={draft?.kind === 'discipline' ? draft : null}
                presets={presets}
                saving={saving}
                onEdit={() => { if (!draft) { const discipline = data.disciplineById.get(selection.id)!; setDraft({ kind: 'discipline', id: discipline.id, name: discipline.name, presetId: discipline.presetId }); } setSaveError(''); }}
                onCancel={cancelCurrent}
                onChange={(next) => setDraft(next)}
                onSave={() => void saveDiscipline(data, draft as Extract<Draft, { kind: 'discipline' }>, submitSave)}
                onSelectCourse={(id) => select({ kind: 'course', id })}
                onDeleted={async () => { if (saved) await handleDeleted(saved); }}
              />
            )}
            {selection.kind === 'course' && edited?.kind === 'course' && (
              <CourseDetail
                data={data}
                course={data.courseById.get(selection.id)!}
                draft={draft?.kind === 'course' ? draft : null}
                presets={presets}
                saving={saving}
                onEdit={() => { if (!draft) { const course = data.courseById.get(selection.id)!; setDraft({ kind: 'course', id: course.id, name: course.name, disciplineId: course.disciplineId }); } setSaveError(''); }}
                onCancel={cancelCurrent}
                onChange={(next) => setDraft(next)}
                onSave={() => void saveCourse(data, draft as Extract<Draft, { kind: 'course' }>, submitSave)}
                onDone={refresh}
                onDeleted={async () => { if (saved) await handleDeleted(saved); }}
                onError={setSaveError}
                onStamp={setStamp}
              />
            )}
            {((selection.kind === 'discipline' && !data.disciplineById.has(selection.id)) || (selection.kind === 'course' && !data.courseById.has(selection.id))) && (
              <div className="empty">这个对象已不存在。<button type="button" className="card-link" onClick={() => select({ kind: 'all' })}>返回全部</button></div>
            )}
            {pendingImpact && (
              <ImpactConfirm
                impact={pendingImpact.impact}
                saving={saving}
                onConfirm={() => void pendingImpact.save()}
                onCancel={() => setPendingImpact(null)}
              />
            )}
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
          </section>
        </div>
      )}
      {data?.migrationReport && <MigrationReport report={data.migrationReport} />}
    </>
  );
}

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.name !== b.name) return false;
  return a.kind === 'discipline' ? a.presetId === (b as Extract<Draft, { kind: 'discipline' }>).presetId : a.disciplineId === (b as Extract<Draft, { kind: 'course' }>).disciplineId;
}

function sameLevelDuplicate(kind: 'discipline' | 'course', name: string, data: OrganizationSnapshot, excludeId: string, parentId?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (kind === 'discipline') return data.disciplines.some((node) => node.discipline.id !== excludeId && node.discipline.name === trimmed);
  return data.disciplines.some((node) => node.courses.some((courseNode) => courseNode.course.id !== excludeId && courseNode.course.disciplineId === parentId && courseNode.course.name === trimmed));
}

/**
 * 保存计划：只有名称变化时不必评估教学影响；其余改动都算教学变更。
 */
export type SavePlan =
  | { kind: 'name-only'; apply: () => Promise<void> }
  | { kind: 'teaching'; apply: () => Promise<void>; impact: () => Promise<OrganizationImpact> };

/** 把校验错误和保存计划分开，避免用假的"零影响"混进教学变更的路径 */
export function rejectedSave(message: string): SavePlan {
  return { kind: 'name-only', apply: () => Promise.reject(new Error(message)) };
}

/** 教学变更的保存决定：直接保存，或先给用户看影响再确认 */
export type SaveDecision =
  | { action: 'save' }
  | { action: 'confirm'; impact: OrganizationImpact };

/**
 * 教学变更（换预设 / 移动课程 / 归类主题）的保存前判断。
 * 影响统计失败时直接抛出，由调用方报错并保留草稿；
 * 这里绝不返回"可以保存"，否则会在未经确认的情况下触发重新备课与模型调用。
 */
export async function decideTeachingSave(plan: Extract<SavePlan, { kind: 'teaching' }>): Promise<SaveDecision> {
  const impact = await plan.impact();
  return needsImpactConfirm(impact) ? { action: 'confirm', impact } : { action: 'save' };
}

async function saveDiscipline(
  data: OrganizationSnapshot,
  draft: Extract<Draft, { kind: 'discipline' }>,
  save: (plan: SavePlan) => Promise<void>,
) {
  const name = draft.name.trim();
  if (!name) return save(rejectedSave('学科名称不能为空'));
  if (sameLevelDuplicate('discipline', name, data, draft.id)) return save(rejectedSave(`学科「${name}」已存在，请换一个名称`));
  const original = data.disciplineById.get(draft.id)!;
  const patch: { name?: string; presetId?: PresetId } = {};
  if (name !== original.name) patch.name = name;
  if (draft.presetId !== original.presetId) patch.presetId = draft.presetId;
  if (Object.keys(patch).length === 0) return;
  const apply = async () => {
    await api.updateDiscipline(draft.id, { ...patch, confirmed: true });
  };
  // 只改名：不涉及教学内容，直接保存
  if (patch.presetId === undefined) return save({ kind: 'name-only', apply });
  return save({
    kind: 'teaching',
    apply,
    impact: () => api.organizationImpact({ kind: 'discipline', id: draft.id, presetId: draft.presetId }),
  });
}

async function saveCourse(
  data: OrganizationSnapshot,
  draft: Extract<Draft, { kind: 'course' }>,
  save: (plan: SavePlan) => Promise<void>,
) {
  const name = draft.name.trim();
  if (!name) return save(rejectedSave('课程名称不能为空'));
  if (sameLevelDuplicate('course', name, data, draft.id, draft.disciplineId)) return save(rejectedSave(`这个学科下已有课程「${name}」`));
  const original = data.courseById.get(draft.id)!;
  const patch: { name?: string; disciplineId?: string } = {};
  if (name !== original.name) patch.name = name;
  if (draft.disciplineId !== original.disciplineId) patch.disciplineId = draft.disciplineId;
  if (Object.keys(patch).length === 0) return;
  const apply = async () => {
    await api.updateCourse(draft.id, { ...patch, confirmed: true });
  };
  if (patch.disciplineId === undefined) return save({ kind: 'name-only', apply });
  return save({
    kind: 'teaching',
    apply,
    impact: () => api.organizationImpact({ kind: 'course', id: draft.id, disciplineId: draft.disciplineId }),
  });
}

/**
 * 只有真的会作废待学内容或可能调用模型时才需要确认。
 * 单纯改名、换到预设相同的学科、池里没有待学内容，都应直接保存，不再弹确认。
 */
export function needsImpactConfirm(impact: OrganizationImpact): boolean {
  return impact.affectedItems > 0 || impact.modelCalls;
}

/** 左侧树：全部、未归类，以及每个学科下的课程；有未保存草稿的节点带标记 */
export function OrganizationTree(props: { data: OrganizationSnapshot; selection: Selection; presets: ReturnType<typeof presetCatalog>; onSelect: (next: Selection) => void; draftIds: Set<string> }) {
  const { data, selection, presets, onSelect, draftIds } = props;
  const itemClass = (active: boolean, key?: string) => `org-tree-item ${active ? 'current' : ''} ${key && draftIds.has(key) ? 'has-draft' : ''}`;
  return (
    <nav className="org-tree" aria-label="学科与课程结构">
      <div className="org-tree-head">
        <h2 id="organization-detail-title">组织</h2>
        <span className="muted small num">{data.totals.topics} 个主题</span>
      </div>
      <button type="button" className={itemClass(selection.kind === 'all')} aria-current={selection.kind === 'all' ? 'true' : undefined} onClick={() => onSelect({ kind: 'all' })}>
        <Icon name="library" />
        <span className="org-tree-name">全部</span>
        <span className="muted small num">{data.totals.topics}</span>
      </button>
      <button type="button" className={itemClass(selection.kind === 'unclassified')} aria-current={selection.kind === 'unclassified' ? 'true' : undefined} onClick={() => onSelect({ kind: 'unclassified' })}>
        <Icon name="topic" />
        <span className="org-tree-name">未归类</span>
        <span className="muted small num">{data.unclassified.length}</span>
      </button>
      <div className="org-tree-group-label">学科</div>
      {data.disciplines.map((node) => (
        <div key={node.discipline.id} className="org-tree-discipline">
          <button type="button" className={itemClass(selection.kind === 'discipline' && selection.id === node.discipline.id, `discipline:${node.discipline.id}`)} aria-current={selection.kind === 'discipline' && selection.id === node.discipline.id ? 'true' : undefined} onClick={() => onSelect({ kind: 'discipline', id: node.discipline.id })}>
            <Icon name="books" />
            <span className="org-tree-name">{node.discipline.name}</span>
            <span className="pill" title="教学预设">{presetLabel(presets, node.discipline.presetId)}</span>
            <span className="muted small num">{node.counts.topics}</span>
          </button>
          {node.courses.map((courseNode) => (
            <button
              key={courseNode.course.id}
              type="button"
              className={`${itemClass(selection.kind === 'course' && selection.id === courseNode.course.id, `course:${courseNode.course.id}`)} org-tree-course`}
              aria-current={selection.kind === 'course' && selection.id === courseNode.course.id ? 'true' : undefined}
              onClick={() => onSelect({ kind: 'course', id: courseNode.course.id })}
            >
              <Icon name="book" />
              <span className="org-tree-name">{courseNode.course.name}</span>
              <span className="muted small num">{courseNode.counts.topics}</span>
            </button>
          ))}
          {node.courses.length === 0 && <p className="org-tree-empty muted small">还没有课程</p>}
        </div>
      ))}
      {data.disciplines.length === 0 && <p className="org-tree-empty muted small">还没有学科。先在右侧新建一个。</p>}
    </nav>
  );
}

/** 全部：总数、各学科概览与新建入口 */
export function AllOverview({ data, presets }: { data: OrganizationSnapshot; presets: ReturnType<typeof presetCatalog> }) {
  return (
    <>
      <header className="org-detail-head">
        <div><h2>全部</h2><p className="muted small">共 {data.totals.topics} 个学习主题、{data.disciplines.length} 个学科、{data.allCoursesCount} 门课程。</p></div>
      </header>
      <Counts counts={{ topics: data.totals.topics, learned: data.totals.learned, due: data.totals.due, edge: data.totals.edge, excluded: data.totals.excluded }} />
      <NewDisciplineForm presets={presets} />
      <NewCourseForm data={data} presets={presets} />
      {data.disciplines.length > 0 && (
        <div className="org-overview-list">
          {data.disciplines.map((node) => (
            <div key={node.discipline.id} className="row-card">
              <span className="row-main">
                <span className="row-title">{node.discipline.name}</span>
                <span className="row-sub">{presetLabel(presets, node.discipline.presetId)} · {node.courses.length} 门课程 · {node.counts.topics} 个主题</span>
              </span>
              <a className="card-link small" href={routeHash({ name: 'organization', disciplineId: node.discipline.id })}>查看</a>
            </div>
          ))}
        </div>
      )}
      {data.unclassified.length > 0 && <p className="muted small">还有 {data.unclassified.length} 个主题未归类，可以在「未归类」里归入课程。</p>}
      {data.orphanTopics.length > 0 && <p className="notice">有 {data.orphanTopics.length} 个主题指向已不存在的学科或课程，请在「未归类」中重新归类。</p>}
    </>
  );
}

export function Counts({ counts }: { counts: { topics: number; learned?: number; due?: number; edge?: number; excluded?: number } }) {
  return (
    <div className="org-counts">
      <div className="tile"><span className="tile-label">学习主题</span><span className="tile-value">{counts.topics}</span></div>
      <div className="tile"><span className="tile-label">已学会</span><span className="tile-value">{counts.learned ?? '—'}</span></div>
      <div className="tile"><span className="tile-label">今天到期</span><span className="tile-value">{counts.due ?? '—'}</span></div>
      <div className="tile"><span className="tile-label">下一步可学</span><span className="tile-value">{counts.edge ?? '—'}</span></div>
      {counts.excluded !== undefined && counts.excluded > 0 && <div className="tile"><span className="tile-label">不学</span><span className="tile-value">{counts.excluded}</span></div>}
    </div>
  );
}

/** 新建学科：名称 + 九套预设任选，显式创建 */
function NewDisciplineForm({ presets }: { presets: ReturnType<typeof presetCatalog> }) {
  const organization = useOrganization();
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState<PresetId>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stamp, setStamp] = useState('');
  const selected = presets.find((preset) => preset.id === presetId);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    setStamp('');
    try {
      const created = await api.createDiscipline({ name: name.trim(), presetId });
      setName('');
      await organization.reload();
      setStamp(`已创建「${created.name}」`);
      navigate({ name: 'organization', disciplineId: created.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="org-create" aria-labelledby="new-discipline-title" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h3 id="new-discipline-title">新建学科</h3>
      <div className="settings-field-grid">
        <div className="field">
          <label htmlFor="new-discipline-name">学科名称</label>
          <input id="new-discipline-name" className="input" value={name} maxLength={40} disabled={busy} placeholder="例如：理工科" onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-discipline-preset">教学预设</label>
          <select id="new-discipline-preset" className="select" value={presetId} disabled={busy} onChange={(event) => setPresetId(event.target.value)}>
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          {selected && <span className="hint">{selected.description}</span>}
        </div>
      </div>
      <div className="actions-row">
        <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{busy ? '正在创建…' : '新建学科'}</button>
        {stamp && <span className="muted small" role="status">{stamp}</span>}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}

/**
 * 学科面板内的新建课程：学科已固定为当前学科，创建后直接选中新课程。
 * 选中学科时这是最常用的下一步，不用绕回"全部"再选一次学科。
 */
export function NewCourseInline({ disciplineId, disciplineName, onCreated }: { disciplineId: string; disciplineName: string; onCreated: (courseId: string) => void }) {
  const organization = useOrganization();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createCourse({ name: trimmed, disciplineId });
      setName('');
      await organization.reload();
      onCreated(created.id);
    } catch (e) {
      // 保存失败保留已输入的名称
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="org-inline-create" onSubmit={(event) => { event.preventDefault(); void create(); }} aria-label={`在${disciplineName}下新建课程`}>
      <div className="actions-row" style={{ marginTop: 0 }}>
        <label className="field" style={{ flex: '1 1 220px' }}>
          <span className="label">课程名称</span>
          <input
            className="input"
            value={name}
            maxLength={40}
            disabled={busy}
            placeholder="例如：液压传动"
            aria-label="新课程名称"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="submit" className="btn small primary" disabled={!name.trim() || busy}>{busy ? '正在创建…' : '创建课程'}</button>
      </div>
      <p className="muted small">会创建在「{disciplineName}」下，并自动选中它。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}

/** 新建课程：必须选择一个已有学科 */
function NewCourseForm({ data, presets }: { data: OrganizationSnapshot; presets: ReturnType<typeof presetCatalog> }) {
  const organization = useOrganization();
  const [name, setName] = useState('');
  const [disciplineId, setDisciplineId] = useState(data.disciplines[0]?.discipline.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!disciplineId && data.disciplines[0]) setDisciplineId(data.disciplines[0].discipline.id);
  }, [data.disciplines, disciplineId]);

  async function create() {
    if (!name.trim() || !disciplineId || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createCourse({ name: name.trim(), disciplineId });
      setName('');
      await organization.reload();
      navigate({ name: 'organization', courseId: created.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (data.disciplines.length === 0) {
    return <p className="muted small">先新建一个学科，再在它下面添加专业课程。</p>;
  }
  return (
    <form className="org-create" aria-labelledby="new-course-title" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h3 id="new-course-title">新建课程</h3>
      <div className="settings-field-grid">
        <div className="field">
          <label htmlFor="new-course-name">课程名称</label>
          <input id="new-course-name" className="input" value={name} maxLength={40} disabled={busy} placeholder="例如：液压传动" onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-course-discipline">所属学科</label>
          <select id="new-course-discipline" className="select" value={disciplineId} disabled={busy} onChange={(event) => setDisciplineId(event.target.value)}>
            {data.disciplines.map((node) => <option key={node.discipline.id} value={node.discipline.id}>{node.discipline.name}（{presetLabel(presets, node.discipline.presetId)}）</option>)}
          </select>
        </div>
      </div>
      <div className="actions-row">
        <button type="submit" className="btn" disabled={!name.trim() || !disciplineId || busy}>{busy ? '正在创建…' : '新建课程'}</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}

/** 学科详情：名称、预设、计数、课程列表；编辑时显式保存或取消 */
export function DisciplineDetail(props: {
  data: OrganizationSnapshot;
  discipline: Discipline;
  draft: Extract<Draft, { kind: 'discipline' }> | null;
  presets: ReturnType<typeof presetCatalog>;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (draft: Extract<Draft, { kind: 'discipline' }>) => void;
  onSave: () => void;
  onSelectCourse: (id: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const { data, discipline, draft, presets, saving, onEdit, onCancel, onChange, onSave, onSelectCourse, onDeleted } = props;
  const node = data.disciplines.find((item) => item.discipline.id === discipline.id);
  const counts = node?.counts ?? { topics: 0 };
  const courses = node?.courses ?? [];
  const dirty = draft !== null;
  const selected = presets.find((preset) => preset.id === (draft?.presetId ?? discipline.presetId));
  const blocked = counts.topics > 0;
  const [deleteError, setDeleteError] = useState('');
  const [addingCourse, setAddingCourse] = useState(courses.length === 0);

  async function remove() {
    setDeleteError('');
    try {
      await api.deleteDiscipline(discipline.id);
      await onDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  return (
    <>
      <header className="org-detail-head">
        <div>
          <h2>{discipline.name}</h2>
          <p className="muted small">学科 · 教学预设：{presetLabel(presets, discipline.presetId)}</p>
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}>
          {!dirty && <button type="button" className="btn small" onClick={onEdit}>编辑</button>}
          {dirty && <>
            <button type="button" className="btn small primary" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存'}</button>
            <button type="button" className="btn small ghost" disabled={saving} onClick={onCancel}>取消</button>
          </>}
        </div>
      </header>
      <Counts counts={counts} />
      {dirty && draft ? (
        <div className="settings-field-grid org-edit">
          <div className="field">
            <label htmlFor="discipline-name">学科名称</label>
            <input id="discipline-name" className="input" value={draft.name} maxLength={40} disabled={saving} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
            <span className="hint">同层不能重名，改名不会影响已挂的课程和主题。</span>
          </div>
          <div className="field">
            <label htmlFor="discipline-preset">教学预设</label>
            <select id="discipline-preset" className="select" value={draft.presetId} disabled={saving} onChange={(event) => onChange({ ...draft, presetId: event.target.value })}>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
            {selected && <span className="hint">{selected.description}</span>}
            <span className="hint">课程只继承所属学科的预设。改动后，尚未开始的内容会重新准备。</span>
          </div>
          <p className="muted small settings-field-wide">{dirty ? '有未保存的修改' : ''}</p>
        </div>
      ) : (
        <p className="muted small">这一学科下的课程共用一个教学预设；需要不同讲法时，把课程移到别的学科。</p>
      )}

      <section className="org-subsection" aria-labelledby="discipline-courses-title">
        <header className="org-subsection-head">
          <h3 id="discipline-courses-title">课程 <span className="muted small num">{courses.length}</span></h3>
          <button type="button" className="card-link small" onClick={() => setAddingCourse((value) => !value)} aria-expanded={addingCourse}>
            {addingCourse ? '收起' : '新建课程'}
          </button>
        </header>
        {addingCourse && (
          <NewCourseInline disciplineId={discipline.id} disciplineName={discipline.name} onCreated={(courseId) => { setAddingCourse(false); onSelectCourse(courseId); }} />
        )}
        {courses.length === 0 ? <p className="muted small">这个学科下还没有课程，用上面的「新建课程」添加第一门。</p> : (
          <div className="rows">
            {courses.map((courseNode) => (
              <button key={courseNode.course.id} type="button" className="row-card" onClick={() => onSelectCourse(courseNode.course.id)}>
                <span className="row-main">
                  <span className="row-title">{courseNode.course.name}</span>
                  <span className="row-sub">{courseNode.counts.topics} 个主题{courseNode.counts.due ? ` · 今天到期 ${courseNode.counts.due}` : ''}</span>
                </span>
                <span className="row-end"><Icon name="chevron" /></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="org-subsection" aria-labelledby="discipline-danger-title">
        <h3 id="discipline-danger-title">删除</h3>
        <p className="muted small">
          {blocked
            ? `这个学科下还有 ${counts.topics} 个学习主题，不能直接删除。请先把课程移动到别的学科，或把主题归到别的课程。删除不会级联删除主题和作答记录。`
            : '空学科可以直接删除；学习主题和作答记录不会随之删除。'}
        </p>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn small danger" disabled={blocked} onClick={() => void remove()}>删除学科</button>
        </div>
        {deleteError && <p className="error-text" role="alert">{deleteError}</p>}
      </section>
    </>
  );
}

/** 课程详情：名称、所属学科、计数、主题列表与归类；编辑显式保存 */
export function CourseDetail(props: {
  data: OrganizationSnapshot;
  course: Course;
  draft: Extract<Draft, { kind: 'course' }> | null;
  presets: ReturnType<typeof presetCatalog>;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (draft: Extract<Draft, { kind: 'course' }>) => void;
  onSave: () => void;
  onDone: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (message: string) => void;
  onStamp: (message: string) => void;
}) {
  const { data, course, draft, presets, saving, onEdit, onCancel, onChange, onSave, onDone, onDeleted, onError, onStamp } = props;
  const node = data.disciplines.flatMap((discipline) => discipline.courses).find((courseNode) => courseNode.course.id === course.id);
  const discipline = data.disciplineById.get(course.disciplineId);
  const counts = node?.counts ?? { topics: 0 };
  const topics = node?.topics ?? [];
  const dirty = draft !== null;
  const blocked = counts.topics > 0;
  const [deleteError, setDeleteError] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [assignError, setAssignError] = useState('');
  const [pendingAssign, setPendingAssign] = useState<{ ids: string[]; impact: OrganizationImpact } | null>(null);

  async function remove() {
    setDeleteError('');
    try {
      await api.deleteCourse(course.id);
      await onDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  const candidates = data.allTopics;
  const picked = selectedIds ?? topics.map((topic) => topic.id);
  const changed = picked.slice().sort().join('|') !== topics.map((topic) => topic.id).sort().join('|');

  async function beginSaveTopics() {
    setAssignError('');
    const added = picked.filter((id) => !topics.some((topic) => topic.id === id));
    const removed = topics.map((topic) => topic.id).filter((id) => !picked.includes(id));
    if (added.length === 0 && removed.length === 0) return;
    // 移出课程会让这些主题从课程预设退回默认教学配置，同样会重新备课，
    // 所以新增和移出都要先读影响；两类影响合并后统一确认。
    setAssigning(true);
    const requests: Promise<OrganizationImpact>[] = [];
    if (added.length > 0) requests.push(api.organizationImpact({ kind: 'topics', topicIds: added, courseId: course.id }));
    if (removed.length > 0) requests.push(api.organizationImpact({ kind: 'topics', topicIds: removed, courseId: null }));
    let impact: OrganizationImpact;
    try {
      // 任一请求失败就整体放弃，绝不只保存一半
      impact = combineImpacts(await Promise.all(requests));
    } catch (e) {
      setAssignError(`没能读取这次归类的影响，尚未保存。请重试：${(e as Error).message}`);
      setAssigning(false);
      return;
    }
    setAssigning(false);
    if (needsImpactConfirm(impact)) {
      setPendingAssign({ ids: picked, impact });
      return;
    }
    await applyTopics(picked);
  }

  async function applyTopics(ids: string[]) {
    setAssigning(true);
    setAssignError('');
    try {
      // PUT 只负责"归入"，取消勾选的主题要显式改为未归类
      const added = ids.filter((id) => !topics.some((topic) => topic.id === id));
      const removed = topics.map((topic) => topic.id).filter((id) => !ids.includes(id));
      if (added.length > 0) await api.assignCourseTopics(course.id, added, { confirmed: true });
      for (const id of removed) await api.assignTopic(id, null, { confirmed: true });
      setSelectedIds(null);
      setPendingAssign(null);
      await onDone();
      onStamp(`已更新课程主题 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      onError((e as Error).message);
      setAssignError((e as Error).message);
    } finally {
      setAssigning(false);
    }
  }

  function toggle(id: string, on: boolean) {
    setSelectedIds(on ? [...picked, id] : picked.filter((item) => item !== id));
  }

  return (
    <>
      <header className="org-detail-head">
        <div>
          <h2>{course.name}</h2>
          <p className="muted small">
            {discipline ? `${discipline.name} · 教学预设：${presetLabel(presets, discipline.presetId)}` : '所属学科已不存在'}
          </p>
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}>
          {!dirty && <button type="button" className="btn small" onClick={onEdit}>编辑</button>}
          {dirty && <>
            <button type="button" className="btn small primary" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存'}</button>
            <button type="button" className="btn small ghost" disabled={saving} onClick={onCancel}>取消</button>
          </>}
        </div>
      </header>
      <Counts counts={counts} />
      {dirty && draft ? (
        <div className="settings-field-grid org-edit">
          <div className="field">
            <label htmlFor="course-name">课程名称</label>
            <input id="course-name" className="input" value={draft.name} maxLength={40} disabled={saving} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
            <span className="hint">同一学科下不能重名。</span>
          </div>
          <div className="field">
            <label htmlFor="course-discipline">所属学科</label>
            <select id="course-discipline" className="select" value={draft.disciplineId} disabled={saving} onChange={(event) => onChange({ ...draft, disciplineId: event.target.value })}>
              {data.disciplines.map((item) => <option key={item.discipline.id} value={item.discipline.id}>{item.discipline.name}（{presetLabel(presets, item.discipline.presetId)}）</option>)}
            </select>
            <span className="hint">把课程移到别的学科会改变它继承的教学预设，移过去后只有这门课尚未开始的内容会重新准备。</span>
          </div>
          <p className="muted small settings-field-wide">有未保存的修改</p>
        </div>
      ) : (
        <p className="muted small">课程只继承所属学科的预设，不单独设置内容风格。</p>
      )}

      <section className="org-subsection" aria-labelledby="course-topics-title">
        <header className="org-subsection-head">
          <h3 id="course-topics-title">学习主题 <span className="muted small num">{topics.length}</span></h3>
          <button type="button" className="card-link small" onClick={() => { setSelectedIds(null); setAssignError(''); }}>重新选择</button>
        </header>
        {topics.length === 0 && <p className="muted small">这门课程还没有学习主题。用下面的「归入这门课程」把它们选进来。</p>}
        <div className="rows">
          {topics.map((topic) => (
            <a key={topic.id} className="row-card" href={routeHash({ name: 'topic', topicId: topic.id })}>
              <span className="row-main"><span className="row-title">{topic.title}</span><span className="row-sub">{topicState(topic)}</span></span>
              <span className="row-end"><Icon name="chevron" /></span>
            </a>
          ))}
        </div>
      </section>

      <section className="org-subsection" aria-labelledby="course-assign-title">
        <header className="org-subsection-head">
          <h3 id="course-assign-title">归入这门课程</h3>
          <span className="muted small">可勾选未归类和其他课程的主题</span>
        </header>
        {candidates.length === 0 ? <p className="muted small">还没有任何学习主题。</p> : (
          <div className="org-topic-checks">
            {candidates.map((topic) => (
              <label key={topic.id} className="check">
                <input type="checkbox" checked={picked.includes(topic.id)} disabled={assigning || saving} onChange={(event) => toggle(topic.id, event.target.checked)} />
                <span>
                  <span className="org-topic-title">{topic.title}</span>
                  <span className="muted small"> · {topic.courseId ? coursePath(data, topic.courseId) : '未归类'}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="actions-row">
          <button type="button" className="btn small primary" disabled={!changed || assigning || saving} onClick={() => void beginSaveTopics()}>
            {assigning ? '保存中…' : '保存归类'}
          </button>
          <span className="muted small">{changed ? '有未保存的归类修改' : '学习主题不会因为归类而删除'}</span>
        </div>
        {pendingAssign && (
          <ImpactConfirm
            impact={pendingAssign.impact}
            saving={assigning}
            onConfirm={() => void applyTopics(pendingAssign.ids)}
            onCancel={() => setPendingAssign(null)}
          />
        )}
        {assignError && <p className="error-text" role="alert">{assignError}</p>}
      </section>

      <section className="org-subsection" aria-labelledby="course-danger-title">
        <h3 id="course-danger-title">删除</h3>
        <p className="muted small">
          {blocked
            ? `这门课程下还有 ${counts.topics} 个学习主题，不能直接删除。请先把主题归到别的课程或设为未归类。删除不会级联删除主题和作答记录。`
            : '空课程可以直接删除。'}
        </p>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn small danger" disabled={blocked} onClick={() => void remove()}>删除课程</button>
        </div>
        {deleteError && <p className="error-text" role="alert">{deleteError}</p>}
      </section>
    </>
  );
}

function topicState(topic: OrganizationTopic): string {
  if (topic.graphStatus === 'pending') return '知识图谱生成中';
  if (topic.graphStatus === 'failed') return '图谱生成失败';
  if (topic.status === 'paused') return '已暂停新学';
  if (topic.placementStatus === 'pending') return '待摸底';
  if (topic.placementStatus === 'testing') return '继续摸底';
  return '已就绪';
}

/** 未归类：把主题批量归入某门课程 */
export function UnclassifiedPane({ data }: { data: OrganizationSnapshot }) {
  const organization = useOrganization();
  const allCourses = data.disciplines.flatMap((node) => node.courses.map((courseNode) => ({ course: courseNode.course, disciplineName: node.discipline.name })));
  const [courseId, setCourseId] = useState(allCourses[0]?.course.id ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stamp, setStamp] = useState('');

  useEffect(() => {
    setPicked((current) => current.filter((id) => data.unclassified.some((topic) => topic.id === id)));
  }, [data.unclassified]);

  async function assign() {
    if (!courseId || picked.length === 0 || busy) return;
    setBusy(true);
    setError('');
    setStamp('');
    try {
      await api.assignCourseTopics(courseId, picked);
      const target = allCourses.find((item) => item.course.id === courseId);
      setPicked([]);
      setStamp(`已归入「${target ? `${target.disciplineName} / ${target.course.name}` : '课程'}」`);
      await organization.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (allCourses.length === 0) {
    return (
      <>
        <header className="org-detail-head"><div><h2>未归类</h2><p className="muted small">这些主题还没有归入任何课程。</p></div></header>
        <p className="muted">先新建一个学科和课程，再回来归类。未归类的主题仍然可以正常学习。</p>
        <TopicLinks topics={data.unclassified} />
      </>
    );
  }

  return (
    <>
      <header className="org-detail-head">
        <div><h2>未归类</h2><p className="muted small">{data.unclassified.length} 个主题还没有归入课程。</p></div>
      </header>
      {data.unclassified.length === 0 ? <p className="muted">所有学习主题都已归类。</p> : (
        <>
          <div className="org-topic-checks">
            {data.unclassified.map((topic) => (
              <label key={topic.id} className="check">
                <input type="checkbox" checked={picked.includes(topic.id)} disabled={busy} onChange={(event) => setPicked(event.target.checked ? [...picked, topic.id] : picked.filter((id) => id !== topic.id))} />
                <span><span className="org-topic-title">{topic.title}</span><span className="muted small"> · {topicState(topic)}</span></span>
              </label>
            ))}
          </div>
          <div className="actions-row">
            <select className="select" value={courseId} disabled={busy} aria-label="目标课程" onChange={(event) => setCourseId(event.target.value)}>
              {allCourses.map((item) => <option key={item.course.id} value={item.course.id}>{item.disciplineName} / {item.course.name}</option>)}
            </select>
            <button type="button" className="btn small primary" disabled={picked.length === 0 || busy} onClick={() => void assign()}>{busy ? '正在归类…' : `归入所选课程（${picked.length}）`}</button>
          </div>
          {stamp && <p className="notice ok" role="status">{stamp}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      )}
      {data.orphanTopics.length > 0 && (
        <section className="org-subsection">
          <h3>待整理</h3>
          <p className="muted small">这些主题指向的课程已不存在，可以先归入上面的课程。</p>
          <TopicLinks topics={data.orphanTopics} />
        </section>
      )}
    </>
  );
}

function TopicLinks({ topics }: { topics: OrganizationTopic[] }) {
  return (
    <div className="rows">
      {topics.map((topic) => (
        <a key={topic.id} className="row-card" href={routeHash({ name: 'topic', topicId: topic.id })}>
          <span className="row-main"><span className="row-title">{topic.title}</span><span className="row-sub">{topicState(topic)}</span></span>
          <span className="row-end"><Icon name="chevron" /></span>
        </a>
      ))}
    </div>
  );
}

/** 保存前的影响确认：显出受影响的课程、主题和待重备内容数量 */
export function ImpactConfirm({ impact, saving, onConfirm, onCancel }: { impact: OrganizationImpact; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="impact-confirm" role="alertdialog" aria-labelledby="impact-title">
      <h3 id="impact-title">这次保存会重新准备内容</h3>
      <p>
        受影响：{impact.affectedCourses} 门课程、{impact.affectedTopics} 个学习主题、{impact.affectedItems} 项尚未开始的内容。
        {impact.modelCalls ? '准备工作可能会调用模型，产生费用。' : ''}
      </p>
      <p className="muted small">正在学习的课堂和历史记录保持原样；已准备好的内容不会因为这次保存而丢失学习记录。</p>
      <div className="actions-row" style={{ marginTop: 0 }}>
        <button type="button" className="btn small primary" disabled={saving} onClick={onConfirm}>{saving ? '保存中…' : '确认并保存'}</button>
        <button type="button" className="btn small ghost" disabled={saving} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function MigrationReport({ report }: { report: Record<string, unknown> }) {
  const summary = migrationSummary(report);
  return (
    <details className="org-migration">
      <summary>迁移报告{summary ? `：${summary}` : ''}</summary>
      <p className="muted small">旧版的学科分组和标签覆盖已迁移为学科与课程。原始配置快照保留在这里，便于核对；不会继续参与日常判断。</p>
      <pre className="guidance-preview-text">{JSON.stringify(report, null, 2)}</pre>
    </details>
  );
}

function migrationSummary(report: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(report)) {
    if (Array.isArray(value)) parts.push(`${MIGRATION_LABEL[key] ?? key} ${value.length}`);
    else if (typeof value === 'number') parts.push(`${MIGRATION_LABEL[key] ?? key} ${value}`);
  }
  return parts.join(' · ');
}

const MIGRATION_LABEL: Record<string, string> = {
  disciplinesCreated: '新建学科',
  coursesCreated: '新建课程',
  topicsAssigned: '归入主题',
  compatDisciplines: '兼容学科',
  issues: '需整理',
  notes: '说明',
  conflicts: '冲突',
  legacySnapshots: '旧配置快照',
};
