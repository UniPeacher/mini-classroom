import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OrganizationSnapshot } from '../../src/web/organization';
import { buildSnapshot } from '../../src/web/organization';
import { AllOverview, Counts, DisciplineDetail, OrganizationTree } from '../../src/web/screens/OrganizationScreen';

const presets = [
  { id: 'default', label: '通用', description: '通用讲法', tutorial: '', figure: '' },
  { id: 'stem', label: '理工科', description: '重推导', tutorial: '## 要求', figure: '- 结构图' },
];

const snapshot = (): OrganizationSnapshot => buildSnapshot({
  migrationReport: null,
  disciplines: [{ id: 'd1', name: '理工科', presetId: 'stem' }],
  courses: [
    { id: 'c1', name: '液压传动', disciplineId: 'd1', counts: { topics: 1, learned: 3, due: 2, edge: 1 } },
    { id: 'c2', name: '数字信号处理', disciplineId: 'd1', counts: { topics: 0 } },
  ],
  topics: [
    { id: 't1', title: '两级先导式比例阀', courseId: 'c1' },
    { id: 't2', title: '未归类主题', courseId: null },
  ],
});

/** 管理页左侧结构：全部、未归类、学科与课程，能看出预设、计数与未保存草稿 */
describe('学科与课程结构树', () => {
  it('列出全部、未归类与学科下的课程，并标出每层数量', () => {
    const html = renderToStaticMarkup(createElement(OrganizationTree, {
      data: snapshot(), selection: { kind: 'all' }, presets, onSelect: () => {}, draftIds: new Set<string>(),
    }));
    for (const text of ['全部', '未归类', '理工科', '液压传动', '数字信号处理', '2 个主题']) expect(html).toContain(text);
    // 学科节点显示它实际使用的教学预设
    expect(html).toContain('>理工科<');
    expect(html).toContain('重推导'.slice(0, 0) + '理工科');
    expect(html).toContain('aria-label="学科与课程结构"');
  });

  it('有未保存草稿的对象带标记，切换对象时能看出哪里还没保存', () => {
    const html = renderToStaticMarkup(createElement(OrganizationTree, {
      data: snapshot(), selection: { kind: 'course', id: 'c1' }, presets, onSelect: () => {}, draftIds: new Set<string>(['course:c1']),
    }));
    expect(html).toContain('has-draft');
  });

  it('课程与主题计数来自同一份快照，不与学科自己的数字打架', () => {
    const data = snapshot();
    expect(data.disciplines[0]!.counts.topics).toBe(1);
    expect(data.unclassified).toHaveLength(1);
    expect(data.allCoursesCount).toBe(2);
  });
});

describe('学科与课程详情计数', () => {
  it('展示主题、已学会、到期等计数；后端缺失的进度不编造数字', () => {
    const html = renderToStaticMarkup(createElement(Counts, { counts: { topics: 3, learned: 5, due: 2, edge: 1 } }));
    expect(html).toContain('学习主题');
    expect(html).toContain('已学会');
    expect(html).toContain('今天到期');
    expect(html).toContain('下一步可学');

    const sparse = renderToStaticMarkup(createElement(Counts, { counts: { topics: 2 } }));
    expect(sparse).toContain('—');
  });

  it('全部视图先给出新建学科（九套预设）与新建课程的入口', () => {
    const html = renderToStaticMarkup(createElement(AllOverview, { data: snapshot(), presets }));
    expect(html).toContain('新建学科');
    expect(html).toContain('新建课程');
    expect(html).toContain('教学预设');
    expect(html).toContain('理工科');
    expect(html).toContain('通用');
    // 预设选择是显式动作，不在浏览时就保存
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('1 个主题');
    expect(html).toContain('共 2 个学习主题');
  });
});

/** 选中学科后要能直接建课程：不回"全部"重新选一次学科 */
describe('学科面板内的新建课程入口', () => {
  const data = snapshot();
  const discipline = data.disciplineById.get('d1')!;

  it('空课程的学科面板直接给出新建课程表单，学科已固定', () => {
    const empty = buildSnapshot({
      migrationReport: null,
      disciplines: [{ id: 'd2', name: '语言', presetId: 'language' }],
      courses: [],
      topics: [],
    });
    const html = renderToStaticMarkup(createElement(DisciplineDetail, {
      data: empty,
      discipline: empty.disciplineById.get('d2')!,
      draft: null,
      presets,
      saving: false,
      onEdit: () => {},
      onCancel: () => {},
      onChange: () => {},
      onSave: () => {},
      onSelectCourse: () => {},
      onDeleted: async () => {},
    }));
    expect(html).toContain('这个学科下还没有课程');
    expect(html).toContain('新课程名称');
    expect(html).toContain('创建课程');
    expect(html).toContain('会创建在「语言」下');
  });

  it('已有课程的学科折叠新建表单，但保留显式入口', () => {
    const html = renderToStaticMarkup(createElement(DisciplineDetail, {
      data,
      discipline,
      draft: null,
      presets,
      saving: false,
      onEdit: () => {},
      onCancel: () => {},
      onChange: () => {},
      onSave: () => {},
      onSelectCourse: () => {},
      onDeleted: async () => {},
    }));
    expect(html).toContain('新建课程');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('新课程名称');
  });
});
