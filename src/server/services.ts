import type { StructuredModel } from '../ai/gateway';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import { createAsking } from './asking';
import { createKnowledge } from './knowledge';
import { createLearning } from './learning';
import { createPlacement } from './placement';
import { createPreferences } from './preferences';

export interface ServiceDeps {
  db: Db;
  model: StructuredModel;
  /** 每次读取最新设置 */
  settings: () => Settings;
}

/** 接口层用到的全部业务模块 */
export function createServices(deps: ServiceDeps) {
  return {
    learning: createLearning(deps),
    knowledge: createKnowledge(deps),
    placement: createPlacement(deps),
    preferences: createPreferences(deps),
    asking: createAsking(deps),
  };
}

export type Services = ReturnType<typeof createServices>;
