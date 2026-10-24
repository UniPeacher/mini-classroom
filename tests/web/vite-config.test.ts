import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

/** 按 Vite 的规则判断请求路径会不会被转发：以 ^ 开头的键按正则匹配，其余按前缀匹配 */
function isProxied(proxy: Record<string, unknown>, path: string): boolean {
  return Object.keys(proxy).some((key) => (key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key)));
}

describe('前端开发服务器的接口转发', async () => {
  const resolved = await (config as (env: { mode: string; command: 'build' }) => Promise<any>)({ mode: 'test', command: 'build' });
  const proxy = resolved.server.proxy as Record<string, unknown>;

  it('接口请求转发给服务端', () => {
    expect(isProxied(proxy, '/api/health')).toBe(true);
    expect(isProxied(proxy, '/api/sessions/next')).toBe(true);
  });

  it('前端自己的源码文件不被转发（如 /api.ts），否则页面白屏', () => {
    expect(isProxied(proxy, '/api.ts')).toBe(false);
    expect(isProxied(proxy, '/main.tsx')).toBe(false);
  });
});
