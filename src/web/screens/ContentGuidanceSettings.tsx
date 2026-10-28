import { useEffect, useMemo, useState } from 'react';
import { type CourseGuidance, type SettingsView, type TeachingPreset, type UserSettings, api } from '../api';
import { Section } from '../components/SettingsSection';
import { useResource } from '../hooks';
import { coursePath, useOrganization } from '../organization';

interface ContentGuidanceSettingsProps {
  settings: UserSettings;
  defaults: SettingsView['guidanceDefaults'];
  maxLength: number;
  /** 保存全局共用表达规则；学科追加要求由后端预设提供，不在这里合并 */
  onSaved: (settings: UserSettings) => void;
  /** 有未保存修改时通知外层，用于离开页面提醒 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 九套教学预设目录，仅浏览；来自设置接口 */
  presets?: TeachingPreset[];
}

/**
 * 共用表达规则：教程和配图两份全局引导词，显式保存后生效。
 * 这里编辑的始终是全局文本；学科追加的要求由服务端按课程解析，不在这里拼接，也不声称是完整系统提示词。
 */
export function ContentGuidanceSettings({ settings, defaults, maxLength, onSaved, onDirtyChange, presets }: ContentGuidanceSettingsProps) {
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

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

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
      // 保存失败保留编辑内容
      setError(`保存失败，编辑内容已保留。${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="共用表达规则"
      description="所有学科共用的教程和配图写作原则。学科教学要求在生成时由教学内容配置追加在后面，不在这里修改。"
    >
      <CourseGuidancePreview presets={presets ?? []} />
      <PresetCatalog presets={presets ?? []} />
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

/**
 * 九套教学预设目录：只读浏览，不写任何配置。
 * 大类选预设是"学科与课程"页里的动作，这里只看说明与要求原文。
 */
export function PresetCatalog({ presets }: { presets: TeachingPreset[] }) {
  if (presets.length === 0) return null;
  return (
    <div className="preset-catalog" aria-label="教学预设目录">
      <h3>教学预设目录 <span className="muted small num">{presets.length}</span></h3>
      <p className="muted small">只用于浏览。给学科选预设请到「学科与课程」，浏览不会更改保存的配置。</p>
      <div className="preset-list">
        {presets.map((preset) => (
          <details key={preset.id} className="preset-item">
            <summary>
              <strong>{preset.label}</strong>
              <span className="muted small">{preset.description}</span>
            </summary>
            <p className="hint">教程要求</p>
            <pre className="guidance-preview-text">{preset.tutorial || '（无追加教程要求）'}</pre>
            <p className="hint">配图要求</p>
            <pre className="guidance-preview-text">{preset.figure || '（无追加配图要求）'}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

/**
 * 实际教学配置预览：选择一门课程，读取服务端按课程解析出的引导词。
 * 未归类/默认配置走同一个接口族的 sentinel 路径，前端不拼接、不近似。
 */
export function CourseGuidancePreview({ presets }: { presets: TeachingPreset[] }) {
  const organization = useOrganization();
  const [courseId, setCourseId] = useState('');
  const [guidance, setGuidance] = useState<CourseGuidance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const courses = useMemo(
    () => organization.data?.disciplines.flatMap((node) => node.courses.map((courseNode) => ({ course: courseNode.course, disciplineName: node.discipline.name }))) ?? [],
    [organization.data],
  );

  useEffect(() => {
    let active = true;
    setGuidance(null);
    setError('');
    setLoading(true);
    const load = courseId ? api.courseGuidance(courseId) : api.unclassifiedGuidance();
    load
      .then((result) => { if (active) setGuidance(result); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [courseId]);

  return (
    <div className="course-guidance" aria-label="实际教学配置预览">
      <h3>实际教学引导词</h3>
      <p className="muted small">选择一门课程，查看它此刻实际使用的教程与配图引导词。这里是教学引导词，不含任务上下文和输出格式。</p>
      {organization.error && <p className="error-text" role="alert">没能读取课程列表：{organization.error}</p>}
      <div className="actions-row" style={{ marginTop: 0 }}>
        <label className="field" style={{ flex: '1 1 260px' }}>
          <span className="label">选择课程</span>
          <select className="select" value={courseId} onChange={(event) => setCourseId(event.target.value)}>
            <option value="">未归类 / 默认配置</option>
            {courses.map((item) => (
              <option key={item.course.id} value={item.course.id}>{coursePath(organization.data, item.course.id)}</option>
            ))}
          </select>
        </label>
      </div>
      {courses.length === 0 && <p className="muted small">还没有专业课程。可以先去「学科与课程」里建一个；默认配置始终可用。</p>}
      {loading && <p className="muted" role="status">正在读取教学配置…</p>}
      {error && <p className="error-text" role="alert">没能读取教学配置：{error}</p>}
      {guidance && <GuidancePreviewCard guidance={guidance} />}
    </div>
  );
}

/**
 * 预览内容：来源与合并后的引导词都来自服务端返回的那一份。
 * 课程名、学科名、预设名一律照服务端给的显示，缺字段就如实留空，
 * 不在这里回落到"未归类"之类的默认值——那会把课程的真实来源掩盖掉。
 */
export function GuidancePreviewCard({ guidance }: { guidance: CourseGuidance }) {
  const source = guidance.courseId
    ? [guidance.disciplineName, guidance.courseName].filter(Boolean).join(' / ')
    : guidance.courseName;
  return (
    <div className="guidance-preview" aria-label={`${guidance.courseName} 的教学引导词`} data-guidance-course={guidance.courseId ?? 'unclassified'}>
      <p className="muted small" data-testid="guidance-source">
        来源：{source} · 预设「{guidance.presetLabel}」
        <span className="chip" title="教学配置指纹">指纹 {guidance.fingerprint.slice(0, 8)}</span>
      </p>
      <details open>
        <summary>教程引导词 <span className="muted small">（只读，服务端解析结果）</span></summary>
        <pre className="guidance-preview-text">{guidance.tutorialGuidance}</pre>
      </details>
      <details>
        <summary className="muted small">配图引导词（{guidance.figureGuidance.length} 字）</summary>
        <pre className="guidance-preview-text">{guidance.figureGuidance}</pre>
      </details>
    </div>
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
