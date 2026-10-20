import { useEffect, useState } from 'react';
import { type Stage, api, downloadText } from '../api';
import { Icon } from '../components/Icon';
import { usePolling, useResource } from '../hooks';
import { STAGE_LABEL, formatTime } from '../labels';
import { RichMarkdown } from '../RichMarkdown';
import { navigate, routeHash } from '../router';

const SHEET_STAGES: Stage[] = ['recall', 'apply', 'retain'];
const STATUS_LABEL = { pending: '生成中', ready: '已完成', failed: '生成失败' } as const;

/** 速查表与导出：把认知地图的一部分整理成速查表，或导出为 Markdown，只供自己使用 */
export function LibraryScreen({ cheatsheetId }: { cheatsheetId?: string }) {
  if (cheatsheetId) return <CheatsheetView id={cheatsheetId} />;
  return <LibraryHome />;
}

function LibraryHome() {
  const topics = useResource(() => api.listTopics().then((r) => r.topics.filter((t) => t.graphStatus === 'ready')), []);
  const sheets = useResource(() => api.cheatsheets().then((r) => r.cheatsheets), []);
  usePolling((sheets.data ?? []).some((s) => s.status === 'pending'), sheets.reload);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>速查表与导出</h1>
          <p className="sub">速查表由 AI 按你选的范围整理，带上易混对比和你自己建立的联结；导出的 Markdown 只供你自己使用。</p>
        </div>
      </div>
      <div className="grid top">
        <section className="panel span-6" aria-labelledby="sheet-form-title">
          <CheatsheetForm topics={topics.data ?? []} onCreated={sheets.reload} />
        </section>
        <section className="panel span-6" aria-labelledby="export-title">
          <ExportForm topics={topics.data ?? []} sheets={(sheets.data ?? []).filter((s) => s.status === 'ready')} />
        </section>
        <section className="panel span-12" aria-labelledby="sheets-title">
          <header>
            <h2 id="sheets-title">
              速查表 <span className="chip">{sheets.data?.length ?? 0}</span>
            </h2>
          </header>
          {sheets.data && sheets.data.length === 0 && <div className="empty">还没有速查表。在上面选好范围生成一份。</div>}
          <div className="rows">
            {(sheets.data ?? []).map((s) => (
              <a key={s.id} className="row-card" href={routeHash({ name: 'library', cheatsheetId: s.id })}>
                <span className="row-main">
                  <span className="row-title">{s.title}</span>
                  <span className="row-sub">{formatTime(s.createdAt)}</span>
                </span>
                <span className={`pill ${s.status === 'ready' ? 'pos' : s.status === 'failed' ? 'neg' : ''}`}>{STATUS_LABEL[s.status]}</span>
              </a>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

type TopicOption = { id: string; title: string };

function TopicChecks({ topics, picked, onChange }: { topics: TopicOption[]; picked: string[]; onChange: (ids: string[]) => void }) {
  if (topics.length === 0) return <p className="muted">还没有可选的学习主题。</p>;
  return (
    <div>
      {topics.map((t) => (
        <label key={t.id} className="check">
          <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...picked, t.id] : picked.filter((id) => id !== t.id))} />
          <span>{t.title}</span>
        </label>
      ))}
    </div>
  );
}

function CheatsheetForm({ topics, onCreated }: { topics: TopicOption[]; onCreated: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>(['apply', 'retain']);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setPicked((prev) => (prev.length === 0 ? topics.map((t) => t.id) : prev)), [topics]);

  async function create() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await api.createCheatsheet(picked, stages);
      setMessage(`正在整理"${r.title}"，收录 ${r.pointCount} 个知识点，完成后出现在下方列表。`);
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
        <h2 id="sheet-form-title">生成速查表</h2>
      </header>
      <div className="stack">
        <div className="field">
          <span className="label">范围</span>
          <TopicChecks topics={topics} picked={picked} onChange={setPicked} />
        </div>
        <div className="field">
          <span className="label">收录哪些阶段的知识点</span>
          <span className="hint">默认只收已能应用或长期保持的，速查表才可靠。</span>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {SHEET_STAGES.map((stage) => (
              <label key={stage} className="check">
                <input type="checkbox" checked={stages.includes(stage)} onChange={(e) => setStages(e.target.checked ? [...stages, stage] : stages.filter((s) => s !== stage))} />
                <span>{STAGE_LABEL[stage]}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn primary" onClick={create} disabled={busy || picked.length === 0 || stages.length === 0}>
            {busy ? '提交中…' : '生成速查表'}
          </button>
        </div>
        {message && <p className="notice ok">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}

function ExportForm({ topics, sheets }: { topics: TopicOption[]; sheets: { id: string; title: string }[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [records, setRecords] = useState(true);
  const [sheetId, setSheetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setPicked((prev) => (prev.length === 0 ? topics.map((t) => t.id) : prev)), [topics]);

  async function exportFile() {
    setBusy(true);
    setError('');
    try {
      const { filename, markdown } = await api.exportMarkdown(picked, records, sheetId || undefined);
      downloadText(filename, markdown);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header>
        <h2 id="export-title">导出 Markdown</h2>
      </header>
      <div className="stack">
        <div className="field">
          <span className="label">范围</span>
          <TopicChecks topics={topics} picked={picked} onChange={setPicked} />
        </div>
        <div className="switch-row">
          <div>
            <div className="sr-title">附上作答记录</div>
            <div className="sr-desc">每次作答的形式、你的回答、批改和申诉结果</div>
          </div>
          <input type="checkbox" className="switch" checked={records} onChange={(e) => setRecords(e.target.checked)} aria-label="附上作答记录" />
        </div>
        <label className="field">
          <span className="label">附上速查表</span>
          <select className="select" value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
            <option value="">不附</option>
            {sheets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn primary" onClick={exportFile} disabled={busy || picked.length === 0}>
            <Icon name="download" />
            {busy ? '正在导出…' : '下载 .md 文件'}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}

function CheatsheetView({ id }: { id: string }) {
  const sheet = useResource(() => api.cheatsheet(id), [id]);
  usePolling(sheet.data?.status === 'pending', sheet.reload);
  const data = sheet.data;
  return (
    <>
      <a className="back-link" href={routeHash({ name: 'library' })}>
        <Icon name="back" />
        速查表与导出
      </a>
      {sheet.error && <p className="error-text">{sheet.error}</p>}
      {data && (
        <div className="grid top">
          <article className="span-8">
            <div className="title-row">
              <div>
                <h1>{data.title}</h1>
                <p className="sub">{formatTime(data.createdAt)}</p>
              </div>
            </div>
            {data.status === 'pending' && <p className="muted">正在整理，大约半分钟，好了会自动显示。</p>}
            {data.status === 'failed' && <p className="error-text">这份速查表没能生成。回到上一页重新生成一份。</p>}
            {data.markdown && (
              <div className="reading">
                <RichMarkdown>{data.markdown}</RichMarkdown>
              </div>
            )}
          </article>
          <aside className="span-4 rail">
            <section className="panel" aria-labelledby="sheet-actions">
              <header>
                <h2 id="sheet-actions">这份速查表</h2>
              </header>
              <p className="muted" style={{ marginBottom: 12 }}>
                范围：{(data.scope as { stages: Stage[] }).stages.map((s) => STAGE_LABEL[s]).join('、')}阶段的知识点
              </p>
              <div className="actions-row" style={{ marginTop: 0 }}>
                <button type="button" className="btn" disabled={!data.markdown} onClick={() => downloadText(`${data.title}.md`, data.markdown ?? '')}>
                  <Icon name="download" />
                  下载 .md
                </button>
                <button type="button" className="btn ghost" onClick={() => navigate({ name: 'library' })}>
                  返回
                </button>
              </div>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
