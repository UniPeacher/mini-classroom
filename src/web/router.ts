import { useEffect, useState } from 'react';

/**
 * 页面地址（hash 路由，静态部署也能用）：
 * #/ 今天 · #/learn 学习中的一节 · #/map 认知地图（#/map/知识点） · #/topics/主题 · #/library 速查表与导出
 * （#/library/速查表） · #/settings 设置 · #/review/日期?topic=主题 按天回看（在新标签页打开）
 */
export type Route =
  | { name: 'today' }
  | { name: 'learn' }
  | { name: 'map'; pointId?: string }
  | { name: 'topic'; topicId: string }
  | { name: 'library'; cheatsheetId?: string }
  | { name: 'settings' }
  | { name: 'review'; day: string; topicId?: string };

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(search);
  switch (parts[0]) {
    case 'learn':
      return { name: 'learn' };
    case 'map':
      return { name: 'map', pointId: parts[1] };
    case 'topics':
      return parts[1] ? { name: 'topic', topicId: parts[1] } : { name: 'today' };
    case 'library':
      return { name: 'library', cheatsheetId: parts[1] };
    case 'settings':
      return { name: 'settings' };
    case 'review':
      return parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])
        ? { name: 'review', day: parts[1], topicId: params.get('topic') ?? undefined }
        : { name: 'today' };
    default:
      return { name: 'today' };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'today':
      return '#/';
    case 'learn':
      return '#/learn';
    case 'map':
      return route.pointId ? `#/map/${encodeURIComponent(route.pointId)}` : '#/map';
    case 'topic':
      return `#/topics/${encodeURIComponent(route.topicId)}`;
    case 'library':
      return route.cheatsheetId ? `#/library/${encodeURIComponent(route.cheatsheetId)}` : '#/library';
    case 'settings':
      return '#/settings';
    case 'review':
      return `#/review/${route.day}${route.topicId ? `?topic=${encodeURIComponent(route.topicId)}` : ''}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

/** 在新标签页打开按天回看，不打断当前页面 */
export function openReview(day: string, topicId?: string): void {
  window.open(routeHash({ name: 'review', day, topicId }), '_blank');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
