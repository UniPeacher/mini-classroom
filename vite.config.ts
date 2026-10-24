import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Plugin, defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { findAvailablePort } from './src/server/listen.ts';

const RUN_DIR = join(process.cwd(), '.run');
// 与服务端一样只监听 127.0.0.1：localhost 在 macOS 上可能解析为 ::1，会和 127.0.0.1 上的同号端口并存而混淆
const HOST = '127.0.0.1';

/** 服务端实际监听的端口：优先读服务端写下的端口文件（端口可能已顺延），否则用 .env 中的首选端口 */
function serverPort(env: Record<string, string>): string {
  const file = join(RUN_DIR, 'server.port');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : (env.PORT ?? '6201');
}

/** 把前端实际监听的端口写入运行时目录，供启停脚本读取 */
function writePortFile(): Plugin {
  const file = join(RUN_DIR, 'web.port');
  return {
    name: 'write-port-file',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer!.address();
        if (address && typeof address === 'object') {
          mkdirSync(RUN_DIR, { recursive: true });
          writeFileSync(file, String(address.port));
        }
      });
      server.httpServer?.once('close', () => rmSync(file, { force: true }));
    },
  };
}

export default defineConfig(async ({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: 'src/web',
    plugins: [react(), writePortFile()],
    server: {
      host: HOST,
      // 首选 6101，被占用时顺延（用与服务端相同的判断，而不是 Vite 自带的绑定检测）
      port: command === 'serve' ? await findAvailablePort({ hostname: HOST, port: 6101 }) : 6101,
      strictPort: true,
      // 开发时把接口请求转发给本地服务端；需在服务端启动后再启动前端（start.sh 已保证顺序）
      // 规则带结尾斜杠：只转发 /api/ 下的接口，避免误伤 /api.ts 这类前端源码文件
      proxy: { '/api/': `http://${HOST}:${serverPort(env)}` },
    },
    build: { outDir: '../../dist/web', emptyOutDir: true },
  };
});
