import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAiSource } from '../ai-settings';
import { createHandlers } from '../jobs/handlers';
import { enqueue } from '../jobs/queue';
import { createWorker } from '../jobs/worker';
import { settingsSource } from '../settings';
import { openDb } from '../store/db';
import { createApp } from './app';
import { listenWithFallback } from './listen';
import { createServices } from './services';

if (existsSync('.env')) process.loadEnvFile('.env');

// 运行时文件目录：记录实际监听的端口，供前端转发和启停脚本读取
const RUN_DIR = '.run';
const PORT_FILE = join(RUN_DIR, 'server.port');
const WEB_PORT_FILE = join(RUN_DIR, 'web.port');

const clock = () => new Date();
const db = openDb(process.env.DB_PATH ?? 'data/weiketang.sqlite');
// AI 模型按设置页的配置（没保存过时用 .env）提供，改完立即生效
const { model, illustrator } = createAiSource(db);
const settings = settingsSource(db);

const worker = createWorker(db, createHandlers({ db, model, clock, settings, illustrator }), clock);
worker.start();

// 长时间没学习时，候选池里可能缺少新到期复习的内容：启动时和每小时各补一次
const POOL_REFRESH_MS = 3600 * 1000;
const refreshPool = () => enqueue(db, 'fill_pool', {}, clock(), { dedupe: true });
refreshPool();
const refreshTimer = setInterval(refreshPool, POOL_REFRESH_MS);

const app = createApp({
  services: createServices({ db, model, settings, illustrator }),
  clock,
  devMode: process.env.DEV_MODE === 'true',
  // 前端端口可能已顺延，以前端写下的端口文件为准
  frontendUrl: () => (existsSync(WEB_PORT_FILE) ? `http://127.0.0.1:${readFileSync(WEB_PORT_FILE, 'utf8').trim()}` : null),
});

// 只监听本机（第一版不做登录）；首选端口被占用时自动顺延
const preferredPort = Number(process.env.PORT ?? 6201);
const { server, port } = await listenWithFallback({ fetch: app.fetch, hostname: '127.0.0.1', port: preferredPort });
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(PORT_FILE, String(port));
const shifted = port === preferredPort ? '' : `（${preferredPort} 被占用，已顺延）`;
console.log(`微课堂服务已启动：http://127.0.0.1:${port}${shifted}`);

function shutdown() {
  worker.stop();
  clearInterval(refreshTimer);
  rmSync(PORT_FILE, { force: true });
  server.close(() => process.exit(0));
  // 有长连接未断开时不无限等待
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
