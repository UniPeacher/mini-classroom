import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiSettingsFromEnv, createAiSource, publicAiSettings, readAiSettings, writeAiSettings } from '../src/ai-settings';
import { openDb } from '../src/store/db';
import { DAY1, createHarness } from './fixtures/harness';

const ENV = {
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:8317/v1',
  MODEL_NAME: 'gpt-5.6-sol',
  MODEL_API_KEY: 'sk-env-secret-0001',
  MODEL_REASONING_EFFORT: 'medium',
  IMAGE_MODEL_NAME: 'gpt-image-2',
};
const SECRET = 'sk-saved-secret-9876';

describe('AI 模型配置：文本和画图分别配置，没保存过时用 .env', () => {
  it('.env 映射为默认配置；没有的项为空，不认识的供应商退回 OpenAI 兼容', () => {
    expect(aiSettingsFromEnv(ENV)).toEqual({
      text: { provider: 'openai-compatible', baseUrl: 'http://localhost:8317/v1', model: 'gpt-5.6-sol', apiKey: 'sk-env-secret-0001', reasoningEffort: 'medium', structuredOutputs: true },
      image: { model: 'gpt-image-2', baseUrl: '', apiKey: '' },
    });
    expect(aiSettingsFromEnv({ MODEL_PROVIDER: 'other', MODEL_SUPPORTS_STRUCTURED_OUTPUTS: 'false' }).text).toMatchObject({ provider: 'openai-compatible', model: '', structuredOutputs: false });
  });

  it('保存后以设置页为准；只改传入的项，不传密钥时保留原密钥', () => {
    const db = openDb(':memory:');
    expect(readAiSettings(db, ENV)).toEqual(aiSettingsFromEnv(ENV));

    writeAiSettings(db, { text: { model: 'gpt-6-sol' }, image: { model: '' } }, DAY1, ENV);
    const saved = readAiSettings(db, ENV);
    expect(saved.text).toMatchObject({ model: 'gpt-6-sol', apiKey: 'sk-env-secret-0001', baseUrl: 'http://localhost:8317/v1' });
    expect(saved.image.model).toBe('');

    writeAiSettings(db, { image: { model: 'gpt-image-2', apiKey: SECRET } }, DAY1, ENV);
    expect(readAiSettings(db, ENV).image).toEqual({ model: 'gpt-image-2', baseUrl: '', apiKey: SECRET });
    // .env 改了也不影响已保存的配置
    expect(readAiSettings(db, { ...ENV, MODEL_NAME: 'changed' }).text.model).toBe('gpt-6-sol');
  });

  it('保存前校验：模型名必填、OpenAI 兼容要地址、地址格式、画图沿用地址的前提', () => {
    const db = openDb(':memory:');
    const fails = (patch: Parameters<typeof writeAiSettings>[1], message: string) => {
      expect(() => writeAiSettings(db, patch, DAY1, ENV)).toThrow(z.ZodError);
      try {
        writeAiSettings(db, patch, DAY1, ENV);
      } catch (error) {
        expect((error as z.ZodError).issues.map((i) => i.message).join('；')).toContain(message);
      }
    };
    fails({ text: { model: ' ' } }, '模型名称');
    fails({ text: { baseUrl: '' } }, '需要填写接口地址');
    fails({ text: { baseUrl: 'localhost:8317' } }, 'http://');
    fails({ text: { provider: 'anthropic', baseUrl: '' } }, '画图模型需要单独填写接口地址');
    // 校验失败时什么都不保存
    expect(readAiSettings(db, ENV)).toEqual(aiSettingsFromEnv(ENV));
    // Anthropic 不填地址（用官方地址）、画图单独填地址是合法的
    writeAiSettings(db, { text: { provider: 'anthropic', baseUrl: '' }, image: { baseUrl: 'https://images.example.com/v1' } }, DAY1, ENV);
    expect(readAiSettings(db, ENV).text.provider).toBe('anthropic');
  });

  it('给页面的配置不含密钥，只有末 4 位提示', () => {
    const view = publicAiSettings({ ...aiSettingsFromEnv(ENV), image: { model: 'gpt-image-2', baseUrl: '', apiKey: 'short' } });
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-env-secret-0001');
    expect(json).not.toContain('short');
    expect(view.text.apiKeyHint).toBe('••••0001');
    expect(view.image.apiKeyHint).toBe('已填写');
    expect(publicAiSettings(aiSettingsFromEnv({})).text.apiKeyHint).toBeNull();
  });
});

describe('按当前配置提供模型：改完下一次调用就生效', () => {
  it('没配置文本模型时调用会说明原因；画图模型名为空时不画插画，配上后立即可用', async () => {
    const db = openDb(':memory:');
    const ai = createAiSource(db, {});
    await expect(ai.model.generate({ name: 't', schema: z.object({}), system: '', prompt: '' })).rejects.toThrow('模型名称');
    expect(ai.illustrator()).toBeUndefined();

    writeAiSettings(db, { text: { baseUrl: 'http://localhost:8317/v1', model: 'm' }, image: { model: 'gpt-image-2' } }, DAY1, {});
    const illustrator = ai.illustrator();
    expect(illustrator?.draw).toBeTypeOf('function');
    // 配置没变时沿用同一个实例
    expect(ai.illustrator()).toBe(illustrator);

    writeAiSettings(db, { image: { model: '' } }, DAY1, {});
    expect(ai.illustrator()).toBeUndefined();
  });
});

describe('AI 配置接口', () => {
  it('读取不回传密钥；保存不合法时返回 400 和原因；保存后返回新配置', async () => {
    const { call } = createHarness();
    const saved = await call('PUT', '/api/settings/ai', { text: { provider: 'openai-compatible', baseUrl: 'http://localhost:8317/v1', model: 'gpt-5.6-sol', apiKey: SECRET } });
    expect(saved.status).toBe(200);
    expect(saved.body.text).toMatchObject({ model: 'gpt-5.6-sol', apiKeyHint: '••••9876' });

    const read = await call('GET', '/api/settings/ai');
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
    expect(read.body.text).not.toHaveProperty('apiKey');

    const bad = await call('PUT', '/api/settings/ai', { text: { model: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('模型名称');
  });

  it('测试用表单里的配置、不保存；配置有问题时直接说明，不调用模型', async () => {
    const { call } = createHarness();
    await call('PUT', '/api/settings/ai', { text: { baseUrl: 'http://localhost:8317/v1', model: 'gpt-5.6-sol' }, image: { model: '' } });

    const noImage = (await call('POST', '/api/settings/ai/test', { target: 'image', patch: {} })).body;
    expect(noImage).toMatchObject({ ok: false, message: '还没有填写画图模型的模型名称' });
    const invalid = (await call('POST', '/api/settings/ai/test', { target: 'text', patch: { text: { baseUrl: 'not-a-url' } } })).body;
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain('http://');
    // 测试不保存
    expect((await call('GET', '/api/settings/ai')).body.text.baseUrl).toBe('http://localhost:8317/v1');
  });
});
