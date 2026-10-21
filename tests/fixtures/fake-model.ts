import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { AiOutputError } from '../../src/ai/gateway';
import type { AppealVerdict, Complete, ConnectionGrade, Fix, Grade, Graph, Mcq, PickLine, ShortAnswer } from '../../src/shared/content';

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
  const networkFailures = { ...options.networkFailures };
  const concurrency = { current: 0, peak: 0 };
  const candidates = (name: string, prompt: string): unknown[] => {
    switch (name) {
      case 'knowledge_graph':
        return [GRAPH];
      case 'lesson':
        return QUESTIONS.map((check) => ({
          explanation: '讲解内容',
          check,
          estSeconds: 150,
          steps: ['第一步', '第二步', '第三步'],
          predict: { scenario: '猜猜输出', options: ['1', '2'], answerIndex: 0, reveal: '是 1' },
        }));
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

  return { model, calls, prompts, concurrency };
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
