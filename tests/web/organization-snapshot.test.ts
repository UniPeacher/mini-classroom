import { describe, expect, it } from 'vitest';
import type { Organization } from '../../src/web/api';
import { buildSnapshot, coursePath, scopeLabel } from '../../src/web/organization';

const organization: Organization = {
  migrationReport: null,
  disciplines: [
    { id: 'd1', name: '理工科', presetId: 'stem' },
    { id: 'd2', name: '语言', presetId: 'language' },
  ],
  courses: [
    { id: 'c1', name: '液压传动', disciplineId: 'd1', counts: { topics: 2, learned: 5, due: 1 } },
    { id: 'c2', name: '数字信号处理', disciplineId: 'd1', counts: { topics: 1, learned: 2, due: 0 } },
    { id: 'c3', name: '西班牙语', disciplineId: 'd2', counts: { topics: 1 } },
  ],
  topics: [
    { id: 't1', title: '两级先导式比例阀', courseId: 'c1' },
    { id: 't2', title: '核心物理规律', courseId: 'c1' },
    { id: 't3', title: '离散时间信号', courseId: 'c2' },
    { id: 't4', title: '规则动词现在时', courseId: 'c3' },
    { id: 't5', title: '还没归类的主题', courseId: null },
    { id: 't6', title: '指向不存在的课程', courseId: 'gone' },
  ],
};

/** 首页、侧栏、管理页共用同一份快照：归类、计数、未归类和异常数据都要有确定位置 */
describe('组织快照推导', () => {
  it('按学科 → 课程 → 主题组织，并带上每层计数', () => {
    const snapshot = buildSnapshot(organization);
    expect(snapshot.disciplines.map((node) => node.discipline.name)).toEqual(['理工科', '语言']);
    expect(snapshot.disciplines[0]!.courses.map((node) => node.course.name)).toEqual(['液压传动', '数字信号处理']);
    expect(snapshot.disciplines[0]!.courses[0]!.topics.map((topic) => topic.id)).toEqual(['t1', 't2']);
    expect(snapshot.disciplines[0]!.courses[0]!.counts).toEqual({ topics: 2, learned: 5, due: 1 });
    expect(snapshot.disciplines[0]!.counts.topics).toBe(3);
    expect(snapshot.totals.topics).toBe(6);
    expect(snapshot.allCoursesCount).toBe(3);
  });

  it('未归类和指向已删除课程的主题单独列出，不被藏起来', () => {
    const snapshot = buildSnapshot(organization);
    expect(snapshot.unclassified.map((topic) => topic.id)).toEqual(['t5']);
    expect(snapshot.orphanTopics.map((topic) => topic.id)).toEqual(['t6']);
    // 全部主题仍可通过 id 定位，侧栏和主题页不会丢掉它们
    expect([...snapshot.topicById.keys()].sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(snapshot.allTopics).toHaveLength(6);
  });

  it('后端单独给出未归类主题时同样并入', () => {
    const snapshot = buildSnapshot({ ...organization, topics: organization.topics.filter((topic) => topic.courseId), unclassifiedTopics: [{ id: 't5', title: '还没归类的主题', courseId: null }] });
    expect(snapshot.unclassified.map((topic) => topic.id)).toEqual(['t5']);
  });

  it('课程没给计数时至少用主题数兜底，不编造学习进度', () => {
    const snapshot = buildSnapshot({ ...organization, courses: [{ id: 'c9', name: '新课', disciplineId: 'd1' }], topics: [{ id: 't9', title: '主题', courseId: 'c9' }] });
    const counts = snapshot.disciplines[0]!.courses[0]!.counts;
    expect(counts.topics).toBe(1);
    expect(counts.learned).toBeUndefined();
  });

  it('课程与范围标签用同一套命名', () => {
    const snapshot = buildSnapshot(organization);
    expect(coursePath(snapshot, 'c1')).toBe('理工科 / 液压传动');
    expect(coursePath(snapshot, null)).toBe('未归类');
    expect(coursePath(snapshot, 'gone')).toBe('待整理');
    expect(scopeLabel(snapshot, { kind: 'all' })).toBe('全部范围');
    expect(scopeLabel(snapshot, { kind: 'discipline', id: 'd1' })).toBe('理工科');
    expect(scopeLabel(snapshot, { kind: 'course', id: 'c1' })).toBe('理工科 / 液压传动');
    // 旧课堂保存的名称优先，之后改名也不改历史显示
    expect(scopeLabel(snapshot, { kind: 'course', id: 'c1', label: '旧范围名' })).toBe('旧范围名');
    expect(scopeLabel(snapshot, null)).toBe('旧版范围');
  });
});
