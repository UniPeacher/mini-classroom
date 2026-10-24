/**
 * 以最多 limit 个并发执行任务。单个任务失败不会中断其他任务，全部结束后按原顺序返回各自结果。
 */
export async function settleWithLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, lane));
  return results;
}
