import { useState } from 'react';
import { type LearningScope, type Preview, type Session, api, isApiError } from '../api';
import { PURPOSE_LABEL } from '../labels';

export type StartKind = 'start' | 'resume' | 'build';

/**
 * 首页和今天使用同一开始入口：
 * - resume 明确继续未完成的一节（忽略当前选择的范围）；
 * - build 明确构建新一节（会结束未完成的一节，旧课堂在新内容准备好后才结束）；
 * - start 只在新课堂没有未完成的一节时使用，否则交给调用方展示续课面板。
 */
export function useSessionStart(onStart: (session: Session, notice?: string) => void) {
  const [busy, setBusy] = useState<StartKind | null>(null);
  const [error, setError] = useState('');
  /** 服务端要求先确认如何处理未完成的一节 */
  const [openConflict, setOpenConflict] = useState(false);

  async function run(kind: StartKind, options: { guidance?: string; scope?: LearningScope } = {}) {
    if (busy) return;
    setBusy(kind);
    setError('');
    setOpenConflict(false);
    try {
      const result = await api.nextSession({
        guidance: options.guidance,
        scope: options.scope,
        resume: kind === 'resume',
        fresh: kind === 'build',
      });
      if (result.session) onStart(result.session, noticeOf(kind, result.resumed, result.guided));
      else if (result.capped) setError('今天已达到每日节数上限，可以在个性化的「学习节奏」里调整。');
      else setError(result.preparing ? '内容还在后台准备，稍等一会儿再试。' : '现在没有可学的内容：所有主题都在等摸底、已暂停，或已全部学完。');
    } catch (e) {
      // 有未完成的一节且没有明确继续或新建：不静默替换，交给界面显示续课面板
      if (isApiError(e, 'open-session')) setOpenConflict(true);
      else setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, openConflict, clearConflict: () => setOpenConflict(false), run };
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

/**
 * 预览内容：默认只展示"按当前范围已为新课堂挑好的内容"；
 * 只有显式传 source="open"（续课面板）时才展示未完成课堂的进度，不会自动替换。
 */
/**
 * 预览内容。source 决定显示哪一份，永远不隐式选择：
 * - 'next'：按当前所选范围为新课堂挑好的内容（今天页"这一节会学什么"）；
 * - 'open'：未完成课堂自身的进度（续课面板）；
 * - 'scope'：同 'next'，供首页等沿用。
 */
export function SessionContents({ preview, limit = 6, remainingOnly = false, source = 'scope' }: { preview: Preview | null; limit?: number; remainingOnly?: boolean; source?: 'scope' | 'next' | 'open' }) {
  const showOpen = source === 'open' && preview?.open !== null;
  let items = showOpen ? preview!.open!.items : (preview?.items.map((i) => ({ ...i, done: false, excluded: false })) ?? []);
  if (remainingOnly) items = items.filter((item) => !item.done && !item.excluded);
  const shown = items.slice(0, limit);

  if (!preview) return <div className="rows" aria-label="正在读取学习内容">{[0, 1, 2].map((i) => <div key={i} className="row-card"><span className="skeleton line" style={{ width: '60%' }} /></div>)}</div>;
  if (items.length === 0) return <div className="empty">{showOpen ? '本节内容已处理完，可以继续查看结果。' : preview.capped ? '今天已达到学习上限，可以回看已学内容。' : preview.preparing ? '内容正在后台准备，好了会自动显示。' : '暂时没有到期的复习，也没有备好的新知识点。'}</div>;

  return (
    <div className="rows session-contents">
      {shown.map((item, i) => (
        <div key={i} className="row-card">
          <span className={`pill ${item.purpose === 'new' ? 'accent' : ''}`}>{PURPOSE_LABEL[item.purpose]}</span>
          <div className="row-main">
            <div className="row-title">{item.title}</div>
            <div className="row-sub">{item.topicTitle} · {item.formLabel}</div>
          </div>
          {showOpen && !remainingOnly && <span className={`pill ${item.excluded ? 'learning-excluded' : item.done ? 'pos' : ''}`}>{item.excluded ? '不学' : item.done ? '已做' : '待做'}</span>}
        </div>
      ))}
      {items.length > shown.length && <p className="muted small">还有 {items.length - shown.length} 项</p>}
    </div>
  );
}

/** 开始一节后，说明用户提交的讲法要求是否被应用。 */
function noticeOf(kind: StartKind, resumed: boolean, guided: { applied: number; total: number } | null): string | undefined {
  if (kind === 'resume') return undefined;
  if (resumed) return '还有一节没完成，先继续那一节；补充说明这次没有用上。';
  if (kind !== 'build' || !guided) return undefined;
  if (guided.applied === guided.total) return '本节内容已按补充说明生成。';
  if (guided.applied === 0) return '按补充说明生成失败，这一节用的是原来准备好的内容。';
  return `有 ${guided.total - guided.applied} 项按补充说明生成失败，用的是原来准备好的内容。`;
}
