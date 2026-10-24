import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type ImageModelConfig,
  type Illustrator,
  PROVIDERS,
  REASONING_EFFORTS,
  type StructuredModel,
  type StructuredRequest,
  type TextModelConfig,
  illustratorFromConfig,
  modelFromConfig,
} from './ai/gateway';
import type { Executor } from './store/db';
import { appSettings } from './store/schema';

/**
 * AI 模型配置：文本模型和画图模型分别配置，在设置页修改，保存后立即生效。
 * 没有在设置页保存过时，用 .env 里的值作为默认。密钥只存在本机数据库，不回传给页面。
 */

const HTTP_URL = /^https?:\/\/\S+$/;

const TextConfigSchema = z.object({
  provider: z.enum(PROVIDERS),
  baseUrl: z.string().trim(),
  model: z.string().trim(),
  apiKey: z.string().trim(),
  reasoningEffort: z.enum(['', ...REASONING_EFFORTS]),
  structuredOutputs: z.boolean(),
});

const ImageConfigSchema = z.object({
  model: z.string().trim(),
  baseUrl: z.string().trim(),
  apiKey: z.string().trim(),
});

export interface AiSettings {
  text: TextModelConfig;
  image: ImageModelConfig;
}

/** 保存时的校验：必填项、地址格式、画图沿用文本地址的前提 */
export const AiSettingsSchema = z
  .object({ text: TextConfigSchema, image: ImageConfigSchema })
  .superRefine(({ text, image }, ctx) => {
    if (!text.model) ctx.addIssue({ code: 'custom', message: '请填写文本模型的模型名称' });
    if (text.provider === 'openai-compatible' && !text.baseUrl) ctx.addIssue({ code: 'custom', message: 'OpenAI 兼容格式需要填写接口地址' });
    for (const url of [text.baseUrl, image.baseUrl]) {
      if (url && !HTTP_URL.test(url)) ctx.addIssue({ code: 'custom', message: `接口地址应以 http:// 或 https:// 开头：${url}` });
    }
    // 画图走 OpenAI 兼容接口：沿用文本模型的地址，只在文本模型也是这种格式时才说得通
    if (image.model && !image.baseUrl && text.provider !== 'openai-compatible') {
      ctx.addIssue({ code: 'custom', message: '文本模型不是 OpenAI 兼容格式时，画图模型需要单独填写接口地址' });
    }
  });

/** 页面提交的修改：只改传入的项；密钥不传表示不修改 */
export const AiSettingsPatchSchema = z.object({
  text: TextConfigSchema.partial().optional(),
  image: ImageConfigSchema.partial().optional(),
});
export type AiSettingsPatch = z.infer<typeof AiSettingsPatchSchema>;

const AI_SETTINGS_KEY = 'ai_settings';

/** .env 里的默认配置（没在设置页保存过时使用） */
export function aiSettingsFromEnv(env: NodeJS.ProcessEnv): AiSettings {
  const provider = TextConfigSchema.shape.provider.safeParse(env.MODEL_PROVIDER ?? 'openai-compatible');
  const effort = TextConfigSchema.shape.reasoningEffort.safeParse(env.MODEL_REASONING_EFFORT ?? '');
  return {
    text: {
      provider: provider.success ? provider.data : 'openai-compatible',
      baseUrl: env.MODEL_BASE_URL ?? '',
      model: env.MODEL_NAME ?? '',
      apiKey: env.MODEL_API_KEY ?? '',
      reasoningEffort: effort.success ? effort.data : '',
      structuredOutputs: env.MODEL_SUPPORTS_STRUCTURED_OUTPUTS !== 'false',
    },
    image: { model: env.IMAGE_MODEL_NAME ?? '', baseUrl: env.IMAGE_BASE_URL ?? '', apiKey: env.IMAGE_API_KEY ?? '' },
  };
}

export function readAiSettings(db: Executor, env: NodeJS.ProcessEnv = process.env): AiSettings {
  const row = db.select().from(appSettings).where(eq(appSettings.key, AI_SETTINGS_KEY)).get();
  const saved = z.object({ text: TextConfigSchema, image: ImageConfigSchema }).safeParse(row?.value);
  return saved.success ? saved.data : aiSettingsFromEnv(env);
}

/** 把修改合并到当前配置上（不保存），校验不通过时抛出 ZodError */
export function mergeAiSettings(current: AiSettings, patch: AiSettingsPatch): AiSettings {
  return AiSettingsSchema.parse({ text: { ...current.text, ...patch.text }, image: { ...current.image, ...patch.image } });
}

export function writeAiSettings(db: Executor, patch: AiSettingsPatch, now: Date, env: NodeJS.ProcessEnv = process.env): AiSettings {
  const next = mergeAiSettings(readAiSettings(db, env), patch);
  db.insert(appSettings)
    .values({ key: AI_SETTINGS_KEY, value: next, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: now } })
    .run();
  return next;
}

/** 给页面看的配置：密钥只显示是否已填和末 4 位 */
export function publicAiSettings({ text, image }: AiSettings) {
  const { apiKey: textKey, ...textRest } = text;
  const { apiKey: imageKey, ...imageRest } = image;
  return { text: { ...textRest, apiKeyHint: keyHint(textKey) }, image: { ...imageRest, apiKeyHint: keyHint(imageKey) } };
}

function keyHint(key: string): string | null {
  if (!key) return null;
  return key.length >= 12 ? `••••${key.slice(-4)}` : '已填写';
}

/**
 * 按当前配置提供模型：每次调用时读取最新配置，配置变了才重新构建。
 * 业务代码拿到的 model 和 illustrator 不变，设置页改完下一次调用就生效。
 */
export function createAiSource(db: Executor, env: NodeJS.ProcessEnv = process.env) {
  let text: { key: string; model: StructuredModel } | undefined;
  let image: { key: string; illustrator: Illustrator | undefined } | undefined;

  function textModel(): StructuredModel {
    const config = readAiSettings(db, env).text;
    const key = JSON.stringify(config);
    if (text?.key !== key) text = { key, model: modelFromConfig(config) };
    return text.model;
  }

  function illustrator(): Illustrator | undefined {
    const config = readAiSettings(db, env);
    const key = JSON.stringify([config.image, config.text.baseUrl, config.text.apiKey]);
    if (image?.key !== key) {
      try {
        image = { key, illustrator: illustratorFromConfig(config.image, config.text) };
      } catch (error) {
        // .env 里的画图配置不完整：当作没配置，讲解只用代码画的图
        console.warn(`画图模型配置不完整，暂不画插画：${(error as Error).message}`);
        image = { key, illustrator: undefined };
      }
    }
    return image.illustrator;
  }

  const model: StructuredModel = {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      return textModel().generate(request);
    },
  };

  return { model, illustrator };
}
