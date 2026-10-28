import type { Illustrator, StructuredModel } from '../ai/gateway';
import type { Settings } from '../settings';
import type { Db } from '../store/db';
import { createAsking } from './asking';
import { createIllustrations } from './illustrations';
import { createKnowledge } from './knowledge';
import { createLearning } from './learning';
import { createOrganization } from './organization';
import { createPlacement } from './placement';
import { createPreferences } from './preferences';
import { createTopicPlanning } from './topic-planning';

export interface ServiceDeps {
  db: Db;
  model: StructuredModel;
  /** 每次读取最新设置 */
  settings: () => Settings;
  /** 按当前配置取画插画的模型；没有配置（或不传）时讲解只用代码画的图 */
  illustrator?: () => Illustrator | undefined;
  /** 与模型执行器一致的环境默认值；安装版显式传入空对象。 */
  env?: NodeJS.ProcessEnv;
}

/** 接口层用到的全部业务模块 */
export function createServices(deps: ServiceDeps) {
  return {
    learning: createLearning(deps),
    topicPlanning: createTopicPlanning(deps),
    knowledge: createKnowledge(deps),
    placement: createPlacement(deps),
    preferences: createPreferences(deps),
    asking: createAsking(deps),
    illustrations: createIllustrations(deps),
    organization: createOrganization({ db: deps.db, settings: deps.settings }),
  };
}

export type Services = ReturnType<typeof createServices>;
