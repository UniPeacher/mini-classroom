import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findAvailablePort, listenWithFallback } from '../src/server/listen';

const fetch = () => new Response('ok');
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

/** 占住一个端口，模拟被其他程序使用 */
function occupy(port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer().listen({ port, host, ipv6Only: false }, () => resolve());
    closers.push(() => server.close());
  });
}

describe('端口顺延', () => {
  it('首选端口空闲时直接使用', async () => {
    const { server, port } = await listenWithFallback({ fetch, hostname: '127.0.0.1', port: 46102 });
    closers.push(() => server.close());
    expect(port).toBe(46102);
  });

  it('首选端口被占用时顺延到下一个空闲端口', async () => {
    await occupy(46202);
    await occupy(46203);
    const { server, port } = await listenWithFallback({ fetch, hostname: '127.0.0.1', port: 46202 });
    closers.push(() => server.close());
    expect(port).toBe(46204);
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');
  });

  it('其他程序监听在所有地址上时，同样视为被占用，不抢占它的本机访问', async () => {
    await occupy(46402, '::');
    const { server, port } = await listenWithFallback({ fetch, hostname: '127.0.0.1', port: 46402 });
    closers.push(() => server.close());
    expect(port).toBe(46403);
  });

  it('顺延范围内都被占用时报错', async () => {
    await occupy(46302);
    await occupy(46303);
    await expect(listenWithFallback({ fetch, hostname: '127.0.0.1', port: 46302, maxShift: 1 })).rejects.toThrow('都被占用');
  });
});

describe('查找可用端口', () => {
  it('跳过被占用的端口（含监听在所有地址上的），返回第一个空闲端口', async () => {
    await occupy(46502);
    await occupy(46503, '::');
    expect(await findAvailablePort({ hostname: '127.0.0.1', port: 46502 })).toBe(46504);
  });
});
