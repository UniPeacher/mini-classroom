import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAiSettings } from '../../src/ai-settings';
import { type Runtime, startRuntime } from '../../src/server/runtime';
import { readUserSettings } from '../../src/settings';
import { openDb } from '../../src/store/db';
import { topicDrafts } from '../../src/store/schema';

const directories: string[] = [];
const runtimes: Runtime[] = [];
const models: Array<{ server: Server; release: () => void }> = [];

afterEach(async () => {
  // 断言失败也要释放假模型，避免停止服务一直等待测试自身的暂停点。
  for (const model of models) model.release();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const model of models.splice(0)) {
    await new Promise<void>((resolve, reject) => model.server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weiketang-runtime-'));
  directories.push(directory);
  const webRoot = join(directory, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<html><title>微课堂</title><body>学习页面</body></html>');
  await writeFile(join(webRoot, 'assets/main.js'), 'console.log("微课堂");');
  await writeFile(join(directory, '.env'), 'MODEL_API_KEY=should-never-be-served');
  const options = { dbPath: join(directory, 'data', 'learning.sqlite'), port: 0, webRoot, env };
  const runtime = await startRuntime(options);
  runtimes.push(runtime);
  return { runtime, options, directory };
}

/** 提供可暂停的本机模型，检验真实 HTTP 请求与异步落库的先后关系。 */
async function localModel() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let markRequested!: () => void;
  const requested = new Promise<void>(resolve => { markRequested = resolve; });
  const requests: Array<{ model: string; authorization: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
    requests.push({ model: payload.model, authorization: request.headers.authorization });
    markRequested();
    await waiting;
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'local-test', object: 'chat.completion', created: 1, model: 'local-test',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ reply: '本机测试回复', brief: null }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  models.push({ server, release });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本机假模型未取得监听端口');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requested, requests, release };
}

describe('安装版的独立本机服务', () => {
  it('无需前端开发服务器即可在系统分配的端口提供页面、资源和接口', async () => {
    const { runtime } = await setup();
    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(`${runtime.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('学习页面');
    expect(await (await fetch(`${runtime.url}/assets/main.js`)).text()).toContain('微课堂');
    expect(await (await fetch(`${runtime.url}/api/health`)).json()).toEqual({ ok: true, devMode: false });
  });

  it('只提供页面目录，不把未知接口、配置或路径穿越变成可读文件', async () => {
    const { runtime } = await setup();
    for (const path of ['/api/missing', '/.env', '/data/learning.sqlite', '/%2e%2e/.env', '/assets/..%5c..%5c.env']) {
      const response = await fetch(`${runtime.url}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain('should-never-be-served');
    }
    expect((await fetch(`${runtime.url}/api/health`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(`${runtime.url}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });

  it('保存设置后关闭再启动仍能读取，关闭服务后不残留监听', async () => {
    const { runtime, options } = await setup();
    const saved = await fetch(`${runtime.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: runtime.url },
      body: JSON.stringify({ sessionMinutes: 17 }),
    });
    expect(saved.status).toBe(200);
    await runtime.stop();
    await runtime.stop();
    expect(runtime.db.$client.open).toBe(false);
    await expect(fetch(`${runtime.url}/api/health`)).rejects.toThrow();
    expect((await readFile(options.dbPath)).length).toBeGreaterThan(0);
    const restarted = await startRuntime(options);
    runtimes.push(restarted);
    const response = await (await fetch(`${restarted.url}/api/settings`)).json() as { settings: { sessionMinutes: number } };
    expect(response.settings.sessionMinutes).toBe(17);
  });

  it('浏览器断开请求后，停止服务仍等待已开始的模型回复落库', async () => {
    const model = await localModel();
    const { runtime, options } = await setup({
      MODEL_PROVIDER: 'openai-compatible', MODEL_BASE_URL: model.baseUrl, MODEL_NAME: 'local-review-model', MODEL_API_KEY: 'test-key',
    });
    const draftResponse = await fetch(`${runtime.url}/api/topic-drafts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea: '学习如何阅读代码' }),
    });
    expect(draftResponse.status).toBe(201);
    const draft = await draftResponse.json() as { id: string };
    const controller = new AbortController();
    const request = fetch(`${runtime.url}/api/topic-drafts/${draft.id}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0 }), signal: controller.signal,
    });
    // 先注册失败处理，再模拟用户关闭窗口，避免产生未处理的拒绝。
    const disconnected = request.catch(() => undefined);
    await model.requested;
    controller.abort();
    await disconnected;

    const stopped = runtime.stop();
    expect(await Promise.race([stopped.then(() => 'stopped'), delay(100, 'waiting')])).toBe('waiting');
    expect(runtime.db.$client.open).toBe(true);

    model.release();
    await stopped;
    expect(runtime.db.$client.open).toBe(false);
    await expect(fetch(`${runtime.url}/api/health`)).rejects.toThrow();
    const reopened = openDb(options.dbPath);
    try {
      const saved = reopened.select().from(topicDrafts).get();
      expect(saved).toMatchObject({ id: draft.id, revision: 1 });
      expect(saved?.messages).toEqual([
        { role: 'user', content: '学习如何阅读代码' },
        { role: 'assistant', content: '本机测试回复', brief: null },
      ]);
    } finally {
      reopened.$client.close();
    }
  });

  it.each(['显式环境', '空环境'])('%s的设置页读写和模型测试不会混入进程环境', async (mode) => {
    const model = await localModel();
    model.release();
    const inherited = {
      MODEL_PROVIDER: 'openai-compatible', MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'inherited-model',
      MODEL_API_KEY: 'inherited-secret-9876', MODEL_REASONING_EFFORT: 'high', MODEL_SUPPORTS_STRUCTURED_OUTPUTS: 'false',
      IMAGE_MODEL_NAME: 'inherited-image', IMAGE_BASE_URL: 'http://127.0.0.1:1/v1', IMAGE_API_KEY: 'inherited-image-secret',
      SESSION_BUDGET_SECONDS: '1800', MAX_NEW_PER_SESSION: '5',
    };
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    const explicit = mode === '显式环境';
    const env: NodeJS.ProcessEnv = explicit ? {
      MODEL_PROVIDER: 'openai-compatible', MODEL_BASE_URL: model.baseUrl, MODEL_NAME: 'runtime-model',
      MODEL_API_KEY: 'runtime-secret-1234', MODEL_REASONING_EFFORT: 'low', SESSION_BUDGET_SECONDS: '720', MAX_NEW_PER_SESSION: '3',
    } : {};
    const { runtime } = await setup(env);
    const initialAi = await (await fetch(`${runtime.url}/api/settings/ai`)).json();
    expect(initialAi.text).toMatchObject({
      model: explicit ? 'runtime-model' : '', baseUrl: explicit ? model.baseUrl : '',
      apiKeyHint: explicit ? '••••1234' : null, reasoningEffort: explicit ? 'low' : '', structuredOutputs: true,
    });
    expect(initialAi.image).toMatchObject({ model: '', baseUrl: '', apiKeyHint: null });
    expect(initialAi.text).not.toHaveProperty('apiKey');
    const initialSettings = await (await fetch(`${runtime.url}/api/settings`)).json();
    expect(initialSettings.settings).toMatchObject({ sessionMinutes: explicit ? 12 : 10, maxNewPerSession: explicit ? 3 : 2 });

    const unsavedTest = await fetch(`${runtime.url}/api/settings/ai/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'text', patch: explicit ? {} : { text: { model: 'form-only-model', baseUrl: model.baseUrl } } }),
    });
    expect(await unsavedTest.json()).toMatchObject({ ok: true, message: '模型回复：本机测试回复' });
    expect(model.requests).toEqual([{
      model: explicit ? 'runtime-model' : 'form-only-model', authorization: explicit ? 'Bearer runtime-secret-1234' : undefined,
    }]);
    // 测试连接不应把表单内容或继承环境写进数据库。
    expect(readAiSettings(runtime.db, {}).text.model).toBe('');

    // 页面只提交修改的字段，其余设置应保留当前运行环境的默认值。
    const savedSettings = await fetch(`${runtime.url}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxNewPerSession: 4 }),
    });
    expect(savedSettings.status).toBe(200);
    expect(readUserSettings(runtime.db, {})).toMatchObject({ sessionMinutes: explicit ? 12 : 10, maxNewPerSession: 4 });
    const savedAi = await fetch(`${runtime.url}/api/settings/ai`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: { model: 'user-saved-model', ...(explicit ? {} : { baseUrl: model.baseUrl }) } }),
    });
    expect(savedAi.status).toBe(200);
    expect(readAiSettings(runtime.db, {}).text).toMatchObject({
      model: 'user-saved-model', baseUrl: model.baseUrl, apiKey: explicit ? 'runtime-secret-1234' : '',
      reasoningEffort: explicit ? 'low' : '', structuredOutputs: true,
    });
    expect(readAiSettings(runtime.db, {}).image).toEqual({ model: '', baseUrl: '', apiKey: '' });

    const tested = await fetch(`${runtime.url}/api/settings/ai/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'text' }),
    });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, message: '模型回复：本机测试回复' });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual({ model: 'user-saved-model', authorization: explicit ? 'Bearer runtime-secret-1234' : undefined });
    const currentAi = await (await fetch(`${runtime.url}/api/settings/ai`)).json();
    expect(currentAi.text.model).toBe('user-saved-model');
  });
});
