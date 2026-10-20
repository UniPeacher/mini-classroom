import { z } from 'zod';

// 说明：为兼容各家模型的严格 JSON Schema 模式，字段一律必填，可空字段用 nullable；
// 数量、取值范围等 JSON Schema 不一定支持的约束放在 refine 里，由校验失败触发重试。

/** 选择题：每个错误选项标注它代表的误解，用于区分"误解"和"遗忘" */
export const McqSchema = z
  .object({
    type: z.literal('mcq'),
    stem: z.string(),
    options: z.array(z.object({ text: z.string(), misconception: z.string().nullable() })),
    answerIndex: z.number().int(),
    explanation: z.string(),
  })
  .refine((q) => q.options.length >= 3 && q.options.length <= 5, '选项数量应为 3~5 个')
  .refine((q) => q.answerIndex >= 0 && q.answerIndex < q.options.length, '正确答案序号越界')
  .refine((q) => q.options[q.answerIndex]?.misconception === null, '正确选项不应标注误解');

/** 简答题：参考答案只作对照，不是唯一标准 */
export const ShortAnswerSchema = z
  .object({
    type: z.literal('short_answer'),
    prompt: z.string(),
    referenceAnswer: z.string(),
    keyPoints: z.array(z.string()),
  })
  .refine((q) => q.keyPoints.length >= 1 && q.keyPoints.length <= 5, '要点数量应为 1~5 个');

export type Mcq = z.infer<typeof McqSchema>;
export type ShortAnswer = z.infer<typeof ShortAnswerSchema>;
export type Question = Mcq | ShortAnswer;

const EstSecondsSchema = z
  .number()
  .int()
  .refine((s) => s >= 20 && s <= 600, '预估时长应在 20~600 秒之间');

/** 讲解 + 当场小题 */
export function lessonSchema(questionForm: Question['type']) {
  return z.object({
    explanation: z.string(),
    check: questionForm === 'mcq' ? McqSchema : ShortAnswerSchema,
    estSeconds: EstSecondsSchema,
  });
}

/** 复习题 */
export function reviewSchema(questionForm: Question['type']) {
  return z.object({
    question: questionForm === 'mcq' ? McqSchema : ShortAnswerSchema,
    estSeconds: EstSecondsSchema,
  });
}

export interface LessonContent {
  explanation: string;
  check: Question;
}

export interface ReviewContent {
  question: Question;
}

/** 简答批改结果 */
export const GradeSchema = z
  .object({
    correct: z.boolean(),
    errorType: z.enum(['misconception', 'forgetting']).nullable(),
    feedback: z.string(),
  })
  .refine((g) => (g.correct ? g.errorType === null : g.errorType !== null), '答对时不应有错误类型，答错时必须给出错误类型');

export type Grade = z.infer<typeof GradeSchema>;

const RelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(['composition', 'prerequisite', 'confusable']),
});

type Relation = z.infer<typeof RelationSchema>;

/** 骨架知识图谱：知识点用临时 key 互相引用 */
export const GraphSchema = z
  .object({
    knowledgePoints: z.array(z.object({ key: z.string(), title: z.string(), summary: z.string() })),
    relations: z.array(RelationSchema),
  })
  .refine((g) => g.knowledgePoints.length >= 15 && g.knowledgePoints.length <= 30, '知识点数量应为 15~30 个')
  .refine((g) => new Set(g.knowledgePoints.map((k) => k.key)).size === g.knowledgePoints.length, '知识点 key 重复')
  .refine((g) => {
    const keys = new Set(g.knowledgePoints.map((k) => k.key));
    return g.relations.every((r) => keys.has(r.from) && keys.has(r.to) && r.from !== r.to);
  }, '关系引用了不存在的知识点，或指向自身')
  .refine((g) => !hasPrerequisiteCycle(g.relations), '前置关系存在环');

export type Graph = z.infer<typeof GraphSchema>;

/** 前置关系有环时，环上的知识点永远进不了认知边缘 */
function hasPrerequisiteCycle(relations: Relation[]): boolean {
  const next = new Map<string, string[]>();
  for (const r of relations.filter((r) => r.type === 'prerequisite')) {
    next.set(r.from, [...(next.get(r.from) ?? []), r.to]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string): boolean => {
    if (done.has(key)) return false;
    if (visiting.has(key)) return true;
    visiting.add(key);
    const cyclic = (next.get(key) ?? []).some(visit);
    visiting.delete(key);
    done.add(key);
    return cyclic;
  };
  return [...next.keys()].some(visit);
}
