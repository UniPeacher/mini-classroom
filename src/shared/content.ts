import { z } from 'zod';
import type { ExplainForm, QuestionForm } from '../domain/forms';

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

/** 点选错误行：一段代码或一串推理步骤，其中恰好一行有错 */
export const PickLineSchema = z
  .object({
    type: z.literal('pick_line'),
    prompt: z.string(),
    /** 代码语言，如 "ts"；不是代码时为 null */
    language: z.string().nullable(),
    lines: z.array(z.string()),
    answerIndex: z.number().int(),
    explanation: z.string(),
  })
  .refine((q) => q.lines.length >= 4 && q.lines.length <= 14, '行数应为 4~14 行')
  .refine((q) => q.answerIndex >= 0 && q.answerIndex < q.lines.length, '错误行序号越界');

/** 补全：在模板的空缺处（____）写出缺少的部分 */
export const CompleteSchema = z
  .object({
    type: z.literal('complete'),
    prompt: z.string(),
    language: z.string().nullable(),
    template: z.string(),
    referenceAnswer: z.string(),
    keyPoints: z.array(z.string()),
  })
  .refine((q) => q.template.includes('____'), '模板中应有空缺 ____')
  .refine((q) => q.keyPoints.length >= 1 && q.keyPoints.length <= 5, '要点数量应为 1~5 个');

/** 修正：给出有问题的代码或做法，写出修正后的版本 */
export const FixSchema = z
  .object({
    type: z.literal('fix'),
    prompt: z.string(),
    language: z.string().nullable(),
    flawed: z.string(),
    referenceAnswer: z.string(),
    keyPoints: z.array(z.string()),
  })
  .refine((q) => q.keyPoints.length >= 1 && q.keyPoints.length <= 5, '要点数量应为 1~5 个');

export type Mcq = z.infer<typeof McqSchema>;
export type ShortAnswer = z.infer<typeof ShortAnswerSchema>;
export type PickLine = z.infer<typeof PickLineSchema>;
export type Complete = z.infer<typeof CompleteSchema>;
export type Fix = z.infer<typeof FixSchema>;
export type Question = Mcq | ShortAnswer | PickLine | Complete | Fix;
/** 由 AI 批改的开放题 */
export type OpenQuestion = ShortAnswer | Complete | Fix;

export function questionSchema(form: QuestionForm): z.ZodType<Question> {
  const schemas = { mcq: McqSchema, short_answer: ShortAnswerSchema, pick_line: PickLineSchema, complete: CompleteSchema, fix: FixSchema };
  return schemas[form];
}

export function isOpenQuestion(question: Question): question is OpenQuestion {
  return question.type === 'short_answer' || question.type === 'complete' || question.type === 'fix';
}

const EstSecondsSchema = z
  .number()
  .int()
  .refine((s) => s >= 20 && s <= 600, '预估时长应在 20~600 秒之间');

/** 预测揭晓：先给情境让学习者预测，再揭晓；预测不计分 */
const PredictSchema = z
  .object({
    scenario: z.string(),
    options: z.array(z.string()),
    answerIndex: z.number().int(),
    reveal: z.string(),
  })
  .refine((p) => p.options.length >= 2 && p.options.length <= 4, '预测选项应为 2~4 个')
  .refine((p) => p.answerIndex >= 0 && p.answerIndex < p.options.length, '预测答案序号越界');

export type Predict = z.infer<typeof PredictSchema>;

/** 讲解 + 当场小题。分步揭示多出 steps，预测揭晓多出 predict */
export function lessonSchema(explainForm: ExplainForm, questionForm: QuestionForm): z.ZodType<LessonContent & { estSeconds: number }> {
  const base = { explanation: z.string(), check: questionSchema(questionForm), estSeconds: EstSecondsSchema };
  if (explainForm === 'explain_steps') {
    return z
      .object({ ...base, steps: z.array(z.string()) })
      .refine((l) => l.steps.length >= 3 && l.steps.length <= 6, '分步揭示应有 3~6 步');
  }
  if (explainForm === 'explain_predict') return z.object({ ...base, predict: PredictSchema });
  return z.object(base);
}

/** 复习题 */
export function reviewSchema(questionForm: QuestionForm): z.ZodType<ReviewContent & { estSeconds: number }> {
  return z.object({ question: questionSchema(questionForm), estSeconds: EstSecondsSchema });
}

export interface LessonContent {
  explanation: string;
  check: Question;
  steps?: string[];
  predict?: Predict;
}

export interface ReviewContent {
  question: Question;
}

/** 联结练习：说明两个知识之间的关系，题目由代码按模板生成，不调用 AI */
export interface ConnectionContent {
  prompt: string;
  partner: { kind: 'point' | 'existing'; id: string; title: string };
}

/** 批改结果 */
export const GradeSchema = z
  .object({
    correct: z.boolean(),
    errorType: z.enum(['misconception', 'forgetting']).nullable(),
    feedback: z.string(),
  })
  .refine((g) => (g.correct ? g.errorType === null : g.errorType !== null), '答对时不应有错误类型，答错时必须给出错误类型');

export type Grade = z.infer<typeof GradeSchema>;

/** 联结练习的批改：认可时成为认知地图上的一条联结 */
export const ConnectionGradeSchema = z.object({
  accepted: z.boolean(),
  /** 用一句话概括两者的关系，认可时显示在联结旁 */
  relation: z.string(),
  feedback: z.string(),
});

export type ConnectionGrade = z.infer<typeof ConnectionGradeSchema>;

/**
 * 申诉的重新判定：
 * accepted 学习者的答案也成立，改判为答对；void 题目或参考答案本身有误，作废；rejected 维持原判。
 */
export const AppealVerdictSchema = z.object({
  outcome: z.enum(['accepted', 'void', 'rejected']),
  feedback: z.string(),
});

export type AppealVerdict = z.infer<typeof AppealVerdictSchema>;

/** 拆解：为反复失败的知识点生成更基础的前置知识点 */
export const DecompositionSchema = z
  .object({ knowledgePoints: z.array(z.object({ title: z.string(), summary: z.string() })) })
  .refine((d) => d.knowledgePoints.length >= 1 && d.knowledgePoints.length <= 3, '应拆出 1~3 个前置知识点');

export type Decomposition = z.infer<typeof DecompositionSchema>;

/** 摸底诊断的准备：已有知识、推断的起点，以及每个候选知识点的一道选择题 */
export function placementSchema(probeIds: string[]) {
  return z
    .object({
      existingKnowledge: z.array(z.string()),
      likelyKnownIds: z.array(z.string()),
      probes: z.array(z.object({ pointId: z.string(), question: McqSchema })),
    })
    .refine((p) => p.existingKnowledge.length <= 8, '已有知识最多 8 条')
    .refine((p) => p.likelyKnownIds.every((id) => probeIds.includes(id)), '起点只能从候选知识点中选')
    .refine((p) => probeIds.every((id) => p.probes.some((probe) => probe.pointId === id)), '每个候选知识点都要有一道题');
}

export type PlacementPlan = z.infer<ReturnType<typeof placementSchema>>;

/** 速查表 */
export const CheatsheetSchema = z.object({ markdown: z.string() });

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
