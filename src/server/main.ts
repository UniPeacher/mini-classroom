import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRuntime } from './runtime';

if (existsSync('.env')) process.loadEnvFile('.env');

// 运行时文件目录：记录实际监听的端口，供前端转发和启停脚本读取
const RUN_DIR = '.run';
const PORT_FILE = join(RUN_DIR, 'server.port');
const WEB_PORT_FILE = join(RUN_DIR, 'web.port');

const preferredPort = Number(process.env.PORT ?? 6201);
const runtime = await startRuntime({
  dbPath: process.env.DB_PATH ?? 'data/weiketang.sqlite',
  port: preferredPort,
  devMode: process.env.DEV_MODE === 'true',
  // 前端端口可能已顺延，以前端写下的端口文件为准
  frontendUrl: () => (existsSync(WEB_PORT_FILE) ? `http://127.0.0.1:${readFileSync(WEB_PORT_FILE, 'utf8').trim()}` : null),
});

const { port } = runtime;
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(PORT_FILE, String(port));
const shifted = port === preferredPort ? '' : `（${preferredPort} 被占用，已顺延）`;
console.log(`微课堂服务已启动：http://127.0.0.1:${port}${shifted}`);

function shutdown() {
  rmSync(PORT_FILE, { force: true });
  void runtime.stop().then(() => process.exit(0)).catch((error) => {
    console.error('停止服务失败：', error);
    process.exit(1);
  });
  // 有长连接未断开时不无限等待
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
