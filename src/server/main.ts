import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { openDb } from '../store/db';
import { createApp } from './app';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT ?? 8787);
openDb(process.env.DB_PATH ?? 'data/weiketang.sqlite');
const app = createApp();

// 只监听本机（第一版不做登录）
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`微课堂服务已启动：http://127.0.0.1:${info.port}`);
});
