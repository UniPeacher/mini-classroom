import { useEffect, useState } from 'react';
import { type AiSettingsPatch, type AiSettingsView, type AiTestResult, api } from '../api';
import { Section } from '../components/SettingsSection';
import { useResource } from '../hooks';

type TextView = AiSettingsView['text'];
type ImageView = AiSettingsView['image'];

const PROVIDER_LABEL: Record<TextView['provider'], string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic', google: 'Gemini' };
const EFFORT_LABEL: Record<TextView['reasoningEffort'], string> = { '': '模型默认', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/**
 * AI 模型设置：文本模型和画图模型分别配置。
 * 和其他设置不同，几个字段要一起才说得通，所以填好后点"保存"；保存前可以先"测试"表单里的配置。
 */
export function AiSettings() {
  const resource = useResource(() => api.aiSettings(), []);
  const [view, setView] = useState<AiSettingsView | null>(null);
  useEffect(() => {
    if (resource.data) setView(resource.data);
  }, [resource.data]);

  if (resource.error) return <p className="error-text">{resource.error}</p>;
  if (!view) return null;
  return (
    <>
      <Section title="文本模型" description="写讲解、出题、批改、回答提问都用它。保存后下一次调用就生效，不用重启。密钥只存在本机，页面上只显示末 4 位。">
        <TextForm value={view.text} onSaved={setView} />
      </Section>
      <Section title="画图模型" description="根据讲解内容生成配图，帮助理解概念、过程和关系。可选；留空也能使用文字讲解和基础图解。">
        <ImageForm value={view.image} textBaseUrl={view.text.baseUrl} onSaved={setView} />
      </Section>
    </>
  );
}

/** 保存、测试两个按钮和结果；文本、画图两份表单共用 */
function useAiForm(target: 'text' | 'image', patch: () => AiSettingsPatch, onSaved: (view: AiSettingsView) => void) {
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [status, setStatus] = useState<{ tone: 'pos' | 'neg' | ''; text: string } | null>(null);
  const [testImage, setTestImage] = useState<string | null>(null);

  async function save() {
    setBusy('save');
    setStatus(null);
    try {
      onSaved(await api.saveAiSettings(patch()));
      setStatus({ tone: 'pos', text: `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` });
    } catch (e) {
      setStatus({ tone: 'neg', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setStatus({ tone: '', text: target === 'image' ? '正在画一张测试图，大约半分钟…' : '正在测试…' });
    setTestImage(null);
    try {
      const result: AiTestResult = await api.testAi(target, patch());
      setStatus({ tone: result.ok ? 'pos' : 'neg', text: `${result.ok ? '连接正常' : '连接失败'}：${result.message}${result.seconds ? ` · ${result.seconds} 秒` : ''}` });
      setTestImage(result.image ?? null);
    } catch (e) {
      setStatus({ tone: 'neg', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const actions = (dirty: boolean) => (
    <>
      <div className="actions-row" style={{ marginTop: 0 }}>
        <button type="button" className="btn primary" disabled={!dirty || busy !== null} onClick={save}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn ghost" disabled={busy !== null} onClick={test}>
          {target === 'image' ? '测试画图' : '测试连接'}
        </button>
      </div>
      {status && (
        <p className={status.tone === 'neg' ? 'error-text' : status.tone === 'pos' ? 'small' : 'muted small'} role="status">
          {status.text}
        </p>
      )}
      {testImage && <img className="ai-test-image" src={testImage} alt="测试画出的图" />}
    </>
  );
  return { actions };
}

/** 密钥输入：留空表示不修改已保存的密钥 */
function KeyField({ hint, value, onChange, fallback }: { hint: string | null; value: string; onChange: (v: string) => void; fallback?: string }) {
  return (
    <label className="field">
      <span className="label">API 密钥</span>
      <input
        className="input"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint ? `已保存 ${hint}，留空不修改` : (fallback ?? '未填写')}
      />
    </label>
  );
}

function TextForm({ value, onSaved }: { value: TextView; onSaved: (view: AiSettingsView) => void }) {
  const [draft, setDraft] = useState({ provider: value.provider, baseUrl: value.baseUrl, model: value.model, reasoningEffort: value.reasoningEffort, structuredOutputs: value.structuredOutputs });
  const [apiKey, setApiKey] = useState('');
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = apiKey !== '' || (Object.keys(draft) as (keyof typeof draft)[]).some((k) => draft[k] !== value[k]);
  const { actions } = useAiForm('text', () => ({ text: { ...draft, ...(apiKey ? { apiKey } : {}) } }), (view) => {
    setApiKey('');
    onSaved(view);
  });
  const compatible = draft.provider === 'openai-compatible';

  return (
    <>
      <div className="settings-field-grid">
        <label className="field">
          <span className="label">接口格式</span>
          <select className="select" value={draft.provider} onChange={(e) => set({ provider: e.target.value as TextView['provider'] })}>
            {(Object.keys(PROVIDER_LABEL) as TextView['provider'][]).map((provider) => (
              <option key={provider} value={provider}>{PROVIDER_LABEL[provider]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">模型名称</span>
          <input className="input" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="例如 gpt-5.6-sol" />
        </label>
        <label className="field settings-field-wide">
          <span className="label">接口地址</span>
          <input className="input" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={compatible ? '例如 http://localhost:8317/v1' : '留空用官方地址'} />
          {!compatible && <span className="hint">走代理时填代理地址。</span>}
        </label>
        <KeyField hint={value.apiKeyHint} value={apiKey} onChange={setApiKey} />
        <label className="field">
          <span className="label">推理强度</span>
          <select className="select" value={draft.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value as TextView['reasoningEffort'] })}>
            {(Object.keys(EFFORT_LABEL) as TextView['reasoningEffort'][]).map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABEL[e]}
              </option>
            ))}
          </select>
          <span className="hint">xhigh、max 只有 Anthropic 支持；Gemini 只分 low、medium、high。</span>
        </label>
      </div>
      {compatible && (
        <div className="switch-row">
          <div>
            <div className="sr-title">严格结构化输出</div>
            <div className="sr-desc">模型支持严格 JSON Schema 时打开；不支持时关掉，改用 json_object 模式。</div>
          </div>
          <input type="checkbox" className="switch" checked={draft.structuredOutputs} onChange={(e) => set({ structuredOutputs: e.target.checked })} aria-label="严格结构化输出" />
        </div>
      )}
      {actions(dirty)}
    </>
  );
}

function ImageForm({ value, textBaseUrl, onSaved }: { value: ImageView; textBaseUrl: string; onSaved: (view: AiSettingsView) => void }) {
  const [draft, setDraft] = useState({ model: value.model, baseUrl: value.baseUrl });
  const [apiKey, setApiKey] = useState('');
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = apiKey !== '' || draft.model !== value.model || draft.baseUrl !== value.baseUrl;
  const { actions } = useAiForm('image', () => ({ image: { ...draft, ...(apiKey ? { apiKey } : {}) } }), (view) => {
    setApiKey('');
    onSaved(view);
  });

  return (
    <>
      <div className="settings-field-grid">
        <label className="field">
          <span className="label">模型名称</span>
          <input className="input" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="例如 gpt-image-2；留空表示不画插画" />
        </label>
        <KeyField hint={value.apiKeyHint} value={apiKey} onChange={setApiKey} fallback="留空沿用文本模型的密钥" />
        <label className="field settings-field-wide">
          <span className="label">接口地址</span>
          <input className="input" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={textBaseUrl ? `留空沿用文本模型：${textBaseUrl}` : '例如 http://localhost:8317/v1'} />
        </label>
      </div>
      {actions(dirty)}
    </>
  );
}
