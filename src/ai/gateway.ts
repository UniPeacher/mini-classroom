import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, NoObjectGeneratedError, Output, generateText } from 'ai';
import type { z } from 'zod';

export interface StructuredRequest<T> {
  /** 结构名称，用于 JSON Schema 命名和日志 */
  name: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
}

/** 业务代码唯一依赖的模型接口：输入提示词，输出经过校验的结构化内容。 */
export interface StructuredModel {
  generate<T>(request: StructuredRequest<T>): Promise<T>;
}

/** 多次尝试后仍拿不到合法结构时抛出 */
export class AiOutputError extends Error {
  constructor(name: string, attempts: number, cause: unknown) {
    super(`模型连续 ${attempts} 次未能生成合法的 ${name}`, { cause });
    this.name = 'AiOutputError';
  }
}

export interface StructuredModelOptions {
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  /** 总尝试次数：首次 + 重试 */
  maxAttempts?: number;
}

/**
 * 基于 AI SDK 实现结构化生成。输出不符合结构（含 refine 规则）时重试，
 * 网络与接口错误交给 AI SDK 自带的重试处理，这里直接抛出。
 */
export function createStructuredModel(model: LanguageModel, options: StructuredModelOptions = {}): StructuredModel {
  const maxAttempts = options.maxAttempts ?? 3;
  return {
    async generate({ name, schema, system, prompt }) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const { output } = await generateText({
            model,
            system,
            prompt,
            output: Output.object({ schema, name }),
            providerOptions: options.providerOptions,
          });
          return output;
        } catch (error) {
          if (!NoObjectGeneratedError.isInstance(error)) throw error;
          lastError = error;
        }
      }
      throw new AiOutputError(name, maxAttempts, lastError);
    },
  };
}

/** 支持的模型供应商：OpenAI 兼容格式、Anthropic、Gemini（ADR 0005） */
export const PROVIDERS = ['openai-compatible', 'anthropic', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** 按环境变量构建模型（ADR 0005：供应商只由配置决定，业务代码不感知）。 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): StructuredModel {
  const provider = env.MODEL_PROVIDER ?? 'openai-compatible';
  const modelName = required(env, 'MODEL_NAME');
  const apiKey = env.MODEL_API_KEY || undefined;
  const baseURL = env.MODEL_BASE_URL || undefined;
  const effort = env.MODEL_REASONING_EFFORT || undefined;

  switch (provider) {
    case 'openai-compatible': {
      const compatible = createOpenAICompatible({
        name: 'main',
        baseURL: required(env, 'MODEL_BASE_URL'),
        apiKey,
        supportsStructuredOutputs: env.MODEL_SUPPORTS_STRUCTURED_OUTPUTS !== 'false',
      });
      return createStructuredModel(compatible.chatModel(modelName), {
        providerOptions: effort ? { main: { reasoningEffort: effort } } : undefined,
      });
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ baseURL, apiKey });
      return createStructuredModel(anthropic(modelName), {
        providerOptions: effort ? { anthropic: { effort } } : undefined,
      });
    }
    case 'google': {
      const google = createGoogle({ baseURL, apiKey });
      return createStructuredModel(google(modelName), {
        providerOptions: effort ? { google: { thinkingConfig: { thinkingLevel: googleThinkingLevel(effort) } } } : undefined,
      });
    }
    default:
      throw new Error(`不支持的模型供应商：${provider}（可选：${PROVIDERS.join('、')}）`);
  }
}

/** Gemini 的思考强度只有 low / medium / high 三档 */
function googleThinkingLevel(effort: string): 'low' | 'medium' | 'high' {
  if (effort === 'low' || effort === 'minimal') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`缺少环境变量 ${key}，请参考 .env.example 配置`);
  return value;
}
