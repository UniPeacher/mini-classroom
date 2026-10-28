import { useEffect, useState } from 'react';
import { type Session, api, devNow } from './api';
import { Icon, type IconName, Mark } from './components/Icon';
import { useReminders } from './reminders';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog';
import { type Route, navigate, routeHash, todayHash, useNavigationGuard, useRoute } from './router';
import { OrganizationProvider, useOrganization } from './organization';
import { useBeforeUnloadGuard } from './drafts';
import { DayReviewPage } from './screens/DayReviewPage';
import { HomeScreen } from './screens/HomeScreen';
import { LearnScreen } from './screens/LearnScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { MapScreen } from './screens/MapScreen';
import { OrganizationScreen } from './screens/OrganizationScreen';
import { PersonalizationScreen } from './screens/PersonalizationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TodayScreen } from './screens/TodayScreen';
import { TopicScreen } from './screens/TopicScreen';
import { TopicPlanningScreen } from './screens/TopicPlanningScreen';
// 公式的字体和排版来自 KaTeX；放在项目样式之前，方便主题覆盖
import 'katex/dist/katex.min.css';
import './styles.css';

const NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: 'home' }, label: '首页', icon: 'home' },
  { route: { name: 'today', scope: { kind: 'all' } }, label: '今天', icon: 'today' },
  { route: { name: 'map' }, label: '认知地图', icon: 'map' },
  { route: { name: 'organization' }, label: '学科与课程', icon: 'books' },
  { route: { name: 'library' }, label: '速查表与导出', icon: 'library' },
];

const PREFERENCES_NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: 'personalization', tab: 'learning' }, label: '个性化', icon: 'personalize' },
  { route: { name: 'settings' }, label: '设置', icon: 'settings' },
];

const TITLES: Record<Route['name'], string> = {
  home: '首页',
  today: '今天',
  learn: '微课堂',
  map: '认知地图',
  topic: '学习主题',
  'topic-draft': '明确学习目标',
  library: '速查表与导出',
  organization: '学科与课程',
  settings: '设置',
  personalization: '个性化',
  review: '按天回看',
};

export function App() {
  return (
    <OrganizationProvider>
      <AppShell />
    </OrganizationProvider>
  );
}

function AppShell() {
  const route = useRoute();
  const [devMode, setDevMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 开始的一节放在内存里；刷新学习页时由服务端恢复未完成的一节
  const [session, setSession] = useState<{ session: Session; notice?: string } | null>(null);
  useReminders();
  useBeforeUnloadGuard();
  useNavigationGuard(route);

  useEffect(() => {
    api.health().then((h) => setDevMode(h.devMode), () => setDevMode(false));
  }, []);
  useEffect(() => setMenuOpen(false), [route]);

  // 回看页在新标签页里打开，没有侧栏
  if (route.name === 'review') return <DayReviewPage day={route.day} topicId={route.topicId} />;

  const startSession = (next: Session, notice?: string) => {
    setSession({ session: next, notice });
    navigate({ name: 'learn' });
  };

  return (
    <div className="app">
      <nav className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="主导航">
        <div className="brand">
          <a className="brand-home" href={routeHash({ name: 'home' })} aria-label="微课堂首页" onClick={() => setMenuOpen(false)}>
            <Mark />
            <span>微课堂</span>
          </a>
          <button type="button" className="icon-btn close-menu" style={{ marginLeft: 'auto' }} aria-label="关闭菜单" onClick={() => setMenuOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sidebar-scroll">
          {NAV.map((item) => (
            <a
              key={item.label}
              className="nav-item"
              /* 今天页回到上次选过的范围，不重置成全部 */
              href={item.route.name === 'today' ? todayHash() : routeHash(item.route)}
              aria-current={isCurrent(route, item.route) ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
          <OrganizationNav route={route} />
        </div>
        <div className="sidebar-bottom">
          {devMode && <DevClock />}
          <div className="sidebar-preferences" role="group" aria-label="设置与个性化">
            {PREFERENCES_NAV.map((item) => (
              <a key={item.label} className="nav-item" href={routeHash(item.route)} aria-current={isCurrent(route, item.route) ? 'page' : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </nav>
      <div className="sheet">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <span className="t-title">{TITLES[route.name]}</span>
          <Mark />
          <span style={{ width: 8 }} />
        </header>
        <main className="canvas">
          {route.name === 'home' && <HomeScreen onStart={startSession} />}
          {route.name === 'today' && <TodayScreen scope={route.scope} onStart={startSession} />}
          {route.name === 'learn' && <LearnScreen initial={session} onDone={() => setSession(null)} />}
          {route.name === 'map' && <MapScreen pointId={route.pointId} />}
          {route.name === 'topic' && <TopicScreen key={route.topicId} topicId={route.topicId} />}
          {route.name === 'topic-draft' && <TopicPlanningScreen key={route.draftId} draftId={route.draftId} />}
          {route.name === 'library' && <LibraryScreen cheatsheetId={route.cheatsheetId} />}
          {route.name === 'organization' && <OrganizationScreen disciplineId={route.disciplineId} courseId={route.courseId} unclassified={route.unclassified} />}
          {route.name === 'settings' && <SettingsScreen />}
          {route.name === 'personalization' && <PersonalizationScreen tab={route.tab} />}
        </main>
      </div>
      <UnsavedChangesDialog />
    </div>
  );
}

function isCurrent(route: Route, target: Route): boolean {
  if (target.name === 'today') return route.name === 'today' || route.name === 'learn';
  if (target.name === 'organization') return route.name === 'organization';
  return route.name === target.name;
}

const PLACEMENT_STATE: Record<string, string> = { pending: '待摸底', preparing: '准备摸底', testing: '摸底中' };

/**
 * 侧栏里的学习主题：按「学科 → 课程 → 主题」排，与首页、管理页用同一份组织快照，
 * 改名、移动课程后侧栏立即跟着变，不会停留在旧的推导结果上。
 */
function OrganizationNav({ route }: { route: Route }) {
  const { data, error, loading, reload } = useOrganization();
  if (loading && !data) return <p className="muted small sidebar-status">正在读取学习主题…</p>;
  if (error) return (
    <p className="error-text small sidebar-status" role="alert">
      没能读取学习主题：{error}{' '}
      <button type="button" className="card-link" onClick={() => void reload()}>重新加载</button>
    </p>
  );
  if (!data) return null;
  const hasAny = data.totals.topics > 0;
  if (!hasAny) return null;
  const stateOf = (topic: (typeof data.unclassified)[number]) => {
    if (topic.graphStatus === 'pending') return '生成中';
    if (topic.graphStatus === 'failed') return '生成失败';
    if (topic.status === 'paused') return '暂停';
    return PLACEMENT_STATE[topic.placementStatus ?? ''] ?? '';
  };
  const topicLink = (topic: (typeof data.unclassified)[number]) => (
    <a
      key={topic.id}
      className="nav-item"
      href={routeHash({ name: 'topic', topicId: topic.id })}
      aria-current={route.name === 'topic' && route.topicId === topic.id ? 'page' : undefined}
    >
      <Icon name="topic" />
      <span className="topic-name">{topic.title}</span>
      <span className="count">{stateOf(topic)}</span>
    </a>
  );
  return (
    <>
      {data.disciplines.map((node) => (
        <div key={node.discipline.id} className="nav-discipline">
          <div className="group-label">{node.discipline.name}</div>
          {node.courses.map((courseNode) => (
            <div key={courseNode.course.id} className="nav-course">
              <a
                className="nav-item nav-course-item"
                href={routeHash({ name: 'organization', courseId: courseNode.course.id })}
                aria-current={route.name === 'organization' && route.courseId === courseNode.course.id ? 'page' : undefined}
              >
                <Icon name="book" />
                <span className="topic-name">{courseNode.course.name}</span>
                <span className="count">{courseNode.counts.topics}</span>
              </a>
              {courseNode.topics.map(topicLink)}
            </div>
          ))}
        </div>
      ))}
      {data.unclassified.length > 0 && (
        <div className="nav-discipline">
          <div className="group-label">未归类</div>
          {data.unclassified.map(topicLink)}
        </div>
      )}
      {data.orphanTopics.length > 0 && (
        <div className="nav-discipline">
          <div className="group-label">待整理</div>
          {data.orphanTopics.map(topicLink)}
        </div>
      )}
    </>
  );
}

/** 开发模式：模拟当前时间，用于验收"第二天"的复习安排 */
function DevClock() {
  const [value, setValue] = useState(devNow.get());
  return (
    <div className="field" style={{ padding: '0 8px' }}>
      <label className="small muted" htmlFor="dev-now">
        模拟时间（开发模式）
      </label>
      <input
        id="dev-now"
        className="input"
        type="datetime-local"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          devNow.set(e.target.value);
        }}
      />
      {value && (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setValue('');
            devNow.set('');
          }}
        >
          恢复真实时间
        </button>
      )}
    </div>
  );
}
