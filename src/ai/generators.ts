import type { ExplainForm, QuestionForm } from '../domain/forms';
import type { Stage } from '../domain/memory';
import {
  AnswerSchema,
  type AppealVerdict,
  AppealVerdictSchema,
  CheatsheetSchema,
  type ConnectionGrade,
  ConnectionGradeSchema,
  type Decomposition,
  DecompositionSchema,
  type Grade,
  GradeSchema,
  type KnowledgeSuggestion,
  KnowledgeSuggestionSchema,
  type Graph,
  GraphSchema,
  type LessonDraft,
  type OpenQuestion,
  type PlacementPlan,
  type Question,
  type ReviewContent,
  lessonSchema,
  placementSchema,
  reviewSchema,
} from '../shared/content';
import type { StructuredModel } from './gateway';
import { type TopicBrief, describeTopicBrief } from '../shared/topic-planning';
import { type ContentGuidance, DEFAULT_CONTENT_GUIDANCE } from '../shared/content-guidance';
import { diagramGuide, lessonFigureGuide } from './writing-style';

const BASE_SYSTEM = `你是"微课堂"的教学设计者。微课堂帮助学习者利用碎片时间真正学会、能用、长期不忘一个主题。
学习者常在碎片时间、注意力有限的状态下阅读，内容必须一眼能抓住要点。

## 基本要求
- 一律使用简体中文；技术名词、代码保持原文。
- 内容必须准确。不确定的说法宁可不写，也不要编造。
- 讲解围绕本节的知识内容与学习目标，结合学习者的基础和最近的误解。
- 涉及编程的主题，用短小可读的代码示例，放在 Markdown 代码块里。
- 主题不限于编程。不是编程的主题，代码题换成该领域里的真实材料：一段做法、一个方案、一组步骤、一段论证。`;

/** 教程表达按本次引导词决定，知识准确性和题目结构由任务要求保证。 */
function contentSystem(tutorialGuidance: string): string {
  return `${BASE_SYSTEM}

## 教程引导词
${tutorialGuidance}

讲解顺序、详略、例子和排版按教程引导词组织；题目字段、作答与配图引用格式必须符合任务要求。若本节有补充说明，在保证内容准确和结构完整的前提下优先采用本节说明。`;
}

const SYSTEM = contentSystem(DEFAULT_CONTENT_GUIDANCE.tutorialGuidance);

/** 生成知识点内容时需要的上下文 */
export interface PointContext {
  topicTitle: string;
  learningBrief?: TopicBrief | null;
  title: string;
  summary: string;
  /** 已学过的前置知识点，可作为讲解的挂靠点 */
  prerequisites: string[];
  /** 易混知识点，用于选择题干扰项、误解标注和对比讲解 */
  confusables: string[];
  /** 学习者开始这一节时写的补充说明，用于调整讲解和出题 */
  guidance?: string;
  /** 掌握阶段：决定复习题考到什么程度 */
  stage?: Stage;
  /** 最近一次误解的内容：对比讲解针对它来讲 */
  misconception?: string | null;
  /** 学习者的已有知识：可作为类比和挂靠点 */
  existingKnowledge?: string[];
}

/** 生成骨架知识图谱 */
export function generateGraph(model: StructuredModel, topicTitle: string, learningBrief?: TopicBrief | null): Promise<Graph> {
  return model.generate({
    name: 'knowledge_graph',
    schema: GraphSchema,
    system: SYSTEM,
    prompt: `请为学习主题「${topicTitle}」生成骨架知识图谱。
${learningBrief ? `\n用户已确认的学习目标：\n${describeTopicBrief(learningBrief)}\n知识点应服务于这个目的和范围，不因主题名称较宽泛而扩成通用课程；保留达成目标必需的前置。\n` : ''}

要求：
1. 给出 15~30 个知识点。每个知识点都能单独教授、单独检验，粒度足够细；不要用"基础""进阶"这类只是分组的空节点。
2. 知识点按推荐学习顺序排列。key 用简短的英文短横线格式，例如 "union-types"。
3. title 简短，同一个概念全图使用同一个名称。summary 用一句话写清学会后能做什么，用具体的说法，不写"了解""掌握相关知识"这类空话。
4. 关系有三种：
   - prerequisite：学 to 之前必须先懂 from；
   - composition：from 是 to 的一部分，例如 Partial、Pick 是"工具类型"的一部分；
   - confusable：二者容易混淆，例如 any 与 unknown。
5. 前置关系不能有环。只标真正必要的前置，不要把"推荐顺序"都写成前置。`,
  });
}

const EXPLAIN_GUIDE: Record<ExplainForm, string> = {
  explain_direct: '直接讲解：说明概念的含义、用途、依据与易错处，结合具体示例。',
  explain_analogy: '类比讲解：用学习者熟悉的事物解释知识点，讲清对应关系与类比不成立的边界。',
  explain_counterexample: '反例讲解：借助看似正确的错误示例，说明它错在哪里，以及正确的理解。',
  explain_diagram:
    '图解：以图为主体帮助理解知识，文字引导阅读并补充必要说明。',
  explain_steps:
    '分步揭示：把内容拆成 3~6 步，学习者一步一步点开。explanation 概括接下来要理解的内容；steps 每项是一步，用 Markdown，可以带代码或图。',
  explain_predict:
    '预测揭晓：让学习者根据情境预测结果，再揭晓原因。predict.scenario 写情境（可含代码块），predict.options 是 2~4 个可能的结果，predict.answerIndex 是正确结果，predict.reveal 解释原因；explanation 写完整讲解。预测不计分。',
  explain_contrast:
    '对比讲解：针对学习者最近的误解，对比易混概念在定义、用法和结果上的区别，并用例子帮助区分。',
};

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** 题目材料：题干要看的代码或情境必须真的给出 */
const MATERIAL_RULE =
  '作答要看的代码或情境放在 material 里（Markdown，代码放在代码块中），stem/prompt 只写要回答的问题；不需要材料时 material 为 null。题干写了"下面的代码""以下情境"，material 就必须给出这段内容。页面会另外提供"不知道"选项，你不要写。';

/**
 * 题目形式说明。选择题、点选错误行的正确位置由代码随机决定再告诉模型——
 * 让模型自己"随机放"并不可靠，实测会集中在同一个位置。
 */
function questionGuide(form: QuestionForm, random: () => number): string {
  const openRules =
    'referenceAnswer 给出一个简洁的正确答案（只作参考，同一道题允许有多种正确答案）；keyPoints 列出 1~5 个判定对错的关键要点，每个要点一句话。';
  switch (form) {
    case 'short_answer':
      return `简答题：要求学习者用自己的话解释，或写一小段代码/表达式，2 分钟内能答完。prompt 一句话写清要回答什么、答到什么程度。${MATERIAL_RULE}${openRules}`;
    case 'pick_line': {
      const answerIndex = Math.floor(random() * 4);
      return `点选错误行：给出 5~10 行代码或推理步骤，其中恰好一行有错，有错的是第 ${answerIndex + 1} 行（answerIndex 为 ${answerIndex}）。lines 每项一行，不带行号；language 是代码语言（如 "ts"），不是代码时为 null。prompt 一句话说明这段代码或步骤要做什么。错误要是这个知识点上真实常见的错误，其余各行都必须正确。explanation 先说第 ${answerIndex + 1} 行错在哪、正确写法是什么，再一句话说明为什么其他行没问题。`;
    }
    case 'complete':
      return `补全：给出一段接近真实工作的代码或材料，挖掉体现这个知识点的关键部分，用 ____ 标出空缺（只挖一处）。template 是带空缺的完整内容；language 是代码语言，不是代码时为 null。prompt 一句话说明要补出什么效果。${openRules}`;
    case 'fix':
      return `修正：给出一段接近真实工作的、有问题的代码或做法（flawed），问题正好出在这个知识点上，乍看不容易发现。prompt 说明它本来要实现什么、现在出了什么现象；language 是代码语言，不是代码时为 null。referenceAnswer 是修正后的版本；keyPoints 写判定修正是否到位的要点。`;
    case 'mcq': {
      const answerIndex = Math.floor(random() * OPTION_LETTERS.length);
      return `单选题：${MATERIAL_RULE}4 个选项，只有 1 个正确，正确选项放在第 ${answerIndex + 1} 个（字母 ${OPTION_LETTERS[answerIndex]}，answerIndex 为 ${answerIndex}）。题干一句话问清楚要判断什么；选项长度相近、互不重叠。每个错误选项都要代表一种真实存在的误解，并在 misconception 中用一句话写明这种误解；如果存在易混知识点，优先用它来构造干扰项。正确选项的 misconception 为 null。explanation 第一句说正确选项为什么对，再用一句话分别说明每个错误选项错在哪；提到选项时用页面显示的字母 A、B、C、D，不用数字序号。`;
    }
  }
}

function describePoint(ctx: PointContext): string {
  const lines = [`学习主题：${ctx.topicTitle}`, `知识点：${ctx.title}`, `要掌握的内容：${ctx.summary}`];
  if (ctx.learningBrief) lines.push(`用户已确认的学习目标（据此选择讲解、练习的场景和深度）：\n${describeTopicBrief(ctx.learningBrief)}`);
  if (ctx.prerequisites.length) lines.push(`学习者已学过的前置知识点：${ctx.prerequisites.join('、')}`);
  if (ctx.confusables.length) lines.push(`易混知识点：${ctx.confusables.join('、')}`);
  if (ctx.existingKnowledge?.length) lines.push(`学习者的已有知识（可用来类比和挂靠）：${ctx.existingKnowledge.join('、')}`);
  if (ctx.misconception) lines.push(`学习者最近的误解：${ctx.misconception}`);
  if (ctx.guidance) {
    lines.push(
      `\n学习者对这一节的补充说明（在内容准确、符合下面各项要求和输出格式的前提下，据此调整讲解和出题的角度、深度、例子与图解）：\n<guidance>\n${ctx.guidance}\n</guidance>`,
    );
  }
  return lines.join('\n');
}

/** 生成讲解 + 当场小题 */
export function generateLesson(
  model: StructuredModel,
  ctx: PointContext,
  forms: { explainForm: ExplainForm; questionForm: QuestionForm },
  options: { illustrations: boolean; contentGuidance?: ContentGuidance } = { illustrations: false },
  random: () => number = Math.random,
): Promise<LessonDraft> {
  const relearning = ctx.stage && ctx.stage !== 'unlearned' && ctx.stage !== 'understand';
  const guidance = options.contentGuidance ?? DEFAULT_CONTENT_GUIDANCE;
  return model.generate({
    name: 'lesson',
    schema: lessonSchema(forms.explainForm, forms.questionForm, options),
    system: contentSystem(guidance.tutorialGuidance),
    prompt: `${describePoint(ctx)}

请为这个知识点写一段讲解，并附一道当场检验的小题。${relearning ? '学习者之前学过这个知识点，但刚刚答错了，这次讲解要纠正他的理解。' : ''}
- 讲解形式：${EXPLAIN_GUIDE[forms.explainForm]}
- 讲解用 Markdown，按教程引导词决定详略和排版。可以借助学习者已学过的前置知识点。
- 按下面的配图要求，为讲解配 1~2 张图（一般 1 张）。
- 小题（check）形式：${questionGuide(forms.questionForm, random)}
- 小题要检验理解：换用与讲解中不同的示例或场景，不要直接复用讲解里的代码和原句。
- 小题自带作答所需的全部信息（代码、情境），不写"根据上文""如讲解所示"。
- estSeconds：读完讲解并答完小题大约需要的秒数。

${lessonFigureGuide(options, guidance.figureGuidance)}`,
  });
}

const STAGE_REVIEW_GUIDE: Partial<Record<Stage, string>> = {
  inferred: '学习者在摸底时被推断已经会这个知识点，但没有直接考过。出一道题抽查他是否真的掌握：考核心理解，不考冷门细节。',
  recall: '学习者之前已学过这个知识点，现在要隔一段时间后检验是否还记得、是否真正理解。换一个具体场景或角度来考，检验能否举一反三，而不是背诵定义。',
  apply: '学习者已能回忆这个知识点，现在检验能否在类似真实工作的任务里用对它。题目取材于真实工作中会遇到的情形，而不是概念辨析。',
  retain: '学习者已能熟练应用这个知识点，这是一次长间隔后的保持检验。可以把它和相关知识放在一起综合考，但答对的关键仍在这个知识点上。',
};

/** 生成复习题（含推断掌握的抽查题） */
export function generateReview(
  model: StructuredModel,
  ctx: PointContext,
  questionForm: QuestionForm,
  options: { contentGuidance?: ContentGuidance } = {},
  random: () => number = Math.random,
): Promise<ReviewContent & { estSeconds: number }> {
  const guidance = options.contentGuidance ?? DEFAULT_CONTENT_GUIDANCE;
  return model.generate({
    name: 'review',
    schema: reviewSchema(questionForm),
    system: contentSystem(guidance.tutorialGuidance),
    prompt: `${describePoint(ctx)}

${STAGE_REVIEW_GUIDE[ctx.stage ?? 'recall'] ?? STAGE_REVIEW_GUIDE.recall} 请出一道题。
- 题目形式：${questionGuide(questionForm, random)}
- 题目自带作答所需的全部信息（代码、情境），学习者不需要回忆任何讲解原文就能读懂题目。
- 看图更容易考查理解时（例如"图中哪一步会报错"），题目和解析里也可以用图，按下面的图解要求画。
- estSeconds：答完这道题大约需要的秒数。

${diagramGuide(guidance.figureGuidance)}`,
  });
}

/** 开放题的题面，批改和申诉时给模型看 */
function describeOpenQuestion(question: OpenQuestion): string {
  const fence = (language: string | null, body: string) => `\`\`\`${language ?? ''}\n${body}\n\`\`\``;
  if (question.type === 'complete') return `补全题：${question.prompt}\n带空缺的模板：\n${fence(question.language, question.template)}`;
  if (question.type === 'fix') return `修正题：${question.prompt}\n有问题的版本：\n${fence(question.language, question.flawed)}`;
  return `简答题：${question.prompt}${question.material ? `\n题目材料：\n${question.material}` : ''}`;
}

const FEEDBACK_RULES = `- feedback：用"你"称呼学习者，2~4 句话，按以下要求写：
  - 第一句直接说最关键的一点：答对时说清你已经掌握了什么，要具体；答错时说清缺了哪个要点或哪里说错了。
  - 答错时就事论事：给出正确说法和原因，不写"很遗憾""别灰心"之类的话。
  - 学习者的作答有错误前提时，直接指出并给出正确理解。
  - 最后可以给一个马上能做的小动作，例如"对照参考答案第 2 个要点再看一遍"。`;

/** 批改开放题：简答、补全、修正 */
export function gradeOpenAnswer(
  model: StructuredModel,
  ctx: Pick<PointContext, 'topicTitle' | 'title'>,
  question: OpenQuestion,
  answer: string,
): Promise<Grade> {
  return model.generate({
    name: 'grade',
    schema: GradeSchema,
    system: SYSTEM,
    prompt: `请批改学习者的作答。

学习主题：${ctx.topicTitle}
知识点：${ctx.title}
${describeOpenQuestion(question)}
参考答案：${question.referenceAnswer}
判定要点：
${question.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

学习者的作答：
"""
${answer}
"""

判定规则：
- 覆盖全部判定要点、且没有错误说法，判为正确（correct = true）。表述或写法不同也算对；参考答案不是唯一标准，能达到同样效果的其他正确写法也算对。
- 否则判为错误，并给出错误类型：
  - misconception（误解）：作答中出现了错误的认知，比如把概念说反、和易混概念搞混；
  - forgetting（遗忘）：空白、想不起来，或者只答出一部分但没有说错。
- 正确时 errorType 为 null。
${FEEDBACK_RULES}`,
  });
}

/** 批改联结练习：学习者用自己的话说明两个知识之间的关系 */
export function gradeConnection(
  model: StructuredModel,
  ctx: { topicTitle: string; title: string; summary: string; partner: string },
  prompt: string,
  answer: string,
): Promise<ConnectionGrade> {
  return model.generate({
    name: 'connection_grade',
    schema: ConnectionGradeSchema,
    system: SYSTEM,
    prompt: `学习者刚学完一个知识点，被要求用自己的话说明它和另一个知识之间的关系。请判断这段说明是否成立。

学习主题：${ctx.topicTitle}
刚学的知识点：${ctx.title}（${ctx.summary}）
另一个知识：${ctx.partner}
题目：${prompt}

学习者的说明：
"""
${answer}
"""

判定规则：
- 说明中两者的关系说对了（谁是谁的前提、谁是谁的一部分、有什么异同、什么时候用哪个，说对其中一种即可），且没有错误说法，accepted 为 true。不要求完整，只要求正确。
- 关系说错、把两者混为一谈，或者只复述了其中一个知识点而没有说关系，accepted 为 false。
- relation：用一句话概括两者真正的关系（不超过 30 字），无论是否认可都要写。
${FEEDBACK_RULES}`,
  });
}

/** 申诉：学习者对批改有异议，重新判定 */
export function judgeAppeal(
  model: StructuredModel,
  ctx: Pick<PointContext, 'topicTitle' | 'title'>,
  input: { question: Question; answer: string; originalFeedback: string; reason: string },
): Promise<AppealVerdict> {
  return model.generate({
    name: 'appeal',
    schema: AppealVerdictSchema,
    system: SYSTEM,
    prompt: `学习者对一次批改提出申诉，请重新判定。

学习主题：${ctx.topicTitle}
知识点：${ctx.title}
题目（JSON，含参考答案）：
${JSON.stringify(input.question, null, 2)}

学习者的作答：
"""
${input.answer}
"""

原来的批改结论：判为错误。批改反馈：${input.originalFeedback}

学习者的申诉理由：
"""
${input.reason}
"""

请独立判断，不要因为学习者坚持就改判，也不要维护原判：
- accepted：学习者的答案也成立（参考答案不是唯一标准），这次作答改判为答对；
- void：题目或参考答案本身有错误或歧义，这道题作废，不计入记忆；
- rejected：原判正确，维持原判。
feedback：用"你"称呼学习者，2~3 句话，说清判定的理由；改判为答对时说清你的答案为什么也成立，维持原判时指出答案的具体问题。`,
  });
}

/** 拆解：为反复失败的知识点生成 1~3 个更基础的前置知识点 */
export function decomposePoint(
  model: StructuredModel,
  ctx: PointContext & { existingTitles: string[] },
): Promise<Decomposition> {
  return model.generate({
    name: 'decomposition',
    schema: DecompositionSchema,
    system: SYSTEM,
    prompt: `${describePoint(ctx)}

学习者在这个知识点上已经连续答错多次，说明它对他来说跨度太大。请找出学懂它之前必须先掌握、但学习者很可能还不会的 1~3 个更基础的知识点。
- 每个都要比原知识点更基础、更小，能单独教授、单独检验。
- 不要与已有的这些知识点重复：${ctx.existingTitles.join('、')}
- title 简短；summary 用一句话写清学会后能做什么。`,
  });
}

/** 摸底诊断的准备：从背景自述推断已有知识和起点，并为候选知识点各出一道选择题 */
export function preparePlacement(
  model: StructuredModel,
  input: {
    topicTitle: string;
    background: string;
    points: { id: string; title: string; summary: string }[];
    probeIds: string[];
  },
  random: () => number = Math.random,
): Promise<PlacementPlan> {
  const probes = input.points.filter((p) => input.probeIds.includes(p.id));
  // 每道题的正确选项位置由代码随机决定（理由见 questionGuide）
  const positions = probes.map((p) => {
    const answerIndex = Math.floor(random() * OPTION_LETTERS.length);
    return `${p.id}：${p.title}（正确选项放在 ${OPTION_LETTERS[answerIndex]}，answerIndex 为 ${answerIndex}）`;
  });
  return model.generate({
    name: 'placement',
    schema: placementSchema(input.probeIds),
    system: SYSTEM,
    prompt: `学习者要开始学习「${input.topicTitle}」。开始前做一次约 3 分钟的摸底，确定他已经会什么、从哪里开始学。

学习者的背景自述：
"""
${input.background || '（没有填写）'}
"""

这个主题的知识点（id：标题 —— 概要），按推荐学习顺序：
${input.points.map((p) => `${p.id}：${p.title} —— ${p.summary}`).join('\n')}

请完成三件事：
1. existingKnowledge：从背景自述中提炼学习者已经具备、可作为新知识挂靠点的知识，每条一个短语（如"Python 基础语法""会用 Excel 做透视表"），可以不属于这个主题；自述里没有就给空数组。最多 8 条。
2. likelyKnownIds：根据背景自述，从下面的候选知识点中挑出学习者很可能已经会的（只填 id），作为摸底的起点；判断不了就给空数组。
3. probes：为下面每个候选知识点各出一道单选题，检验是否真的会。题目要能区分"真会"和"听说过"，不考冷门细节。
   - 每题 4 个选项，只有 1 个正确，正确选项放在下面为每题指定的位置。题干一句话问清楚要判断什么；选项长度相近、互不重叠。
   - ${MATERIAL_RULE}
   - 每个错误选项代表一种真实存在的误解，在 misconception 中用一句话写明；正确选项的 misconception 为 null。
   - explanation 第一句说正确选项为什么对；提到选项时用字母 A、B、C、D。
   - 页面会另外加一个"不知道"选项，你不要写。

候选知识点：
${positions.join('\n')}`,
  });
}

/** 生成速查表：只依据给出的知识点、易混对比和学习者的联结原话 */
export async function generateCheatsheet(
  model: StructuredModel,
  input: {
    scopeTitle: string;
    points: { title: string; summary: string; topicTitle: string; explanation: string | null }[];
    confusablePairs: [string, string][];
    connections: { from: string; to: string; quote: string }[];
  },
): Promise<string> {
  const { markdown } = await model.generate({
    name: 'cheatsheet',
    schema: CheatsheetSchema,
    system: SYSTEM,
    prompt: `请为学习者生成一份知识速查表（Markdown），范围：${input.scopeTitle}。速查表用于日后快速回顾和查用，不是教程。

收录的知识点（标题 —— 概要；后面附学习者学过的讲解原文，供你提炼要点）：
${input.points.map((p) => `### ${p.title}（${p.topicTitle}）\n${p.summary}\n${p.explanation ? `讲解原文：\n${p.explanation.slice(0, 1500)}` : ''}`).join('\n\n')}

易混知识点对：${input.confusablePairs.length ? input.confusablePairs.map(([a, b]) => `${a} / ${b}`).join('；') : '无'}

学习者自己建立的联结（保留原话）：
${input.connections.length ? input.connections.map((c) => `- ${c.from} ↔ ${c.to}：「${c.quote}」`).join('\n') : '无'}

要求：
- 以一级标题写速查表名称，按主题和组成关系分组，每个知识点用二级或三级标题。
- 每个知识点 2~5 行：一句话是什么、最常用的写法或做法（代码题给最小代码片段）、最容易错的地方。
- 每组易混知识点给一张对比表。
- 学习者的联结原话放在相关知识点下，用引用块标出"我的理解"。
- 只写给出的知识点，不扩展新内容。`,
  });
  return markdown;
}

/** 学习时提问的上下文：正在学的知识点、讲解原文、还没作答的小题 */
export interface AskContext {
  topicTitle: string;
  title: string;
  summary: string;
  explanation: string | null;
  /** 当前小题的题面（不含答案）；null 表示没有小题 */
  questionText: string | null;
  /** 小题是否已经作答：作答前不直接给出答案 */
  answered: boolean;
}

/** 回答学习时的提问：结合正在学的内容，简明作答；小题作答前只引导、不给答案 */
export async function answerQuestion(
  model: StructuredModel,
  ctx: AskContext | null,
  input: { question: string; quote?: string | null; history: { question: string; answer: string }[] },
): Promise<string> {
  const context = ctx
    ? `学习者正在学：
学习主题：${ctx.topicTitle}
知识点：${ctx.title}（${ctx.summary}）
${ctx.explanation ? `正在读的讲解：\n${ctx.explanation.slice(0, 2500)}\n` : ''}${ctx.questionText ? `当前小题（${ctx.answered ? '已作答' : '还没作答'}）：\n${ctx.questionText.slice(0, 1500)}\n` : ''}`
    : '学习者在学习过程中提问。';
  const { answer } = await model.generate({
    name: 'answer',
    schema: AnswerSchema,
    system: SYSTEM,
    prompt: `${context}
${input.history.length ? `之前的问答：\n${input.history.map((h) => `问：${h.question}\n答：${h.answer}`).join('\n\n')}\n` : ''}
${input.quote ? `学习者选中了这段内容来问：\n「${input.quote.slice(0, 1500)}」\n\n` : ''}学习者现在问：
"""
${input.question}
"""

回答要求：
- 用"你"称呼学习者，直接回答问的问题，第一句就是要点；一般 2~6 句，讲清楚就停。
- 结合正在学的知识点和讲解来答，用学习者已经看到的名称和例子；有选中的内容时，围绕那段内容解释。
- ${ctx && ctx.questionText && !ctx.answered ? '当前小题还没作答：如果问题是在问这道题的答案，不要直接给出答案或选项，而是提示思路、指出该回看讲解的哪一部分。' : '可以直接讨论小题的答案和原因。'}
- 问题超出当前知识点时照常回答，但点明它属于另一个知识点。
- 用 Markdown；需要时给一小段代码，或一张简单的 Mermaid 图（\`\`\`mermaid）。`,
  });
  return answer;
}

/** 从学习者的提问中整理出还不了解、值得单独学习的知识点（0~4 个） */
export async function suggestKnowledge(
  model: StructuredModel,
  ctx: { topicTitle: string; title: string; summary: string; existingTitles: string[] },
  asks: { question: string; answer: string }[],
  hint?: string,
): Promise<KnowledgeSuggestion[]> {
  const { knowledgePoints } = await model.generate({
    name: 'knowledge_suggestion',
    schema: KnowledgeSuggestionSchema,
    system: SYSTEM,
    prompt: `学习者在学「${ctx.topicTitle}」的知识点「${ctx.title}」（${ctx.summary}）时提了下面这些问题。请从中找出学习者还不了解、值得以后单独学一学的知识，整理成知识点加入他的认知地图。

学习者的提问和得到的回答：
${asks.map((a, i) => `${i + 1}. 问：${a.question}\n   答：${a.answer.slice(0, 600)}`).join('\n')}

这个主题已有的知识点（不要重复）：${ctx.existingTitles.join('、')}
${hint ? `\n学习者希望这次整理侧重：\n<hint>\n${hint}\n</hint>\n在只收真正不了解的知识的前提下，按这个侧重挑选和表述。\n` : ''}
要求：
- 只收提问暴露出的真正不了解的知识；问题已在回答中讲透、只是一时没想起来的，不收。没有就给空数组，最多 4 个。
- 每个知识点能单独教授、单独检验，粒度与已有知识点相当。title 简短；summary 一句话写清学会后能做什么。
- kind：学懂「${ctx.title}」必须先补的基础为 prerequisite，相关的延伸为 extension。
- reason：一句话说明从哪个提问看出不了解。`,
  });
  return knowledgePoints;
}
