import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { createHarness } from '../fixtures/harness';

afterEach(() => vi.restoreAllMocks());

describe('本机接口的请求边界', () => {
  it.each(['https://attacker.invalid', 'null', 'http://localhost.attacker.invalid:6101'])('拒绝外部来源 %s，且不写入主题', async (origin) => {
    const { app, call } = createHarness();
    const response = await app.request('/api/topics', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ title: '不应保存' }),
    });
    expect(response.status).toBe(403);
    expect((await call('GET', '/api/topics')).body.topics).toEqual([]);
  });

  it('跨站模型测试不能调用模型或携带已有密钥访问外部地址', async () => {
    const { app, services } = createHarness();
    const testAi = vi.spyOn(services.preferences, 'testAi');
    const response = await app.request('/api/settings/ai/test', {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'text', patch: { text: { baseUrl: 'https://attacker.invalid/v1' } } }),
    });
    expect(response.status).toBe(403);
    expect(testAi).not.toHaveBeenCalled();
  });

  it('拒绝 DNS 重绑定域名和伪造的 Host', async () => {
    const { app } = createHarness();
    expect((await app.request('http://attacker.invalid:6201/api/topics')).status).toBe(403);
    expect((await app.request('/api/topics', { headers: { Host: 'attacker.invalid:6201' } })).status).toBe(403);
  });

  it('没有 Origin 但标记为跨站的读取也不能访问个人数据', async () => {
    const { app } = createHarness();
    const response = await app.request('/api/map', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(response.status).toBe(403);
  });

  it('只接受 JSON 请求体，拒绝简单表单和 text/plain', async () => {
    const { app, call } = createHarness();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await app.request('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify({ title: '不应保存' }),
      });
      expect(response.status).toBe(415);
    }
    expect((await call('GET', '/api/topics')).body.topics).toEqual([]);
  });

  it('允许本机命令行与同源页面的 JSON 请求', async () => {
    const { app } = createHarness();
    expect((await app.request('/api/health')).status).toBe(200);
    const response = await app.request('http://127.0.0.1:6201/api/topics', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:6201', 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title: '本机学习' }),
    });
    expect(response.status).toBe(201);
  });

  it('允许实际前端端口顺延后的请求，但不放行其他本机网页', async () => {
    const { services } = createHarness();
    const app = createApp({ services, clock: () => new Date(), devMode: false, frontendUrl: () => 'http://127.0.0.1:6117' });
    for (const [origin, status] of [['http://127.0.0.1:6117', 200], ['http://127.0.0.1:6118', 403]] as const) {
      const response = await app.request('http://127.0.0.1:6201/api/topics', { headers: { Origin: origin } });
      expect(response.status).toBe(status);
    }
  });

  it('Vite 代理保留前端 Host 时仍可同源调用', async () => {
    const { app } = createHarness();
    const response = await app.request('http://127.0.0.1:6117/api/topics', {
      headers: { Host: '127.0.0.1:6117', Origin: 'http://127.0.0.1:6117' },
    });
    expect(response.status).toBe(200);
  });
});
