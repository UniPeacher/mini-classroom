import { useEffect, useState } from 'react';
import { hasUnsavedChanges, requestNavigation } from './drafts';
import type { LearningScope } from './api';

/**
 * 页面地址（hash 路由，静态部署也能用）：
 * #/ 首页 · #/today 今天（#/today?scope=course:课程） · #/learn 学习中的一节 · #/map 认知地图（#/map/知识点）
 * #/topics/主题 · #/library 速查表与导出（#/library/速查表） · #/topic-drafts/讨论 主题澄清
 * #/organization 学科与课程（#/organization?discipline=学科 / ?course=课程）
 * #/settings 设置 · #/personalization 个性化（#/personalization/prompts 提示词）
 * #/review/日期?topic=主题 按天回看（在新标签页打开）
 */
export type PersonalizationTab = 'learning' | 'prompts';

export type Route =
  | { name: 'home' }
  | { name: 'today'; scope: LearningScope }
  | { name: 'learn' }
  | { name: 'map'; pointId?: string }
  | { name: 'topic'; topicId: string }
  | { name: 'topic-draft'; draftId: string }
  | { name: 'library'; cheatsheetId?: string }
  | { name: 'organization'; disciplineId?: string; courseId?: string; unclassified?: boolean }
  | { name: 'settings' }
  | { name: 'personalization'; tab: PersonalizationTab }
  | { name: 'review'; day: string; topicId?: string };

const ALL_SCOPE: LearningScope = { kind: 'all' };

/** 学习范围写进地址：all 不写参数，其余形如 course:<id> / discipline:<id> */
export function scopeParam(scope: LearningScope): string | undefined {
  return scope.kind === 'all' || !scope.id ? undefined : `${scope.kind}:${scope.id}`;
}

export function parseScope(value: string | null): LearningScope {
  if (!value) return ALL_SCOPE;
  const [kind, ...rest] = value.split(':');
  const id = rest.join(':');
  if (!id) return ALL_SCOPE;
  if (kind === 'course') return { kind: 'course', id };
  if (kind === 'discipline') return { kind: 'discipline', id };
  return ALL_SCOPE;
}

export function sameScope(a: LearningScope, b: LearningScope): boolean {
  return a.kind === b.kind && (a.kind === 'all' || a.id === b.id);
}

// ---------- 上次选择的学习范围 ----------
// 地址里的 scope 是唯一事实来源；这里只记住"最近一次明确选过的范围"，
// 供侧栏等没有携带范围的入口恢复，避免从某门课退出后又被重置成全部。

const LAST_SCOPE_KEY = 'weiketang.lastScope';

/** 记住用户明确选择的范围；选"全部"也照样记住，避免下次又变回别的范围 */
export function rememberScope(scope: LearningScope): void {
  try {
    sessionStorage.setItem(LAST_SCOPE_KEY, JSON.stringify(scope));
  } catch {
    // 隐私模式等禁用存储时忽略，只是不记住范围
  }
}

export function lastScope(): LearningScope {
  try {
    const raw = sessionStorage.getItem(LAST_SCOPE_KEY);
    if (!raw) return ALL_SCOPE;
    const value = JSON.parse(raw) as LearningScope;
    if (value.kind === 'all') return ALL_SCOPE;
    if ((value.kind === 'course' || value.kind === 'discipline') && typeof value.id === 'string' && value.id) {
      return { kind: value.kind, id: value.id };
    }
    return ALL_SCOPE;
  } catch {
    return ALL_SCOPE;
  }
}

/** 今天页地址：带范围时写进查询参数；未指定时沿用上次选择的范围 */
export function todayHash(scope?: LearningScope): string {
  return routeHash({ name: 'today', scope: scope ?? lastScope() });
}

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(search);
  switch (parts[0]) {
    case 'today':
      return { name: 'today', scope: parseScope(params.get('scope')) };
    case 'learn':
      return { name: 'learn' };
    case 'map':
      return { name: 'map', pointId: parts[1] };
    case 'topics':
      return parts[1] ? { name: 'topic', topicId: parts[1] } : { name: 'home' };
    case 'topic-drafts':
      return parts[1] ? { name: 'topic-draft', draftId: parts[1] } : { name: 'home' };
    case 'library':
      return { name: 'library', cheatsheetId: parts[1] };
    case 'organization':
      return {
        name: 'organization',
        disciplineId: params.get('discipline') ?? undefined,
        courseId: params.get('course') ?? undefined,
        unclassified: params.get('view') === 'unclassified' ? true : undefined,
      };
    case 'settings':
      return { name: 'settings' };
    case 'personalization':
      return { name: 'personalization', tab: parts[1] === 'prompts' ? 'prompts' : 'learning' };
    case 'review':
      return parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])
        ? { name: 'review', day: parts[1], topicId: params.get('topic') ?? undefined }
        : { name: 'home' };
    default:
      return { name: 'home' };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'today': {
      const scope = scopeParam(route.scope);
      return scope ? `#/today?scope=${encodeURIComponent(scope)}` : '#/today';
    }
    case 'learn':
      return '#/learn';
    case 'map':
      return route.pointId ? `#/map/${encodeURIComponent(route.pointId)}` : '#/map';
    case 'topic':
      return `#/topics/${encodeURIComponent(route.topicId)}`;
    case 'topic-draft':
      return `#/topic-drafts/${encodeURIComponent(route.draftId)}`;
    case 'library':
      return route.cheatsheetId ? `#/library/${encodeURIComponent(route.cheatsheetId)}` : '#/library';
    case 'organization': {
      const params = new URLSearchParams();
      if (route.courseId) params.set('course', route.courseId);
      else if (route.disciplineId) params.set('discipline', route.disciplineId);
      else if (route.unclassified) params.set('view', 'unclassified');
      const search = params.toString();
      return search ? `#/organization?${search}` : '#/organization';
    }
    case 'settings':
      return '#/settings';
    case 'personalization':
      return route.tab === 'prompts' ? '#/personalization/prompts' : '#/personalization';
    case 'review':
      return `#/review/${route.day}${route.topicId ? `?topic=${encodeURIComponent(route.topicId)}` : ''}`;
  }
}

export function navigate(route: Route): void {
  requestNavigation(routeHash(route));
}

/**
 * 页面内的地址跳转统一经过这里：还有未保存的修改时先确认。
 * 同一页面的子视图切换（如个性化标签、组织结构选中）不拦截——页面不卸载，编辑内容仍然保留。
 */
export function useNavigationGuard(current: Route): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href^="#/"]') : null;
      if (!anchor || anchor.getAttribute('target')) return;
      const hash = anchor.getAttribute('href');
      if (!hash) return;
      // 停留在同一页面上的跳转（只改查询参数）不打断正在编辑的内容
      if (parseRoute(hash).name === current.name) return;
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.stopPropagation();
      requestNavigation(hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [current.name]);
}

/** 在新标签页打开按天回看，不打断当前页面 */
export function openReview(day: string, topicId?: string): void {
  window.open(routeHash({ name: 'review', day, topicId }), '_blank');
}

/** 地址变化时更新当前页面；切页不丢地址里保存的范围与选中项 */
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
