import { useState } from 'react';
import { type Preview, type Session, api } from '../api';
import { PURPOSE_LABEL } from '../labels';

/** 首页和今天使用同一开始入口，恢复学习时不重建未完成的一节。 */
export function useSessionStart(onStart: (session: Session, notice?: string) => void) {
  const [busy, setBusy] = useState<'start' | 'build' | null>(null);
  const [error, setError] = useState('');

  async function run(kind: 'start' | 'build', guidance?: string, subject?: string | null) {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      const result = await api.nextSession({ guidance, fresh: kind === 'build', subject });
      if (result.session) onStart(result.session, guidanceNotice(Boolean(guidance), result.resumed, result.guided));
      else if (result.capped) setError('今天已达到每日节数上限，可以在设置里调整。');
      else setError(result.preparing ? '内容还在后台准备，稍等一会儿再试。' : '现在没有可学的内容：所有主题都在等摸底、已暂停，或已全部学完。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, run };
}

export function describeCounts(preview: Preview): string {
  const { counts } = preview;
  return [
    counts.review + counts.contrast > 0 ? `${counts.review + counts.contrast} 道复习` : '',
    counts.spotCheck > 0 ? `${counts.spotCheck} 道抽查` : '',
    counts.advance > 0 ? `${counts.advance} 个重讲` : '',
    counts.new > 0 ? `${counts.new} 个新知识点` : '',
  ].filter(Boolean).join('、');
}

/** 首页只预览尚待学习的内容；今天保留本节完整的完成与排除状态。 */
export function SessionContents({ preview, limit = 6, remainingOnly = false }: { preview: Preview | null; limit?: number; remainingOnly?: boolean }) {
  let items = preview?.open ? preview.open.items : (preview?.items.map((i) => ({ ...i, done: false, excluded: false })) ?? []);
  if (remainingOnly) items = items.filter((item) => !item.done && !item.excluded);
  const shown = items.slice(0, limit);

  if (!preview) return <div className="rows" aria-label="正在读取学习内容">{[0, 1, 2].map((i) => <div key={i} className="row-card"><span className="skeleton line" style={{ width: '60%' }} /></div>)}</div>;
  if (items.length === 0) return <div className="empty">{preview.open ? '本节内容已处理完，可以继续查看结果。' : preview.capped ? '今天已达到学习上限，可以回看已学内容。' : preview.preparing ? '内容正在后台准备，好了会自动显示。' : '暂时没有到期的复习，也没有备好的新知识点。'}</div>;

  return (
    <div className="rows session-contents">
      {shown.map((item, i) => (
        <div key={i} className="row-card">
          <span className={`pill ${item.purpose === 'new' ? 'accent' : ''}`}>{PURPOSE_LABEL[item.purpose]}</span>
          <div className="row-main">
            <div className="row-title">{item.title}</div>
            <div className="row-sub">{item.topicTitle} · {item.formLabel}</div>
          </div>
          {preview.open && !remainingOnly && <span className={`pill ${item.excluded ? 'learning-excluded' : item.done ? 'pos' : ''}`}>{item.excluded ? '不学' : item.done ? '已做' : '待做'}</span>}
        </div>
      ))}
      {items.length > shown.length && <p className="muted small">还有 {items.length - shown.length} 项</p>}
    </div>
  );
}

/** 开始一节后，说明用户提交的讲法要求是否被应用。 */
function guidanceNotice(sent: boolean, resumed: boolean, guided: { applied: number; total: number } | null): string | undefined {
  if (!sent) return undefined;
  if (resumed) return '还有一节没完成，先继续那一节；补充说明这次没有用上。';
  if (!guided) return undefined;
  if (guided.applied === guided.total) return '本节内容已按补充说明生成。';
  if (guided.applied === 0) return '按补充说明生成失败，这一节用的是原来准备好的内容。';
  return `有 ${guided.total - guided.applied} 项按补充说明生成失败，用的是原来准备好的内容。`;
}
