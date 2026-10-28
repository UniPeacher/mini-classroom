import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

export interface ResourceOptions {
  /**
   * 这次查询的条件标识（如学习范围）。变化后，旧数据在渲染时就被视为不存在，
   * 不会出现"新条件名 + 旧内容"同时显示的一帧；等新结果回来再显示。
   * 手动 reload（如轮询）不影响它。
   */
  staleKey?: string;
}

/**
 * 加载一份数据：保留上一次成功的结果，出错时给出原因，可手动重新加载。
 * 传了 staleKey 时，条件一变旧结果立即失效：data 变为 null，loading 视为 true，
 * 调用方据此显示加载态并禁用依赖该数据的操作。
 */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList, options: ResourceOptions = {}) {
  const { staleKey } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** 当前 data 属于哪个条件；与 staleKey 不同就说明还没加载这个条件 */
  const [dataKey, setDataKey] = useState<string | undefined>(undefined);
  const latest = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    const ticket = ++latest.current;
    const keyAtRequest = staleKey;
    setLoading(true);
    return load().then(
      (value) => {
        if (ticket !== latest.current) return;
        setData(value);
        setDataKey(keyAtRequest);
        setError('');
        setLoading(false);
      },
      (e: Error) => {
        if (ticket !== latest.current) return;
        setError(e.message);
        setLoading(false);
      },
    );
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 条件已经变了但新结果还没回来：当作没有数据、仍在加载
  const stale = staleKey !== undefined && dataKey !== staleKey;
  return {
    data: stale ? null : data,
    error: stale ? '' : error,
    loading: stale || loading,
    reload,
  };
}

/** 条件成立时每隔一段时间刷新一次（后台还在生成内容时用） */
export function usePolling(active: boolean, refresh: () => void, intervalMs = 3000) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [active, refresh, intervalMs]);
}
