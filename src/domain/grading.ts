import type { Grade, Mcq } from '../shared/content';

/** 选择题按规则判分：选中带误解标注的干扰项视为误解，否则视为遗忘。 */
export function gradeMcq(question: Mcq, chosenIndex: number): Grade {
  if (chosenIndex === question.answerIndex) return { correct: true, errorType: null, feedback: question.explanation };
  const misconception = question.options[chosenIndex]?.misconception ?? null;
  return {
    correct: false,
    errorType: misconception ? 'misconception' : 'forgetting',
    feedback: misconception ? `这个选项反映的误解是：${misconception}\n\n${question.explanation}` : question.explanation,
  };
}
