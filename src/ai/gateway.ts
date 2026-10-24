import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, NoObjectGeneratedError, Output, generateImage, generateText } from 'ai';
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

/** 推理强度：anthropic 另有 xhigh、max；google 只分 low / medium / high（更高的按 high） */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 文本模型的配置（设置页可改，ADR 0005：供应商只由配置决定，业务代码不感知） */
export interface TextModelConfig {
  provider: Provider;
  /** 接口地址：openai-compatible 必填；anthropic、google 留空时用官方地址 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 推理强度；空字符串表示用模型默认 */
  reasoningEffort: '' | (typeof REASONING_EFFORTS)[number];
  /** 是否支持严格 JSON Schema 结构化输出；不支持时退回 json_object 模式 */
  structuredOutputs: boolean;
}

/** 画图模型的配置：模型名为空表示不画插画；地址和密钥留空时沿用文本模型的 */
export interface ImageModelConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** 按配置构建文本模型；缺少必填项时抛出说明原因的错误 */
export function modelFromConfig(config: TextModelConfig): StructuredModel {
  const { provider, model: modelName, reasoningEffort: effort } = config;
  if (!modelName) throw new Error('还没有配置文本模型：请在设置页填写模型名称');
  const apiKey = config.apiKey || undefined;
  const baseURL = config.baseUrl || undefined;

  switch (provider) {
    case 'openai-compatible': {
      if (!baseURL) throw new Error('OpenAI 兼容格式需要填写接口地址');
      const compatible = createOpenAICompatible({ name: 'main', baseURL, apiKey, supportsStructuredOutputs: config.structuredOutputs });
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
      throw new Error(`不支持的模型供应商：${provider as string}（可选：${PROVIDERS.join('、')}）`);
  }
}

/** 画插画的模型接口：输入完整提示词，输出图片 */
export interface Illustrator {
  draw(request: { prompt: string; size: `${number}x${number}` }): Promise<{ data: Uint8Array; mediaType: string }>;
}

/**
 * 按配置构建画插画的模型。模型名为空时返回 undefined，讲解只用代码画的图。
 * 走 OpenAI 兼容的 /images/generations 接口；地址和密钥留空时沿用文本模型的配置。
 */
export function illustratorFromConfig(image: ImageModelConfig, text: TextModelConfig): Illustrator | undefined {
  if (!image.model) return undefined;
  const baseURL = image.baseUrl || text.baseUrl;
  if (!baseURL) throw new Error('画图模型需要填写接口地址');
  const compatible = createOpenAICompatible({ name: 'image', baseURL, apiKey: image.apiKey || text.apiKey || undefined });
  const model = compatible.imageModel(image.model);
  return {
    async draw({ prompt, size }) {
      const { image: result } = await generateImage({ model, prompt, size });
      return { data: result.uint8Array, mediaType: result.mediaType };
    },
  };
}

/** Gemini 的思考强度只有 low / medium / high 三档 */
function googleThinkingLevel(effort: string): 'low' | 'medium' | 'high' {
  if (effort === 'low' || effort === 'minimal') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}
