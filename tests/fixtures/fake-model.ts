import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { AiOutputError } from '../../src/ai/gateway';
import type { Grade, Graph, Mcq, ShortAnswer } from '../../src/shared/content';

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

/** 作答中含有这个标记时，假模型判为正确 */
export const CORRECT_MARK = '[对]';

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
  const networkFailures = { ...options.networkFailures };
  const concurrency = { current: 0, peak: 0 };
  const candidates = (name: string, prompt: string): unknown[] => {
    switch (name) {
      case 'knowledge_graph':
        return [GRAPH];
      case 'lesson':
        return [MCQ, SHORT].map((check) => ({ explanation: '讲解内容', check, estSeconds: 150 }));
      case 'review':
        return [MCQ, SHORT].map((question) => ({ question, estSeconds: 60 }));
      case 'grade':
        return [prompt.includes(CORRECT_MARK) ? correct() : wrong()];
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

  return { model, calls, concurrency };
}

const correct = (): Grade => ({ correct: true, errorType: null, feedback: '答得好' });
const wrong = (): Grade => ({ correct: false, errorType: 'misconception', feedback: '你把概念说反了' });
