import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/web/api';

const source = readFileSync(join(process.cwd(), 'src/web/screens/LearnScreen.tsx'), 'utf8');

/**
 * 进入学习页必然是"继续已有的那一节"。
 * 服务端要求显式 resume，否则会把这次请求当成未确认的隐式替换并拒绝（409），
 * 用户就会在刚点开始后立刻看到"已有一节没完成"的错误。
 */
describe('学习页恢复已有的一节', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('恢复请求显式带上 resume:true', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ session: null, resumed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    await api.nextSession({ resume: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ resume: true });
    // 明确继续时不能同时要求新建
    expect((bodies[0] as { fresh?: boolean }).fresh).toBeUndefined();
  });

  it('学习页的恢复调用不再是裸 nextSession()', () => {
    expect(source).toContain('api.nextSession({ resume: true })');
    // 裸调用会被服务端拒绝，源码里不应再出现
    expect(source).not.toMatch(/api\.nextSession\(\s*\)/);
  });
});
