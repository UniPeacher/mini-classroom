import { useEffect, useState } from 'react';
import { type SettingsView, type UserSettings, api } from '../api';
import { Section } from '../components/SettingsSection';

interface ContentGuidanceSettingsProps {
  settings: UserSettings;
  defaults: SettingsView['guidanceDefaults'];
  maxLength: number;
  onSaved: (settings: UserSettings) => void;
}

/** 教程和配图共用一个保存入口，长文本编辑完成后再生效。 */
export function ContentGuidanceSettings({ settings, defaults, maxLength, onSaved }: ContentGuidanceSettingsProps) {
  const tutorialValue = settings.tutorialGuidance ?? defaults.tutorialGuidance;
  const figureValue = settings.figureGuidance ?? defaults.figureGuidance;
  const [tutorialDraft, setTutorialDraft] = useState(tutorialValue);
  const [figureDraft, setFigureDraft] = useState(figureValue);
  const [saving, setSaving] = useState(false);
  const [stamp, setStamp] = useState('');
  const [error, setError] = useState('');

  // 只同步对应引导词的已保存值，其他设置变化时保留正在编辑的草稿。
  useEffect(() => setTutorialDraft(tutorialValue), [tutorialValue]);
  useEffect(() => setFigureDraft(figureValue), [figureValue]);

  const tutorialDirty = tutorialDraft !== tutorialValue;
  const figureDirty = figureDraft !== figureValue;
  const dirty = tutorialDirty || figureDirty;

  function editTutorial(value: string) {
    setTutorialDraft(value);
    setStamp('');
    setError('');
  }

  function editFigure(value: string) {
    setFigureDraft(value);
    setStamp('');
    setError('');
  }

  async function save() {
    const patch: Partial<UserSettings> = {};
    if (tutorialDirty) patch.tutorialGuidance = customGuidance(tutorialDraft, defaults.tutorialGuidance);
    if (figureDirty) patch.figureGuidance = customGuidance(figureDraft, defaults.figureGuidance);
    setSaving(true);
    setStamp('');
    setError('');
    try {
      const saved = await api.saveSettings(patch);
      setTutorialDraft(saved.tutorialGuidance ?? defaults.tutorialGuidance);
      setFigureDraft(saved.figureGuidance ?? defaults.figureGuidance);
      onSaved(saved);
      setStamp(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      setError(`保存失败，编辑内容已保留。${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="内容生成偏好"
      description="用两份引导词告诉微课堂怎样讲、怎样画。可以直接修改下面的完整说明，保存后用于新生成的讲解、复习材料及其中的配图。"
    >
      <GuidanceEditor
        id="tutorial-guidance"
        title="教程引导词"
        description="调整讲解顺序、详略、案例、语言和排版，让内容更适合你的理解方式。"
        value={tutorialDraft}
        defaultValue={defaults.tutorialGuidance}
        dirty={tutorialDirty}
        custom={settings.tutorialGuidance !== null}
        disabled={saving}
        maxLength={maxLength}
        onChange={editTutorial}
      />
      <GuidanceEditor
        id="figure-guidance"
        title="配图引导词"
        description="调整配图的用途、表达形式、信息组合和视觉风格，帮助建立印象、理解概念和看清过程。"
        value={figureDraft}
        defaultValue={defaults.figureGuidance}
        dirty={figureDirty}
        custom={settings.figureGuidance !== null}
        disabled={saving}
        maxLength={maxLength}
        onChange={editFigure}
      />
      <div className="guidance-save">
        <div className="actions-row">
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving ? '保存中…' : '保存引导词'}
          </button>
          <span className="muted small" role="status">
            {saving ? '正在保存' : dirty ? '有未保存的修改' : stamp || '已与当前设置一致'}
          </span>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="muted small">保存后会重新准备尚未开始的课程，可能需要等待并产生模型调用费用；正在学习的课程和历史记录保持原样。</p>
      </div>
    </Section>
  );
}

interface GuidanceEditorProps {
  id: string;
  title: string;
  description: string;
  value: string;
  defaultValue: string;
  dirty: boolean;
  custom: boolean;
  disabled: boolean;
  maxLength: number;
  onChange: (value: string) => void;
}

function GuidanceEditor({ id, title, description, value, defaultValue, dirty, custom, disabled, maxLength, onChange }: GuidanceEditorProps) {
  return (
    <div className="guidance-editor field">
      <div className="guidance-heading">
        <label className="label" htmlFor={id}>{title}</label>
        <span className="muted small">{dirty ? '未保存' : custom ? '自定义' : '使用默认'}</span>
      </div>
      <p className="hint" id={`${id}-hint`}>{description}</p>
      <textarea
        id={id}
        className="textarea guidance-textarea"
        rows={12}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        aria-describedby={`${id}-hint ${id}-count`}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="guidance-footer">
        <button
          type="button"
          className="btn small ghost"
          aria-label={`恢复默认${title}`}
          disabled={disabled || value === defaultValue}
          onClick={() => onChange(defaultValue)}
        >
          恢复默认
        </button>
        <span className="muted small num" id={`${id}-count`}>{value.length.toLocaleString('zh-CN')} / {maxLength.toLocaleString('zh-CN')} 字</span>
      </div>
      {dirty && value === defaultValue && <p className="hint">已恢复默认内容，点击“保存引导词”后生效。</p>}
      {value.trim() === '' && <p className="hint">留空保存将使用默认引导词。</p>}
    </div>
  );
}

function customGuidance(value: string, defaultValue: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === defaultValue.trim() ? null : trimmed;
}
