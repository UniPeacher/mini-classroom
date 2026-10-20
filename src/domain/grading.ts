import type { Grade, Mcq, PickLine } from '../shared/content';

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

/**
 * 点选错误行按规则判分：选中了没有错的行，说明对规则的理解有偏差，视为误解；
 * 没有选（交白卷）视为遗忘。
 */
export function gradePickLine(question: PickLine, chosenIndex: number): Grade {
  if (chosenIndex === question.answerIndex) return { correct: true, errorType: null, feedback: question.explanation };
  const chosen = question.lines[chosenIndex];
  if (chosen === undefined) return { correct: false, errorType: 'forgetting', feedback: question.explanation };
  return {
    correct: false,
    errorType: 'misconception',
    feedback: `你选的第 ${chosenIndex + 1} 行没有问题，有错的是第 ${question.answerIndex + 1} 行。\n\n${question.explanation}`,
  };
}

/** 误解的具体内容：选择题取所选干扰项的误解标注，供对比讲解有针对性地讲 */
export function misconceptionOf(question: Mcq, chosenIndex: number): string | null {
  return question.options[chosenIndex]?.misconception ?? null;
}
