import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { type Course, type CourseCounts, type Discipline, type Organization, type OrganizationTopic, type PresetId, type SettingsView, type TeachingPreset, api } from './api';
import { useResource } from './hooks';
import { SUBJECT_STYLE_INFO, SUBJECT_STYLES } from '../shared/subject-styles';

/** 一门课程及挂在它下面的学习主题 */
export interface CourseNode {
  course: Course;
  topics: OrganizationTopic[];
  counts: CourseCounts;
}

/** 一个学科大类及其课程；专题列表保持后端给的顺序（按创建时间） */
export interface DisciplineNode {
  discipline: Discipline;
  courses: CourseNode[];
  counts: CourseCounts;
}

export interface OrganizationSnapshot {
  disciplines: DisciplineNode[];
  /** 没有归入课程的学习主题 */
  unclassified: OrganizationTopic[];
  /** 找不到大类或课程的主题，仍要能访问，不能藏起来 */
  orphanTopics: OrganizationTopic[];
  /** 全部主题（含未归类与待整理） */
  allTopics: OrganizationTopic[];
  /** 课程总数，判断是否已有可选的学科/课程结构 */
  allCoursesCount: number;
  totals: CourseCounts;
  migrationReport: Organization['migrationReport'];
  courseById: Map<string, Course>;
  disciplineById: Map<string, Discipline>;
  topicById: Map<string, OrganizationTopic>;
}

const EMPTY_COUNTS: CourseCounts = { topics: 0 };

function addCounts(a: CourseCounts, b: CourseCounts): CourseCounts {
  return {
    topics: a.topics + b.topics,
    points: (a.points ?? 0) + (b.points ?? 0),
    learned: (a.learned ?? 0) + (b.learned ?? 0),
    due: (a.due ?? 0) + (b.due ?? 0),
    edge: (a.edge ?? 0) + (b.edge ?? 0),
    excluded: (a.excluded ?? 0) + (b.excluded ?? 0),
  };
}

/**
 * 从接口返回的原始组织数据推导界面结构。
 * 计数以后端为准；后端没给某门课的计数时，至少用主题数兜底，不显示假的学习进度。
 */
export function buildSnapshot(data: Organization): OrganizationSnapshot {
  const courseById = new Map(data.courses.map((course) => [course.id, course]));
  const disciplineById = new Map(data.disciplines.map((discipline) => [discipline.id, discipline]));
  // 有些后端把未归类主题放在单独字段，合并回同一份主题列表
  const allTopics = [...data.topics];
  for (const topic of data.unclassifiedTopics ?? []) {
    if (!allTopics.some((item) => item.id === topic.id)) allTopics.push({ ...topic, courseId: topic.courseId ?? null });
  }
  const topicById = new Map(allTopics.map((topic) => [topic.id, topic]));
  const byCourse = new Map<string, OrganizationTopic[]>();
  const unclassified: OrganizationTopic[] = [];
  const orphanTopics: OrganizationTopic[] = [];
  for (const topic of allTopics) {
    if (!topic.courseId) {
      unclassified.push(topic);
      continue;
    }
    const course = courseById.get(topic.courseId);
    if (!course) {
      orphanTopics.push(topic);
      continue;
    }
    const list = byCourse.get(course.id) ?? [];
    list.push(topic);
    byCourse.set(course.id, list);
  }

  const disciplines = data.disciplines.map((discipline) => {
    const courses: CourseNode[] = data.courses
      .filter((course) => course.disciplineId === discipline.id)
      .map((course) => {
        const topics = byCourse.get(course.id) ?? [];
        return { course, topics, counts: course.counts ?? { topics: topics.length } };
      });
    const counts = courses.reduce((sum, node) => addCounts(sum, node.counts), { ...EMPTY_COUNTS });
    return { discipline, courses, counts };
  });

  // 课程指向了不存在的大类：放到待整理里，不静默丢弃
  for (const course of data.courses) {
    if (!disciplineById.has(course.disciplineId)) {
      orphanTopics.push(...(byCourse.get(course.id) ?? []));
    }
  }

  const totals = allTopics.reduce<CourseCounts>((sum, topic) => addCounts(sum, topic.counts ?? { topics: 1 }), { ...EMPTY_COUNTS });
  return { disciplines, unclassified, orphanTopics, totals, migrationReport: data.migrationReport, courseById, disciplineById, topicById, allTopics, allCoursesCount: data.courses.length };
}

/** 课程名 + 学科名，用于范围标签和提示 */
export function coursePath(snapshot: OrganizationSnapshot | null, courseId: string | null | undefined): string {
  if (!snapshot || !courseId) return '未归类';
  const course = snapshot.courseById.get(courseId);
  if (!course) return '待整理';
  const discipline = snapshot.disciplineById.get(course.disciplineId);
  return discipline ? `${discipline.name} / ${course.name}` : course.name;
}

/** 全部课程（含学科名），用于下拉选择 */
export function allCourses(snapshot: OrganizationSnapshot | null): { course: Course; disciplineName: string }[] {
  if (!snapshot) return [];
  return snapshot.disciplines.flatMap((node) => node.courses.map((courseNode) => ({ course: courseNode.course, disciplineName: node.discipline.name })));
}

/** 学习范围的可读名称；用于"继续上次课堂 · 原范围" */
export function scopeLabel(snapshot: OrganizationSnapshot | null, scope: { kind: 'all' | 'discipline' | 'course'; id?: string; label?: string } | null | undefined): string {
  if (!scope) return '旧版范围';
  if (scope.kind === 'all') return '全部范围';
  if (scope.label) return scope.label;
  if (!snapshot) return scope.kind === 'discipline' ? '学科' : '课程';
  if (scope.kind === 'discipline') return snapshot.disciplineById.get(scope.id ?? '')?.name ?? '学科已不存在';
  return coursePath(snapshot, scope.id);
}

/** 预设目录：优先用服务端下发的九套预设，后端还没提供时用同一份共享定义兜底 */
export function presetCatalog(view: SettingsView | null | undefined): TeachingPreset[] {
  if (view?.teachingPresets?.length) return view.teachingPresets;
  return SUBJECT_STYLES.map((id) => ({
    id,
    label: SUBJECT_STYLE_INFO[id].label,
    description: SUBJECT_STYLE_INFO[id].description,
    tutorial: SUBJECT_STYLE_INFO[id].tutorial ?? '',
    figure: SUBJECT_STYLE_INFO[id].figure ?? '',
  }));
}

export function presetLabel(presets: TeachingPreset[], id: PresetId): string {
  return presets.find((preset) => preset.id === id)?.label ?? id;
}

/** 主题状态的一句话说明，首页、管理页共用 */
export function topicStateText(topic: OrganizationTopic): string {
  if (topic.graphStatus === 'pending') return '正在生成知识图谱';
  if (topic.graphStatus === 'failed') return '图谱生成失败';
  if (topic.placementStatus === 'pending') return '先做摸底';
  if (topic.placementStatus === 'preparing') return '正在准备摸底';
  if (topic.placementStatus === 'testing') return '继续完成摸底';
  if (topic.status === 'paused') return '已暂停';
  return '查看知识点';
}

interface OrganizationContextValue {
  data: OrganizationSnapshot | null;
  error: string;
  loading: boolean;
  /** 重新读取；组织变更后由同一个入口刷新，侧栏和首页一起更新 */
  reload: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

/**
 * 全局只读取一份组织快照：首页、侧栏和管理页看到同一份归类与命名。
 * 任何组织变更后调用 reload，避免各处各自推导出过期结果。
 */
export function OrganizationProvider({ children }: { children: ReactNode }) {
  const resource = useResource(() => api.organization(), []);
  const value = useMemo<OrganizationContextValue>(() => ({
    data: resource.data ? buildSnapshot(resource.data) : null,
    error: resource.error,
    loading: resource.loading,
    reload: async () => {
      await resource.reload();
    },
  }), [resource.data, resource.error, resource.loading, resource.reload]);
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

const EMPTY_CONTEXT: OrganizationContextValue = { data: null, error: '', loading: true, reload: async () => {} };

export function useOrganization(): OrganizationContextValue {
  // 允许在独立渲染（测试、静态预览）时没有 Provider：退化为空快照，组件仍能安全显示加载/空状态
  return useContext(OrganizationContext) ?? EMPTY_CONTEXT;
}
