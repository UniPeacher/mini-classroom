/** 学习节奏相关的可配置参数 */
export interface Settings {
  /** 一节微课堂的时间预算（秒） */
  budgetSeconds: number;
  /** 每节最多引入的新知识点数 */
  maxNewPerSession: number;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    budgetSeconds: Number(env.SESSION_BUDGET_SECONDS ?? 600),
    maxNewPerSession: Number(env.MAX_NEW_PER_SESSION ?? 2),
  };
}
