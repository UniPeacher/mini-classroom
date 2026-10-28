import { useState } from 'react';
import { type SubjectStyleOption, type UserSettings, api } from '../api';
import { Section } from '../components/SettingsSection';

interface SubjectGroupEditorProps {
  settings: UserSettings;
  options: SubjectStyleOption[];
  /** 全部已存在的学科标签（来自主题） */
  tags: { subject: string; topicCount: number }[];
  onSaved: (settings: UserSettings) => void;
}

/**
 * 学科分组：一个大类选一套内容风格，下面挂具体的专业课标签。
 * 例如「理工科」选理工科风格，其下挂「液压传动」「数字信号处理」；
 * 「语言」选语言学习风格，其下挂「西班牙语」。同一分组下的标签共用这套风格。
 */
export function SubjectStyleSettings({ settings, options, tags, onSaved }: SubjectGroupEditorProps) {
  const groups = settings.subjectGroups ?? [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const assigned = new Set(groups.flatMap((g) => g.subjects));
  const unassigned = tags.filter((t) => !assigned.has(t.subject));

  async function persist(next: typeof groups, message?: string) {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveSettings({ subjectGroups: next });
      onSaved(saved);
      if (message) setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function addGroup() {
    const name = newGroup.trim();
    if (!name || groups.some((g) => g.name === name)) {
      setNewGroup('');
      return;
    }
    void persist([...groups, { name, styleId: 'default' as const, subjects: [] }]);
    setNewGroup('');
    setEditing(name);
  }

  function renameGroup(from: string, to: string) {
    const name = to.trim();
    if (!name || (name !== from && groups.some((g) => g.name === name))) return;
    void persist(groups.map((g) => (g.name === from ? { ...g, name } : g)));
    setEditing(name);
  }

  function setStyle(name: string, styleId: SubjectStyleOption['id']) {
    void persist(groups.map((g) => (g.name === name ? { ...g, styleId } : g)));
  }

  function assign(tag: string, groupName: string | null) {
    // 一个标签只能属于一个分组：先从所有分组移除，再加入目标分组
    const cleaned = groups.map((g) => ({ ...g, subjects: g.subjects.filter((s) => s !== tag) }));
    const next = groupName === null ? cleaned : cleaned.map((g) => (g.name === groupName ? { ...g, subjects: [...g.subjects, tag] } : g));
    void persist(next);
  }

  function removeGroup(name: string) {
    void persist(groups.filter((g) => g.name !== name));
    setEditing(null);
  }

  return (
    <Section
      title="学科分组与内容风格"
      description="先建一个学科大类并选它的内容风格，再把具体的专业课标签挂进去。同一大类下的课程共用这套风格，通用写作原则（排版、篇幅）始终保留。"
    >
      {groups.length === 0 && (
        <p className="muted">还没有分组。先建一个，例如「理工科」选理工科风格，再把「液压传动」「数字信号处理」挂进去。</p>
      )}
      <div className="subject-group-list">
        {groups.map((group) => {
          const current = options.find((o) => o.id === group.styleId);
          const available = tags.filter((t) => !assigned.has(t.subject) || group.subjects.includes(t.subject));
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
                      if (e.key === 'Enter') { e.currentTarget.blur(); }
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <button type="button" className="card-link subject-group-name" onClick={() => setEditing(group.name)} title="点击改名">
                    {group.name}
                  </button>
                )}
                <span className="muted small num">{group.subjects.length} 个标签</span>
                <button type="button" className="btn small ghost" onClick={() => removeGroup(group.name)} disabled={saving}>
                  删除分组
                </button>
              </div>

              <div className="subject-group-styles">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`btn small ${group.styleId === option.id ? 'selected' : ''}`}
                    aria-pressed={group.styleId === option.id}
                    title={option.description}
                    disabled={saving}
                    onClick={() => setStyle(group.name, option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="hint">{current?.description}</p>

              <div className="subject-group-tags">
                <span className="muted small">挂了这些课：</span>
                {group.subjects.length === 0 && <span className="muted small">（还没有）</span>}
                {group.subjects.map((tag) => (
                  <span key={tag} className="pill accent">
                    {tag}
                    <button type="button" className="pill-remove" aria-label={`从分组移除 ${tag}`} disabled={saving} onClick={() => assign(tag, null)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>

              {available.length > 0 && (
                <label className="subject-group-add">
                  <span className="muted small">把课程挂进来：</span>
                  <select
                    className="select"
                    value=""
                    disabled={saving}
                    onChange={(e) => e.target.value && assign(e.target.value, group.name)}
                  >
                    <option value="">选择学科标签…</option>
                    {available.map((t) => (
                      <option key={t.subject} value={t.subject}>
                        {t.subject}（{t.topicCount} 个主题）
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </div>

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

      {unassigned.length > 0 && (
        <p className="muted small" style={{ marginTop: 12 }}>
          还没分组的标签：{unassigned.map((t) => t.subject).join('、')}。它们按通用风格生成内容。
        </p>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small">
        改分组或风格后，受影响学科尚未开始的课程内容会重新准备，其他学科不受影响。已学过的记录保持原样。
      </p>
    </Section>
  );
}
