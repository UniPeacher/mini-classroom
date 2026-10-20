import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { modelFromEnv } from '../ai/gateway';
import { createHandlers } from '../jobs/handlers';
import { enqueue } from '../jobs/queue';
import { createWorker } from '../jobs/worker';
import { loadSettings } from '../settings';
import { openDb } from '../store/db';
import { createApp } from './app';
import { createLearning } from './learning';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT ?? 8787);
const clock = () => new Date();
const db = openDb(process.env.DB_PATH ?? 'data/weiketang.sqlite');
const model = modelFromEnv();
const settings = loadSettings();

const worker = createWorker(db, createHandlers({ db, model, clock, settings }), clock);
worker.start();

// 长时间没学习时，候选池里可能缺少新到期复习的内容：启动时和每小时各补一次
const POOL_REFRESH_MS = 3600 * 1000;
const refreshPool = () => enqueue(db, 'fill_pool', {}, clock(), { dedupe: true });
refreshPool();
setInterval(refreshPool, POOL_REFRESH_MS);

const learning = createLearning({ db, model, settings });
const app = createApp({ learning, clock, devMode: process.env.DEV_MODE === 'true' });

// 只监听本机（第一版不做登录）
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`微课堂服务已启动：http://127.0.0.1:${info.port}`);
});
