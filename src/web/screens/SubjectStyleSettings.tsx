import { useMemo, useState } from 'react';
import { type Subject, type SubjectStyleOption, type UserSettings, api } from '../api';
import { Section } from '../components/SettingsSection';

type Group = UserSettings['subjectGroups'][number];

interface SubjectStyleSettingsProps {
  settings: UserSettings;
  options: SubjectStyleOption[];
  /** 全部已存在的学科标签及其当前状态 */
  tags: Subject[];
  /** 用户最近点选的风格，用于下方预览它的完整引导词 */
  onPreviewStyle: (styleId: SubjectStyleOption['id']) => void;
  onSaved: (settings: UserSettings) => void;
}

/**
 * 学科标签与内容风格面板。
 * 以标签为主体：每个标签一行，直接看到它属于哪个分组、实际用的哪套风格、多少门课在用，
 * 并且可以单独改某个标签的风格（覆盖分组），不用绕到分组里操作。
 * 分组只管"给一组标签设同一个默认风格"。
 */
export function SubjectStyleSettings({ settings, options, tags, onPreviewStyle, onSaved }: SubjectStyleSettingsProps) {
  const groups = settings.subjectGroups ?? [];
  const tagStyles = settings.tagStyles ?? {};
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newStyle, setNewStyle] = useState<SubjectStyleOption['id']>('default');
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const styleLabel = (id: string) => options.find((o) => o.id === id)?.label ?? '通用';
  const styleDesc = (id: string) => options.find((o) => o.id === id)?.description ?? '';

  // 标签列表：已存在于主题里的标签 + 分组里配置过但主题中暂时没有的
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const list: { tag: string; topicCount: number; group: string | null; styleId: string; own: boolean }[] = [];
    for (const t of tags) {
      if (seen.has(t.subject)) continue;
      seen.add(t.subject);
      list.push({
        tag: t.subject,
        topicCount: t.topicCount,
        group: t.group,
        styleId: t.styleId,
        own: tagStyles[t.subject] !== undefined,
      });
    }
    for (const group of groups) {
      for (const tag of group.subjects) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        list.push({ tag, topicCount: 0, group: group.name, styleId: group.styleId, own: tagStyles[tag] !== undefined });
      }
    }
    const keyword = filter.trim();
    const filtered = keyword ? list.filter((r) => r.tag.includes(keyword)) : list;
    // 先按分组排（同组相邻），再按标签名
    return filtered.sort((a, b) => (a.group ?? '\uffff').localeCompare(b.group ?? '\uffff', 'zh-CN') || a.tag.localeCompare(b.tag, 'zh-CN'));
  }, [tags, groups, tagStyles, filter]);

  async function persist(patch: Partial<UserSettings>) {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveSettings(patch);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 单独给某个标签定风格；传 null 表示取消覆盖、重新跟随分组 */
  function setTagStyle(tag: string, styleId: SubjectStyleOption['id'] | null) {
    const next = { ...tagStyles };
    if (styleId === null) delete next[tag];
    else next[tag] = styleId;
    void persist({ tagStyles: next });
  }

  /** 把标签移入某个分组；null 表示移出分组 */
  function moveTag(tag: string, groupName: string | null) {
    const cleaned = groups.map((g) => ({ ...g, subjects: g.subjects.filter((s) => s !== tag) }));
    const next = groupName === null ? cleaned : cleaned.map((g) => (g.name === groupName ? { ...g, subjects: [...g.subjects, tag] } : g));
    void persist({ subjectGroups: next });
  }

  function addGroup() {
    const name = newGroup.trim();
    if (!name || groups.some((g) => g.name === name)) { setNewGroup(''); return; }
    void persist({ subjectGroups: [...groups, { name, styleId: newStyle, subjects: [] }] });
    setNewGroup('');
    setEditing(name);
  }

  function renameGroup(from: string, to: string) {
    const name = to.trim();
    if (!name || (name !== from && groups.some((g) => g.name === name))) return;
    void persist({ subjectGroups: groups.map((g) => (g.name === from ? { ...g, name } : g)) });
    setEditing(name);
  }

  function setGroupStyle(name: string, styleId: SubjectStyleOption['id']) {
    void persist({ subjectGroups: groups.map((g) => (g.name === name ? { ...g, styleId } : g)) });
  }

  function removeGroup(name: string) {
    void persist({ subjectGroups: groups.filter((g) => g.name !== name) });
    setEditing(null);
  }

  return (
    <Section
      title="学科标签与内容风格"
      description="每个学科标签可以单独选内容风格；把标签放进分组，组内没单独设置的标签就跟随分组的风格。通用写作原则（排版、篇幅）始终保留。"
    >
      {/* 标签总览：一行一个标签，直接看到分组、风格和课程数 */}
      <div className="tag-table-head">
        <h3>全部标签 <span className="muted small num">{rows.length}</span></h3>
        <input
          className="input"
          type="search"
          value={filter}
          placeholder="查找标签…"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="muted">还没有学科标签。先到某个学习主题里填上学科标签（例如「液压传动」），再回来设置风格。</p>
      ) : (
        <>
          <p className="muted small" style={{ marginBottom: 8 }}>
            「单独指定」优先于「分组」：两列都留空时用通用风格。只有一个标签时，直接在「单独指定」里选就行，不用建分组。
          </p>
          <table className="tag-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>分组（可选）</th>
                <th>实际用的风格</th>
                <th>单独指定（优先）</th>
              </tr>
            </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.tag}>
                <td>
                  <span className="tag-name">{row.tag}</span>
                  <span className="muted small num">{row.topicCount} 门课</span>
                </td>
                <td>
                  <select
                    className="select"
                    value={row.group ?? ''}
                    disabled={saving}
                    aria-label={`${row.tag} 的分组`}
                    onChange={(e) => moveTag(row.tag, e.target.value || null)}
                  >
                    <option value="">不归类</option>
                    {groups.map((g) => (
                      <option key={g.name} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                  {!row.group && <span className="muted small">可选：多个标签共用风格时才有用</span>}
                </td>
                <td>
                  <span className={`pill ${row.styleId === 'default' ? '' : 'accent'}`}>{styleLabel(row.styleId)}</span>
                  {row.own
                    ? <span className="muted small">来自「单独指定」列</span>
                    : row.group
                      ? <span className="muted small">跟随分组「{row.group}」</span>
                      : <span className="muted small">没有单独指定，用通用</span>}
                </td>
                <td>
                  <select
                    className="select"
                    value={tagStyles[row.tag] ?? ''}
                    disabled={saving}
                    aria-label={`${row.tag} 的风格`}
                    onChange={(e) => { const v = (e.target.value || null) as SubjectStyleOption["id"] | null; setTagStyle(row.tag, v); if (v) onPreviewStyle(v); }}
                  >
                    <option value="">不单独指定</option>
                    {options.filter((o) => o.id !== 'default').map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  {!tagStyles[row.tag] && <span className="muted small">这一列优先，留空则跟随分组</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}
      {rows.length > 0 && <p className="hint">{styleDesc(tagStyles[rows[0]!.tag] ?? rows[0]!.styleId)}</p>}

      {/* 分组：给一组标签设同一个默认风格 */}
      <h3 className="tag-section-title">分组 <span className="muted small num">{groups.length}</span></h3>
      <p className="muted small">分组的作用是给一组课设同一个默认风格，省得逐个设置。组内某个标签也可以在总览里单独改。</p>
      <div className="subject-group-list">
        {groups.map((group: Group) => {
          const members = rows.filter((r) => r.group === group.name);
          return (
            <div key={group.name} className="subject-group">
              <div className="subject-group-head">
                {editing === group.name ? (
                  <input
                    className="input"
                    defaultValue={group.name}
                    autoFocus
                    maxLength={40}
                    onBlur={(e) => renameGroup(group.name, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <button type="button" className="card-link subject-group-name" onClick={() => setEditing(group.name)} title="点击改名">
                    {group.name}
                  </button>
                )}
                <span className="muted small num">{members.length} 个标签</span>
                <button type="button" className="btn small ghost" onClick={() => removeGroup(group.name)} disabled={saving}>
                  删除分组
                </button>
              </div>
              <p className="muted small">{members.length > 0 ? members.map((m) => m.tag).join('、') : '还没有标签，在总览里把标签的分组选成它'}</p>
              <div className="subject-group-styles">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`btn small ${group.styleId === option.id ? 'selected' : ''}`}
                    aria-pressed={group.styleId === option.id}
                    title={option.description}
                    disabled={saving}
                    onClick={() => { setGroupStyle(group.name, option.id); onPreviewStyle(option.id); }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="hint">{styleDesc(group.styleId)}</p>
            </div>
          );
        })}
      </div>

      <div className="new-group">
        <div className="actions-row" style={{ marginTop: 16 }}>
          <input
            className="input"
            type="text"
            maxLength={40}
            value={newGroup}
            placeholder="新分组名，例如：理工科"
            disabled={saving}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
          />
          <button type="button" className="btn small" onClick={addGroup} disabled={saving || !newGroup.trim()}>
            新建分组
          </button>
        </div>
        <div className="subject-group-styles" style={{ marginTop: 8 }}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`btn small ${newStyle === option.id ? 'selected' : ''}`}
              aria-pressed={newStyle === option.id}
              title={option.description}
              disabled={saving}
              onClick={() => { setNewStyle(option.id); onPreviewStyle(option.id); }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="hint">{styleDesc(newStyle)}</p>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small">
        改分组或风格后，受影响学科尚未开始的课程内容会重新准备，其他学科不受影响。已学过的记录保持原样。
      </p>
    </Section>
  );
}
