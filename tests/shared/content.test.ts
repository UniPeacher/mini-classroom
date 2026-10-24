import { describe, expect, it } from 'vitest';
import { GradeSchema, GraphSchema, type IllustrationRequest, McqSchema, ShortAnswerSchema, figureProblem, lessonSchema } from '../../src/shared/content';
import { ILLUSTRATION, LESSON_DIAGRAM, MCQ } from '../fixtures/fake-model';

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
    material: null,
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

  it('题干提到"下面的代码"却没给出代码时不通过，促使模型重新生成', () => {
    expect(McqSchema.safeParse({ ...mcq, stem: '下面代码执行后，控制台输出什么？' }).success).toBe(false);
    expect(McqSchema.safeParse({ ...mcq, stem: '以下情境中应该怎么做？', material: '   ' }).success).toBe(false);
  });

  it('材料放在 material 里，或以代码块写在题干里，都通过', () => {
    expect(McqSchema.safeParse({ ...mcq, stem: '下面代码执行后，控制台输出什么？', material: '```js\nconsole.log(1)\n```' }).success).toBe(true);
    expect(McqSchema.safeParse({ ...mcq, stem: '下面代码输出什么？\n```js\nconsole.log(1)\n```' }).success).toBe(true);
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

describe('简答题结构校验', () => {
  const short = { type: 'short_answer' as const, prompt: '解释一下', material: null, referenceAnswer: '答', keyPoints: ['要点'] };

  it('题目提到"这段代码"却没给出时不通过', () => {
    expect(ShortAnswerSchema.safeParse({ ...short, prompt: '说说这段代码为什么报错' }).success).toBe(false);
    expect(ShortAnswerSchema.safeParse({ ...short, prompt: '说说这段代码为什么报错', material: '```ts\nlet x: string = 1\n```' }).success).toBe(true);
  });
});

describe('讲解配图校验：每节 1~2 张图，插画的引用与描述一一对应', () => {
  const svg = '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>\n```';
  const ref = (key: string) => `![说明](illustration:${key})`;
  const drawing = (patch: Partial<IllustrationRequest> = {}): IllustrationRequest => ({ ...ILLUSTRATION, ...patch });

  it('一张代码画的图、两张不同形式的图都合格', () => {
    expect(figureProblem([`正文\n\n${LESSON_DIAGRAM}`], [])).toBeNull();
    expect(figureProblem([`正文\n\n${svg}`], [])).toBeNull();
    expect(figureProblem([`正文\n\n${LESSON_DIAGRAM}\n\n${ref('a')}`], [drawing({ key: 'a' })])).toBeNull();
  });

  it('没有图、超过两张图都不合格', () => {
    expect(figureProblem(['只有文字'], [])).toContain('1~2 张图');
    expect(figureProblem([`${LESSON_DIAGRAM}\n${svg}\n${LESSON_DIAGRAM}`], [])).toContain('现在有 3 张');
    expect(figureProblem([`${LESSON_DIAGRAM}\n${svg}\n${ref('a')}`], [drawing({ key: 'a' })])).toContain('现在有 3 张');
  });

  it('分步揭示里的图也算数', () => {
    expect(figureProblem(['开场', '第一步', `第二步\n${svg}`], [])).toBeNull();
    expect(figureProblem(['开场', `第一步 ${ref('a')}`], [drawing({ key: 'a' })])).toBeNull();
  });

  it('插画必须在正文中恰好引用一次，正文引用的插画必须有描述', () => {
    expect(figureProblem(['没有引用'], [drawing({ key: 'a' })])).toContain('恰好引用一次');
    expect(figureProblem([`${ref('a')}\n${ref('a')}`], [drawing({ key: 'a' })])).toContain('恰好引用一次');
    expect(figureProblem([`${ref('a')}\n${LESSON_DIAGRAM}\n${ref('b')}`], [drawing({ key: 'a' })])).toContain('没有它');
    expect(figureProblem([`${ref('a')}`], [drawing({ key: 'a' }), drawing({ key: 'a' })])).toContain('不能重复');
  });

  it('完整绘图说明可组合教学作用、颜色与标注，只需引用标识和提示词', () => {
    const illustration = { key: 'a', prompt: ILLUSTRATION.prompt };
    const parsed = lessonSchema('explain_direct', 'mcq', { illustrations: true }).safeParse({
      explanation: `正文\n\n${ref('a')}`, check: MCQ, estSeconds: 120, illustrations: [illustration],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.illustrations).toEqual([illustration]);
  });

  it.each([undefined, '', ' \n\t '])('绘图说明缺失或空白时不合格：%s', (prompt) => {
    const parsed = lessonSchema('explain_direct', 'mcq', { illustrations: true }).safeParse({
      explanation: `正文\n\n${ref('a')}`, check: MCQ, estSeconds: 120, illustrations: [{ key: 'a', prompt }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'illustrations.0.prompt')).toBe(true);
  });

  it('讲解结构：没开启插画时，正文引用插画也不合格；开启后要写 illustrations', () => {
    const lesson = { explanation: `正文\n\n${ref('a')}`, check: MCQ, estSeconds: 120 };
    expect(lessonSchema('explain_direct', 'mcq').safeParse(lesson).success).toBe(false);
    expect(lessonSchema('explain_direct', 'mcq').safeParse({ ...lesson, explanation: `正文\n\n${LESSON_DIAGRAM}` }).success).toBe(true);
    const withIllustrations = lessonSchema('explain_direct', 'mcq', { illustrations: true });
    expect(withIllustrations.safeParse(lesson).success).toBe(false);
    expect(withIllustrations.safeParse({ ...lesson, illustrations: [drawing({ key: 'a' })] }).success).toBe(true);
    expect(withIllustrations.safeParse({ ...lesson, explanation: `正文\n\n${LESSON_DIAGRAM}`, illustrations: [] }).success).toBe(true);
  });

  it('分步揭示的步数要求不变', () => {
    const lesson = { explanation: `开场\n${LESSON_DIAGRAM}`, check: MCQ, estSeconds: 120 };
    expect(lessonSchema('explain_steps', 'mcq').safeParse({ ...lesson, steps: ['一', '二'] }).success).toBe(false);
    expect(lessonSchema('explain_steps', 'mcq').safeParse({ ...lesson, steps: ['一', '二', '三'] }).success).toBe(true);
  });
});
