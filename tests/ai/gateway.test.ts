import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiOutputError, createStructuredModel } from '../../src/ai/gateway';

/** 依次返回给定文本的 Mock 模型，并记录调用次数 */
function mockModel(texts: string[]) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const text = texts[Math.min(calls, texts.length - 1)]!;
      calls += 1;
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

const schema = z.object({ score: z.number() }).refine((v) => v.score >= 0, '分数不能为负');
const request = { name: 'score', schema, system: '系统提示', prompt: '用户提示' };

describe('结构化生成网关', () => {
  it('输出合法时直接返回校验后的结果', async () => {
    const { model, calls } = mockModel(['{"score": 3}']);
    await expect(createStructuredModel(model).generate(request)).resolves.toEqual({ score: 3 });
    expect(calls()).toBe(1);
  });

  it('违反 refine 规则时重试，重试成功则返回', async () => {
    const { model, calls } = mockModel(['{"score": -1}', '{"score": 5}']);
    await expect(createStructuredModel(model).generate(request)).resolves.toEqual({ score: 5 });
    expect(calls()).toBe(2);
  });

  it('输出不是 JSON 时同样重试', async () => {
    const { model } = mockModel(['好的，这是结果：score=3', '{"score": 3}']);
    await expect(createStructuredModel(model).generate(request)).resolves.toEqual({ score: 3 });
  });

  it('连续不合法达到上限后放弃，抛出 AiOutputError', async () => {
    const { model, calls } = mockModel(['{"score": -1}']);
    await expect(createStructuredModel(model, { maxAttempts: 3 }).generate(request)).rejects.toBeInstanceOf(AiOutputError);
    expect(calls()).toBe(3);
  });
});
