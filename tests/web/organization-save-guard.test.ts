import { describe, expect, it, vi } from 'vitest';
import { type OrganizationImpact, combineImpacts } from '../../src/web/api';
import { decideTeachingSave, needsImpactConfirm } from '../../src/web/screens/OrganizationScreen';

const zero: OrganizationImpact = { affectedCourses: 0, affectedTopics: 0, affectedItems: 0, modelCalls: false };
const pooled: OrganizationImpact = { affectedCourses: 1, affectedTopics: 2, affectedItems: 5, modelCalls: true };

/**
 * 教学变更（换预设 / 移动课程 / 归类主题）必须先读到影响：
 * 读不到就停下，不能把"不知道"当成"没有影响"直接保存。
 */
describe('教学变更的保存前判断', () => {
  it('影响统计失败时不产生任何保存动作', async () => {
    const apply = vi.fn(async () => {});
    const impact = vi.fn(async () => { throw new Error('影响统计服务不可用'); });
    await expect(decideTeachingSave({ kind: 'teaching', apply, impact })).rejects.toThrow('影响统计服务不可用');
    expect(impact).toHaveBeenCalledTimes(1);
    // 关键：没有调用保存，草稿保持未保存状态
    expect(apply).not.toHaveBeenCalled();
  });

  it('影响为零时直接保存，不弹确认', async () => {
    const decision = await decideTeachingSave({ kind: 'teaching', apply: async () => {}, impact: async () => zero });
    expect(decision.action).toBe('save');
    expect(needsImpactConfirm(zero)).toBe(false);
  });

  it('存在待重备内容时必须先确认，不在判断阶段保存', async () => {
    const apply = vi.fn(async () => {});
    const decision = await decideTeachingSave({ kind: 'teaching', apply, impact: async () => pooled });
    expect(decision.action).toBe('confirm');
    if (decision.action === 'confirm') expect(decision.impact.affectedItems).toBe(5);
    expect(apply).not.toHaveBeenCalled();
  });

  it('确认条件只看待学内容与可能的模型调用', () => {
    expect(needsImpactConfirm({ ...zero, affectedCourses: 9, affectedTopics: 40 })).toBe(false);
    expect(needsImpactConfirm({ affectedCourses: 0, affectedTopics: 1, affectedItems: 0, modelCalls: true })).toBe(true);
    expect(needsImpactConfirm({ affectedCourses: 0, affectedTopics: 1, affectedItems: 1, modelCalls: false })).toBe(true);
  });
});

/**
 * 移出课程同样会改变教学配置（课程预设 → 默认），
 * 所以"只移除"不能当作零影响直接保存。
 */
describe('归类变更的影响合并', () => {
  it('没有课程明细时课程数保守相加，绝不因取最大值而少报', () => {
    const added = { affectedCourses: 1, affectedTopics: 2, affectedItems: 3, modelCalls: true };
    const removed = { affectedCourses: 2, affectedTopics: 1, affectedItems: 2, modelCalls: true };
    expect(combineImpacts([added, removed])).toEqual({
      kind: undefined,
      affectedCourses: 3,
      affectedTopics: 3,
      affectedItems: 5,
      modelCalls: true,
    });
  });

  it('后端给出课程明细时按 id 求并集，得到准确课程数', () => {
    const added = {
      affectedCourses: 2,
      affectedTopics: 2,
      affectedItems: 3,
      modelCalls: true,
      courseDetails: [{ id: 'c1', name: '液压传动' }, { id: 'c2', name: '数字信号处理' }],
    };
    const removed = {
      affectedCourses: 2,
      affectedTopics: 1,
      affectedItems: 2,
      modelCalls: true,
      // c1 同时出现在两次请求里，只能算一门
      courseDetails: [{ id: 'c1', name: '液压传动' }, { id: 'c3', name: '西班牙语' }],
    };
    const merged = combineImpacts([added, removed]);
    expect(merged.affectedCourses).toBe(3);
    expect(merged.affectedTopics).toBe(3);
    expect(merged.affectedItems).toBe(5);
  });

  it('只有移出时也以移出的影响为准，不移除零影响', () => {
    const removedOnly = combineImpacts([{ affectedCourses: 1, affectedTopics: 4, affectedItems: 6, modelCalls: true }]);
    expect(removedOnly.affectedItems).toBe(6);
    expect(needsImpactConfirm(removedOnly)).toBe(true);
  });

  it('空合并结果不触发确认', () => {
    expect(needsImpactConfirm(combineImpacts([]))).toBe(false);
  });

  it('任一影响请求失败时整体不成立，由调用方放弃保存', async () => {
    const apply = vi.fn(async () => {});
    const impact = vi.fn(async () => { throw new Error('影响统计服务不可用'); });
    await expect(decideTeachingSave({ kind: 'teaching', apply, impact })).rejects.toThrow('影响统计服务不可用');
    expect(apply).not.toHaveBeenCalled();
  });
});
