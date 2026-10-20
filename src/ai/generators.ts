import type { ExplainForm, QuestionForm } from '../domain/forms';
import {
  type Grade,
  GradeSchema,
  type Graph,
  GraphSchema,
  type LessonContent,
  type ReviewContent,
  type ShortAnswer,
  lessonSchema,
  reviewSchema,
} from '../shared/content';
import type { StructuredModel } from './gateway';
import { WRITING_PRINCIPLES } from './writing-style';

const SYSTEM = `你是"微课堂"的教学设计者。微课堂帮助学习者利用碎片时间真正学会、能用、长期不忘一个主题。
学习者常在碎片时间、注意力有限的状态下阅读，内容必须一眼能抓住要点。

## 基本要求
- 一律使用简体中文；技术名词、代码保持原文。
- 内容必须准确。不确定的说法宁可不写，也不要编造。
- 讲解面向第一次接触该知识点的学习者，讲清楚"是什么、为什么、怎么用、容易错在哪"。
- 涉及编程的主题，用短小可读的代码示例，放在 Markdown 代码块里。

${WRITING_PRINCIPLES}`;

/** 生成知识点内容时需要的上下文 */
export interface PointContext {
  topicTitle: string;
  title: string;
  summary: string;
  /** 已学过的前置知识点，可作为讲解的挂靠点 */
  prerequisites: string[];
  /** 易混知识点，用于选择题干扰项和误解标注 */
  confusables: string[];
}

/** 生成骨架知识图谱 */
export function generateGraph(model: StructuredModel, topicTitle: string): Promise<Graph> {
  return model.generate({
    name: 'knowledge_graph',
    schema: GraphSchema,
    system: SYSTEM,
    prompt: `请为学习主题「${topicTitle}」生成骨架知识图谱。

要求：
1. 给出 15~30 个知识点。每个知识点都能单独教授、单独检验，粒度足够细；不要用"基础""进阶"这类只是分组的空节点。
2. 知识点按推荐学习顺序排列。key 用简短的英文短横线格式，例如 "union-types"。
3. title 简短，同一个概念全图使用同一个名称。summary 用一句话写清学会后能做什么，用具体的说法，不写"了解""掌握相关知识"这类空话。
4. 关系有三种：
   - prerequisite：学 to 之前必须先懂 from；
   - composition：from 是 to 的一部分；
   - confusable：二者容易混淆，例如 any 与 unknown。
5. 前置关系不能有环。只标真正必要的前置，不要把"推荐顺序"都写成前置。`,
  });
}

const EXPLAIN_GUIDE: Record<ExplainForm, string> = {
  explain_direct: '直接讲解：一句话说清它是什么、解决什么问题 → 一个最小示例 → 它是怎么起作用的 → 最常见的一个误区。',
  explain_analogy: '类比讲解：先用一个贴切的、学习者已知的事物做类比，再映射回知识点本身，最后指出类比在哪里不成立。',
  explain_counterexample: '反例讲解：先给出一个看似正确、其实错误的写法或理解，揭示它为什么错，再给出正确理解和写法。',
};

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

/**
 * 题目形式说明。选择题正确答案的位置由代码随机决定再告诉模型——
 * 让模型自己"随机放"并不可靠，实测会集中在同一个位置。
 */
function questionGuide(form: QuestionForm, random: () => number): string {
  if (form === 'short_answer') {
    return `简答题：要求学习者用自己的话解释，或写一小段代码/表达式，2 分钟内能答完。prompt 一句话写清要回答什么、答到什么程度。referenceAnswer 给出一个简洁的正确答案；keyPoints 列出 1~5 个判定对错的关键要点，每个要点一句话。`;
  }
  const answerIndex = Math.floor(random() * OPTION_LETTERS.length);
  return `单选题：4 个选项，只有 1 个正确，正确选项放在第 ${answerIndex + 1} 个（字母 ${OPTION_LETTERS[answerIndex]}，answerIndex 为 ${answerIndex}）。题干一句话问清楚要判断什么；选项长度相近、互不重叠。每个错误选项都要代表一种真实存在的误解，并在 misconception 中用一句话写明这种误解；如果存在易混知识点，优先用它来构造干扰项。正确选项的 misconception 为 null。explanation 第一句说正确选项为什么对，再用一句话分别说明每个错误选项错在哪；提到选项时用页面显示的字母 A、B、C、D，不用数字序号。`;
}

function describePoint(ctx: PointContext): string {
  const lines = [`学习主题：${ctx.topicTitle}`, `知识点：${ctx.title}`, `要掌握的内容：${ctx.summary}`];
  if (ctx.prerequisites.length) lines.push(`学习者已学过的前置知识点：${ctx.prerequisites.join('、')}`);
  if (ctx.confusables.length) lines.push(`易混知识点：${ctx.confusables.join('、')}`);
  return lines.join('\n');
}

/** 生成讲解 + 当场小题 */
export function generateLesson(
  model: StructuredModel,
  ctx: PointContext,
  forms: { explainForm: ExplainForm; questionForm: QuestionForm },
  random: () => number = Math.random,
): Promise<LessonContent & { estSeconds: number }> {
  return model.generate({
    name: 'lesson',
    schema: lessonSchema(forms.questionForm),
    system: SYSTEM,
    prompt: `${describePoint(ctx)}

请为这个知识点写一段讲解，并附一道当场检验的小题。
- 讲解形式：${EXPLAIN_GUIDE[forms.explainForm]}
- 讲解用 Markdown，讲清楚就停，一般 200~500 字（不含代码）。可以借助学习者已学过的前置知识点。
- 小题（check）形式：${questionGuide(forms.questionForm, random)}
- 小题要检验理解：换用与讲解中不同的示例或场景，不要直接复用讲解里的代码和原句。
- 小题自带作答所需的全部信息（代码、情境），不写"根据上文""如讲解所示"。
- estSeconds：读完讲解并答完小题大约需要的秒数。`,
  });
}

/** 生成复习题 */
export function generateReview(
  model: StructuredModel,
  ctx: PointContext,
  questionForm: QuestionForm,
  random: () => number = Math.random,
): Promise<ReviewContent & { estSeconds: number }> {
  return model.generate({
    name: 'review',
    schema: reviewSchema(questionForm),
    system: SYSTEM,
    prompt: `${describePoint(ctx)}

学习者之前已学过这个知识点，现在要隔一段时间后检验是否还记得、是否真正理解。请出一道复习题。
- 题目形式：${questionGuide(questionForm, random)}
- 换一个具体场景或角度来考，检验能否举一反三，而不是背诵定义。
- 题目自带作答所需的全部信息（代码、情境），学习者不需要回忆任何讲解原文就能读懂题目。
- estSeconds：答完这道题大约需要的秒数。`,
  });
}

/** 批改简答题 */
export function gradeShortAnswer(
  model: StructuredModel,
  ctx: Pick<PointContext, 'topicTitle' | 'title'>,
  question: ShortAnswer,
  answer: string,
): Promise<Grade> {
  return model.generate({
    name: 'grade',
    schema: GradeSchema,
    system: SYSTEM,
    prompt: `请批改学习者的简答。

学习主题：${ctx.topicTitle}
知识点：${ctx.title}
题目：${question.prompt}
参考答案：${question.referenceAnswer}
判定要点：
${question.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

学习者的作答：
"""
${answer}
"""

判定规则：
- 覆盖全部判定要点、且没有错误说法，判为正确（correct = true）。表述方式不同也算对；参考答案不是唯一标准。
- 否则判为错误，并给出错误类型：
  - misconception（误解）：作答中出现了错误的认知，比如把概念说反、和易混概念搞混；
  - forgetting（遗忘）：空白、想不起来，或者只答出一部分但没有说错。
- 正确时 errorType 为 null。
- feedback：用"你"称呼学习者，2~4 句话，按以下要求写：
  - 第一句直接说最关键的一点：答对时说清你已经掌握了什么，要具体；答错时说清缺了哪个要点或哪里说错了。
  - 答错时就事论事：给出正确说法和原因，不写"很遗憾""别灰心"之类的话。
  - 学习者的作答有错误前提时，直接指出并给出正确理解。
  - 最后可以给一个马上能做的小动作，例如"对照参考答案第 2 个要点再看一遍"。`,
  });
}
