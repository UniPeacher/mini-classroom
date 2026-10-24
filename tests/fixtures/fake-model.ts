import type { Illustrator, StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { AiOutputError } from '../../src/ai/gateway';
import type { AppealVerdict, Complete, ConnectionGrade, Fix, Grade, Graph, IllustrationRequest, Mcq, PickLine, ShortAnswer } from '../../src/shared/content';

/** 测试用知识图谱：15 个知识点，联合类型 → 类型收窄 → unknown 收窄 */
export const GRAPH: Graph = {
  knowledgePoints: [
    { key: 'union-types', title: '联合类型', summary: '用 | 表示多种可能的类型' },
    { key: 'unknown-narrowing', title: 'unknown 类型收窄', summary: '使用 unknown 前先收窄类型' },
    ...Array.from({ length: 13 }, (_, i) => ({ key: `kp-${i}`, title: `知识点 ${i}`, summary: '要掌握的内容' })),
  ],
  relations: [
    { from: 'union-types', to: 'kp-0', type: 'prerequisite' },
    { from: 'unknown-narrowing', to: 'kp-0', type: 'prerequisite' },
    { from: 'union-types', to: 'unknown-narrowing', type: 'confusable' },
  ],
};

export const MCQ: Mcq = {
  type: 'mcq',
  stem: '哪项正确？',
  material: null,
  options: [
    { text: '错误选项', misconception: '一种误解' },
    { text: '正确选项', misconception: null },
    { text: '另一个错误选项', misconception: null },
  ],
  answerIndex: 1,
  explanation: '因为……',
};

export const SHORT: ShortAnswer = {
  type: 'short_answer',
  prompt: '用自己的话解释',
  material: null,
  referenceAnswer: '参考答案',
  keyPoints: ['要点一'],
};

export const PICK: PickLine = {
  type: 'pick_line',
  prompt: '找出有错的一行',
  language: 'ts',
  lines: ['const a = 1;', 'let b: string = 2;', 'const c = a + 1;', 'console.log(c);'],
  answerIndex: 1,
  explanation: '第 2 行把数字赋给了 string',
};

export const COMPLETE: Complete = {
  type: 'complete',
  prompt: '补全类型',
  language: 'ts',
  template: 'function f(x: ____) { return x; }',
  referenceAnswer: 'unknown',
  keyPoints: ['用 unknown'],
};

export const FIX: Fix = {
  type: 'fix',
  prompt: '修正这段代码',
  language: 'ts',
  flawed: 'const x: any = JSON.parse(s);',
  referenceAnswer: 'const x: unknown = JSON.parse(s);',
  keyPoints: ['改用 unknown'],
};

/** 讲解里的配图：每节讲解要配 1~2 张图 */
export const LESSON_DIAGRAM = '```mermaid\nflowchart TD\n  A["值"] --> B["收窄"]\n```';

/** 配置了图像模型时，假模型给讲解配的插画 */
export const ILLUSTRATION: IllustrationRequest = {
  key: 'narrowing',
  prompt: '为刚接触 TypeScript 的学习者解释 unknown：先检查类型，再安全使用。用二维教学图组合整体关系、判断流程和操作对照。上方展示 unknown 可能包含字符串或数字，蓝色表示字符串，橙色表示数字；中部用 typeof 检查连接两个分支；下方分别展示收窄后可用的 toUpperCase() 和 toFixed(2)。准确标注“未知类型”“字符串”“数字”“类型检查”“字符串分支”“数字分支”“检查后才能使用对应方法”，同类对象保持同色，按从上到下的顺序阅读。',
};

/** 作答中含有这个标记时，假模型判为正确（联结练习判为成立） */
export const CORRECT_MARK = '[对]';
/** 申诉理由中含有这些标记时，假模型分别判为"答案也成立""题目作废" */
export const APPEAL_ACCEPT_MARK = '[成立]';
export const APPEAL_VOID_MARK = '[作废]';

export interface FakeModelOptions {
  /** 对这些结构名称始终返回不合法内容 */
  invalid?: string[];
  /** 对这些结构名称抛出网络错误，次数用完后恢复 */
  networkFailures?: Record<string, number>;
  /** 每次请求的模拟耗时（毫秒） */
  delayMs?: number;
}

/**
 * 测试用模型：按结构名称返回固定内容。讲解和复习题同时备有选择题、简答题两种候选，
 * 用请求的结构去校验，取能通过的那个，从而与请求的形式一致。
 */
export function createFakeModel(options: FakeModelOptions = {}) {
  const calls: string[] = [];
  // 每次请求的提示词，与 calls 一一对应
  const prompts: string[] = [];
  const requests: StructuredRequest<unknown>[] = [];
  const networkFailures = { ...options.networkFailures };
  const concurrency = { current: 0, peak: 0 };
  const candidates = (name: string, prompt: string): unknown[] => {
    switch (name) {
      case 'knowledge_graph':
        return [GRAPH];
      case 'topic_clarification': {
        const corrected = prompt.includes('不做报表，我想采集公开网页数据');
        const ready = corrected || prompt.includes('希望用 Python 独立整理销售报表');
        return [{
          reply: ready ? '请核对下面的学习目标，也可以继续纠正。' : '你希望用它解决什么具体问题？',
          brief: ready ? {
            goal: corrected ? '用 Python 独立采集公开网页数据' : '用 Python 独立整理销售报表',
            background: '会 Excel，没有编程基础',
            scope: corrected ? ['读取公开网页并提取数据', '保存为 CSV 文件'] : ['读取 Excel 文件', '清洗、汇总销售数据'],
          } : null,
        }];
      }
      case 'topic_title':
        return [{ title: prompt.includes('公开网页') ? 'Python 公开网页数据采集' : 'Python 销售报表分析' }];
      case 'lesson': {
        // 先给代码画图的版本；请求的结构要求 illustrations 时（配置了图像模型）它校验不过，取后面带插画的版本
        const lesson = (check: (typeof QUESTIONS)[number]) => ({
          explanation: `讲解内容\n\n${LESSON_DIAGRAM}`,
          check,
          estSeconds: 150,
          steps: ['第一步', '第二步', '第三步'],
          predict: { scenario: '猜猜输出', options: ['1', '2'], answerIndex: 0, reveal: '是 1' },
        });
        return [
          ...QUESTIONS.map(lesson),
          ...QUESTIONS.map((check) => ({ ...lesson(check), explanation: `讲解内容\n\n![unknown 检查类型后才能安全使用](illustration:${ILLUSTRATION.key})`, illustrations: [ILLUSTRATION] })),
        ];
      }
      case 'review':
        return QUESTIONS.map((question) => ({ question, estSeconds: 60 }));
      case 'grade':
        return [prompt.includes(CORRECT_MARK) ? correct() : wrong()];
      case 'connection_grade':
        return [connectionGrade(prompt.includes(CORRECT_MARK))];
      case 'appeal':
        return [appealVerdict(prompt)];
      case 'decomposition':
        return [{ knowledgePoints: [{ title: '更基础的知识点', summary: '先学会它' }] }];
      case 'placement':
        return [placementPlan(prompt)];
      case 'answer':
        return [{ answer: prompt.includes('还没作答') && prompt.includes('答案是什么') ? '先回看讲解的第二段，想想它解决了什么问题。' : '这是对你问题的回答。' }];
      case 'knowledge_suggestion':
        return [
          {
            knowledgePoints: [
              { title: '类型守卫', summary: '能用 typeof、instanceof 写出类型守卫', kind: 'prerequisite', reason: '问了怎么判断类型' },
              { title: '联合类型', summary: '重复的知识点应被过滤', kind: 'extension', reason: '测试去重' },
            ],
          },
        ];
      case 'cheatsheet':
        return [{ markdown: '# 速查表\n\n## 联合类型\n用 | 表示多种可能。' }];
      default:
        return [];
    }
  };

  const model: StructuredModel = {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      requests.push(request as StructuredRequest<unknown>);
      concurrency.current += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.current);
      try {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        return respond(request);
      } finally {
        concurrency.current -= 1;
      }
    },
  };

  function respond<T>({ name, schema, prompt }: StructuredRequest<T>): T {
    calls.push(name);
    prompts.push(prompt);
    if ((networkFailures[name] ?? 0) > 0) {
      networkFailures[name]! -= 1;
      throw new Error('fetch failed');
    }
    if (options.invalid?.includes(name)) throw new AiOutputError(name, 3, new Error('结构不合法'));
    for (const candidate of candidates(name, prompt)) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
    throw new Error(`假模型没有与 ${name} 结构匹配的内容`);
  }

  return { model, calls, prompts, requests, concurrency };
}

const QUESTIONS = [MCQ, SHORT, PICK, COMPLETE, FIX];

const connectionGrade = (accepted: boolean): ConnectionGrade => ({
  accepted,
  relation: '前者是后者的前提',
  feedback: accepted ? '说得对' : '关系说反了',
});

const appealVerdict = (prompt: string): AppealVerdict => {
  if (prompt.includes(APPEAL_ACCEPT_MARK)) return { outcome: 'accepted', feedback: '你的答案也成立' };
  if (prompt.includes(APPEAL_VOID_MARK)) return { outcome: 'void', feedback: '题目有歧义，作废' };
  return { outcome: 'rejected', feedback: '原判正确' };
};

/** 背景自述中含有这个标记时，假模型把"知识点 0"推断为起点 */
export const START_MARK = '[起点]';

/**
 * 从提示词的"候选知识点"一节读出 id，为每个出一道选择题。
 * 背景自述里写了"JavaScript"就提炼为已有知识；含 START_MARK 时以"知识点 0"为起点。
 */
const placementPlan = (prompt: string) => {
  const section = prompt.slice(prompt.lastIndexOf('候选知识点：'));
  const probes = [...section.matchAll(/^(\S+)：(.*)（正确选项放在/gm)].map((m) => ({ id: m[1]!, title: m[2]! }));
  return {
    existingKnowledge: prompt.includes('JavaScript') ? ['会写 JavaScript'] : [],
    likelyKnownIds: prompt.includes(START_MARK) ? probes.filter((p) => p.title === '知识点 0').map((p) => p.id) : [],
    probes: probes.map((p) => ({ pointId: p.id, question: MCQ })),
  };
};

const correct = (): Grade => ({ correct: true, errorType: null, feedback: '答得好' });
const wrong = (): Grade => ({ correct: false, errorType: 'misconception', feedback: '你把概念说反了' });

/** 测试用的 PNG 文件头：假插画模型返回的"图片" */
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 测试用插画模型：记录收到的提示词，返回固定的图片；alwaysFail 为 true 时每次都报错 */
export function createFakeIllustrator(options: { alwaysFail?: boolean } = {}) {
  const prompts: string[] = [];
  const illustrator: Illustrator = {
    async draw({ prompt }) {
      prompts.push(prompt);
      if (options.alwaysFail) throw new Error('模拟的图像接口错误');
      return { data: FAKE_PNG, mediaType: 'image/png' };
    },
  };
  return { illustrator, prompts };
}
