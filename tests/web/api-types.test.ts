import { describe, expectTypeOf, it } from 'vitest';
import type { Jsonify, Session, Topic } from '../../src/web/api';

// 类型断言由 pnpm typecheck 检查；运行时这里没有实际逻辑
describe('前端接口类型', () => {
  it('日期字段在前端是字符串', () => {
    expectTypeOf<Topic['createdAt']>().toEqualTypeOf<string>();
  });

  it('数组、可空值与嵌套对象保持原有结构', () => {
    expectTypeOf<Jsonify<{ at: Date; list: Date[]; maybe: Date | null }>>().toEqualTypeOf<{
      at: string;
      list: string[];
      maybe: string | null;
    }>();
    expectTypeOf<Session['items'][number]['question']['type']>().toEqualTypeOf<'mcq' | 'short_answer'>();
  });
});
