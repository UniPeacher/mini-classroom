import { useState } from 'react';
import { type SettingsView, type SubjectStyleOption, type UserSettings, api } from '../api';
import { Section } from '../components/SettingsSection';

interface SubjectStyleSettingsProps {
  settings: UserSettings;
  options: SubjectStyleOption[];
  /** 已存在的学科标签 */
  subjects: { subject: string; styleId: string }[];
  maxLength: number;
  onSaved: (settings: UserSettings) => void;
}

/**
 * 按学科选内容风格：每个学科标签各选一个预设，生成讲解和配图时追加该学科的专门要求。
 * 预设只在该学科有主题时才有意义，所以只列出已打标签的学科。
 */
export function SubjectStyleSettings({ settings, options, subjects, onSaved }: SubjectStyleSettingsProps) {
  const styles = settings.subjectStyles ?? {};
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function choose(subject: string, styleId: SubjectStyleOption['id']) {
    setSaving(subject);
    setError('');
    try {
      // 选"通用"等于回到默认，不留多余配置
      const next = { ...styles };
      if (styleId === 'default') delete next[subject];
      else next[subject] = styleId;
      const saved = await api.saveSettings({ subjectStyles: next });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Section
      title="学科内容风格"
      description="给不同学科选一套专门的内容风格。选了之后，这个学科的讲解会比通用风格更贴合它自己的讲法和举例方式；通用写作原则（排版、篇幅）始终保留。"
    >
      {subjects.length === 0 ? (
        <p className="muted">
          还没有学科标签。先到某个学习主题里加上学科标签（例如「数字信号处理」「西班牙语」），就能在这里为它选内容风格。
        </p>
      ) : (
        <div className="subject-style-list">
          {subjects.map(({ subject }) => {
            const current = styles[subject] ?? 'default';
            return (
              <div key={subject} className="subject-style-row">
                <div className="subject-style-head">
                  <span className="pill accent">{subject}</span>
                  {saving === subject && <span className="muted small">保存中…</span>}
                </div>
                <div className="subject-style-options">
                  {options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`btn small ${current === option.id ? 'selected' : ''}`}
                      aria-pressed={current === option.id}
                      disabled={saving !== null}
                      title={option.description}
                      onClick={() => choose(subject, option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="hint">
                  {options.find((o) => o.id === current)?.description}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small">
        切换风格后，这个学科尚未开始的课程内容会按新风格重新准备，其他学科不受影响。已学过的记录保持原样。
      </p>
    </Section>
  );
}
