import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

/** 加载一份数据：保留上一次成功的结果，出错时给出原因，可手动重新加载 */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    return load().then(
      (value) => {
        if (ticket !== latest.current) return;
        setData(value);
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

  return { data, error, loading, reload };
}

/** 条件成立时每隔一段时间刷新一次（后台还在生成内容时用） */
export function usePolling(active: boolean, refresh: () => void, intervalMs = 3000) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [active, refresh, intervalMs]);
}
