import { discardAndNavigate, stayOnPage, unsavedMessage, usePendingNavigation } from '../drafts';

/** 离开确认：放弃修改并前往，或留在本页继续编辑。同一页面的子视图切换不经过这里 */
export function UnsavedChangesDialog() {
  const target = usePendingNavigation();
  if (!target) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) stayOnPage(); }}>
      <div className="modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-desc">
        <h2 id="unsaved-title">还有未保存的修改</h2>
        <p id="unsaved-desc">{unsavedMessage()}。离开这个页面会丢失这些修改。</p>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn primary" onClick={stayOnPage} autoFocus>留在此页</button>
          <button type="button" className="btn ghost" onClick={discardAndNavigate}>放弃修改并离开</button>
        </div>
      </div>
    </div>
  );
}
