import { useEffect, useState } from 'react';
import { type SettingsView, type UserSettings, api } from '../api';
import { useResource } from '../hooks';
import { notificationPermission, requestNotificationPermission, showReminder } from '../reminders';

/** 设置：每个控件改完即保存，旁边显示"已保存" */
export function SettingsScreen() {
  const resource = useResource(() => api.settings(), []);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [stamp, setStamp] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (resource.data) setSettings(resource.data.settings);
  }, [resource.data]);

  async function save(patch: Partial<UserSettings>) {
    const before = settings;
    // 先在界面上改过来，再保存；保存失败时退回原值
    if (before) setSettings({ ...before, ...patch });
    setError('');
    setStamp('保存中…');
    try {
      setSettings(await api.saveSettings(patch));
      setStamp(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      setSettings(before);
      setStamp('');
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="title-row">
        <div>
          <h1>设置</h1>
          <p className="sub">改动立即生效，下一节微课堂就按新的设置安排。</p>
        </div>
        <span className="muted small" role="status">
          {error ? <span className="error-text">{error}</span> : stamp}
        </span>
      </div>
      {resource.error && <p className="error-text">{resource.error}</p>}
      {settings && resource.data && (
        <>
          <Pace settings={settings} save={save} />
          <Reminders settings={settings} save={save} />
          <Forms settings={settings} forms={resource.data.forms} save={save} />
          <Revisit settings={settings} save={save} />
        </>
      )}
    </>
  );
}

type SectionProps = { settings: UserSettings; save: (patch: Partial<UserSettings>) => void };

function Section({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <div className="label-col">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-panel">{children}</div>
    </section>
  );
}

function Pace({ settings, save }: SectionProps) {
  return (
    <Section title="学习节奏" description="一节微课堂的时长，以及每节最多学几个新知识点。到期复习多时，新学会自动减少；复习积压超过 3 节的量时暂停新学。">
      <div className="field">
        <span className="label">一节的时长</span>
        <div className="segmented" role="group" aria-label="一节的时长">
          {[5, 10, 15, 20].map((m) => (
            <button key={m} type="button" aria-pressed={settings.sessionMinutes === m} onClick={() => save({ sessionMinutes: m })}>
              {m} 分钟
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="label">每节最多的新知识点</span>
        <div className="segmented" role="group" aria-label="每节最多的新知识点">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-pressed={settings.maxNewPerSession === n} onClick={() => save({ maxNewPerSession: n })}>
              {n} 个
            </button>
          ))}
        </div>
        <span className="hint">每节至少有 1 个新知识点（复习积压时除外）。</span>
      </div>
    </Section>
  );
}

function Reminders({ settings, save }: SectionProps) {
  const [time, setTime] = useState('13:30');
  const [permission, setPermission] = useState(notificationPermission());
  const capOn = settings.dailySessionCap !== null;

  return (
    <Section
      title="提醒时段"
      description="每天固定的学习时刻，比如午饭后 13:30。到点发系统通知；这个时段已经学过一节就不提醒。漏掉的不补，到期内容顺延到下一节。"
    >
      <div className="field">
        <span className="label">时段</span>
        <div className="time-chips">
          {settings.reminderTimes.length === 0 && <span className="muted">还没有提醒时段</span>}
          {[...settings.reminderTimes].sort().map((t) => (
            <span key={t} className="pill" style={{ height: 32, paddingRight: 4 }}>
              <span className="num">{t}</span>
              <button
                type="button"
                className="btn small ghost"
                style={{ height: 24, padding: '0 8px' }}
                aria-label={`删除 ${t}`}
                onClick={() => save({ reminderTimes: settings.reminderTimes.filter((x) => x !== t) })}
              >
                删除
              </button>
            </span>
          ))}
        </div>
        <div className="actions-row" style={{ marginTop: 4 }}>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 140 }} aria-label="新的提醒时刻" />
          <button
            type="button"
            className="btn"
            disabled={!time || settings.reminderTimes.includes(time) || settings.reminderTimes.length >= 6}
            onClick={() => save({ reminderTimes: [...settings.reminderTimes, time] })}
          >
            添加时段
          </button>
        </div>
      </div>

      <div className="switch-row">
        <div>
          <div className="sr-title">
            系统通知
            <span className={`pill ${permission === 'granted' ? 'pos' : ''}`}>
              {{ granted: '已允许', denied: '已被浏览器拒绝', default: '未开启', unsupported: '浏览器不支持' }[permission]}
            </span>
          </div>
          <div className="sr-desc">本机运行，没有推送服务器：页面或安装的应用开着时才会提醒。</div>
        </div>
        {permission === 'default' && (
          <button type="button" className="btn small" onClick={async () => setPermission(await requestNotificationPermission())}>
            允许通知
          </button>
        )}
        {permission === 'granted' && (
          <button type="button" className="btn small ghost" onClick={() => showReminder('这是一条测试提醒。')}>
            试一下
          </button>
        )}
      </div>
      <div className="preview-note" aria-label="通知预览">
        <div className="pn-title">微课堂</div>
        <div className="muted">{[...settings.reminderTimes].sort()[0] ?? '13:30'} 到了，来一节微课堂吧。</div>
      </div>

      <div className="switch-row">
        <div>
          <div className="sr-title">每日节数上限</div>
          <div className="sr-desc">达到上限后，当天不再开新的一节。</div>
        </div>
        <input type="checkbox" className="switch" checked={capOn} onChange={(e) => save({ dailySessionCap: e.target.checked ? 3 : null })} aria-label="每日节数上限" />
      </div>
      {capOn && (
        <div className="segmented" role="group" aria-label="每天最多几节">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} type="button" aria-pressed={settings.dailySessionCap === n} onClick={() => save({ dailySessionCap: n })}>
              {n} 节
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

function Forms({ settings, forms, save }: SectionProps & { forms: SettingsView['forms'] }) {
  const blocked = new Set(settings.blockedForms as string[]);
  const boosted = new Set(settings.boostedExplainForms as string[]);
  const toggleBlocked = (id: string, on: boolean) =>
    save({ blockedForms: (on ? [...blocked, id] : [...blocked].filter((f) => f !== id)) as UserSettings['blockedForms'] });
  const toggleBoosted = (id: string, on: boolean) =>
    save({ boostedExplainForms: (on ? [...boosted, id] : [...boosted].filter((f) => f !== id)) as UserSettings['boostedExplainForms'] });

  return (
    <Section
      title="形式偏好"
      description="可以少出不喜欢的形式，或多用某些讲解形式。偏好只为减少烦躁，不承诺提升效果。核心检验形式保证检验的严格度，不能屏蔽。"
    >
      <div className="field">
        <span className="label">讲解形式</span>
        {forms.explain.map((f) => (
          <div key={f.id} className="switch-row" style={{ padding: '6px 0' }}>
            <div className="sr-title">{f.label}</div>
            <div style={{ display: 'flex', gap: 16 }}>
              <label className="check" style={{ padding: 0 }}>
                <input type="checkbox" checked={boosted.has(f.id)} disabled={blocked.has(f.id)} onChange={(e) => toggleBoosted(f.id, e.target.checked)} />
                多用
              </label>
              <label className="check" style={{ padding: 0 }}>
                <input type="checkbox" checked={blocked.has(f.id)} onChange={(e) => toggleBlocked(f.id, e.target.checked)} />
                不出
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="field">
        <span className="label">检验形式</span>
        {forms.question.map((f) => (
          <div key={f.id} className="switch-row" style={{ padding: '6px 0' }}>
            <div>
              <div className="sr-title">
                {f.label}
                {f.core && <span className="pill accent">核心检验</span>}
              </div>
              <div className="sr-desc">
                用于{f.stages.map((s) => s.stage).join('、')}
                {f.mobile ? '' : ' · 需要键盘，手机上不出'}
              </div>
            </div>
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={blocked.has(f.id)} disabled={f.core} onChange={(e) => toggleBlocked(f.id, e.target.checked)} />
              不出
            </label>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Revisit({ settings, save }: SectionProps) {
  return (
    <Section title="主题回访" description="每隔一段时间，在一节微课堂结束时问你：暂停的主题里，有哪些想恢复学习。">
      <div className="field">
        <span className="label">回访间隔</span>
        <div className="segmented" role="group" aria-label="回访间隔">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" aria-pressed={settings.revisitIntervalDays === d} onClick={() => save({ revisitIntervalDays: d })}>
              {d} 天
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
