import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 未保存修改的统一登记处。
 * 各处（提示词编辑区、学科与课程管理）在草稿与已保存值不一致时登记；
 * 离开页面前由 App 统一显示"放弃修改 / 留在本页"，避免切页后悄悄丢掉编辑内容。
 */
const dirtySources = new Map<symbol, string>();

/** 登记一处未保存的修改；返回撤销函数。组件外（如分支逻辑）也可用 */
export function markDirty(source: symbol, message: string): () => void {
  dirtySources.set(source, message);
  return () => dirtySources.delete(source);
}

/** 直接清空全部登记：只在"放弃修改并离开"时使用 */
export function clearAllDirty(): void {
  dirtySources.clear();
}

export function hasUnsavedChanges(): boolean {
  return dirtySources.size > 0;
}

export function unsavedMessage(): string {
  return [...dirtySources.values()][0] ?? '有未保存的修改';
}

// ---------- 待离开的目标地址：由导航拦截写入，App 显示确认对话框 ----------

let pendingHash: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPending(): string | null {
  return pendingHash;
}

/** 有未保存修改时先记下目标地址，等用户在对话框里选择 */
export function requestNavigation(hash: string): void {
  if (!hasUnsavedChanges()) {
    applyHash(hash);
    return;
  }
  pendingHash = hash;
  emit();
}

export function usePendingNavigation(): string | null {
  return useSyncExternalStore(subscribe, getPending, getPending);
}

/** 放弃修改并前往之前请求的地址 */
export function discardAndNavigate(): void {
  const target = pendingHash;
  pendingHash = null;
  clearAllDirty();
  emit();
  if (target) applyHash(target);
}

/** 非浏览器环境（静态渲染、测试）里没有 window，跳过真正的跳转 */
function applyHash(hash: string): void {
  if (typeof window !== 'undefined') window.location.hash = hash;
}

/** 留在本页，清掉待处理的跳转 */
export function stayOnPage(): void {
  pendingHash = null;
  emit();
}

/** 登记本组件的未保存状态；卸载或保存后自动撤销 */
export function useDraftGuard(dirty: boolean, message = '有未保存的修改'): void {
  const key = useRef(Symbol('draft'));
  const latest = useRef(message);
  latest.current = message;
  useEffect(() => {
    if (!dirty) return;
    return markDirty(key.current, latest.current);
  }, [dirty]);
}

/** 页面关闭或刷新时提醒（浏览器自带的确认框） */
export function useBeforeUnloadGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      // 部分浏览器仍要求设置 returnValue
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
