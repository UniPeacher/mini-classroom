/** 理解阶段的讲解形式（切片 1 只有文字类讲解） */
export const EXPLAIN_FORMS = ['explain_direct', 'explain_analogy', 'explain_counterexample'] as const;
/** 检验形式 */
export const QUESTION_FORMS = ['mcq', 'short_answer'] as const;

export type ExplainForm = (typeof EXPLAIN_FORMS)[number];
export type QuestionForm = (typeof QUESTION_FORMS)[number];

/** 按固定顺序轮换，返回与上次不同的下一种形式；没有上次记录时取第一种。 */
export function nextForm<F extends string>(forms: readonly F[], last: string | null): F {
  const index = last === null ? -1 : forms.indexOf(last as F);
  return forms[(index + 1) % forms.length]!;
}
