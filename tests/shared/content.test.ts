import { describe, expect, it } from 'vitest';
import { GradeSchema, GraphSchema, McqSchema } from '../../src/shared/content';

const points = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `kp-${i}`, title: `知识点 ${i}`, summary: '要掌握的内容' }));

describe('知识图谱结构校验', () => {
  it('合法图谱通过', () => {
    const graph = { knowledgePoints: points(15), relations: [{ from: 'kp-0', to: 'kp-1', type: 'prerequisite' as const }] };
    expect(GraphSchema.safeParse(graph).success).toBe(true);
  });

  it('知识点少于 15 个时不通过', () => {
    expect(GraphSchema.safeParse({ knowledgePoints: points(14), relations: [] }).success).toBe(false);
  });

  it('关系引用不存在的知识点时不通过', () => {
    const graph = { knowledgePoints: points(15), relations: [{ from: 'kp-0', to: 'missing', type: 'prerequisite' as const }] };
    expect(GraphSchema.safeParse(graph).success).toBe(false);
  });

  it('前置关系有环时不通过，否则环上的知识点永远学不到', () => {
    const graph = {
      knowledgePoints: points(15),
      relations: [
        { from: 'kp-0', to: 'kp-1', type: 'prerequisite' as const },
        { from: 'kp-1', to: 'kp-2', type: 'prerequisite' as const },
        { from: 'kp-2', to: 'kp-0', type: 'prerequisite' as const },
      ],
    };
    expect(GraphSchema.safeParse(graph).success).toBe(false);
  });

  it('易混关系互相指向不算环', () => {
    const graph = {
      knowledgePoints: points(15),
      relations: [
        { from: 'kp-0', to: 'kp-1', type: 'confusable' as const },
        { from: 'kp-1', to: 'kp-0', type: 'confusable' as const },
      ],
    };
    expect(GraphSchema.safeParse(graph).success).toBe(true);
  });
});

describe('选择题结构校验', () => {
  const mcq = {
    type: 'mcq' as const,
    stem: '题干',
    options: [
      { text: 'A', misconception: '误解 A' },
      { text: 'B', misconception: null },
      { text: 'C', misconception: '误解 C' },
    ],
    answerIndex: 1,
    explanation: '解析',
  };

  it('合法选择题通过', () => {
    expect(McqSchema.safeParse(mcq).success).toBe(true);
  });

  it('正确选项标注了误解时不通过', () => {
    expect(McqSchema.safeParse({ ...mcq, answerIndex: 0 }).success).toBe(false);
  });

  it('正确答案序号越界时不通过', () => {
    expect(McqSchema.safeParse({ ...mcq, answerIndex: 3 }).success).toBe(false);
  });
});

describe('批改结果结构校验', () => {
  it('答错时必须给出错误类型', () => {
    expect(GradeSchema.safeParse({ correct: false, errorType: null, feedback: '...' }).success).toBe(false);
  });

  it('答对时不应有错误类型', () => {
    expect(GradeSchema.safeParse({ correct: true, errorType: 'forgetting', feedback: '...' }).success).toBe(false);
  });
});
