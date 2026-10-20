import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 读取项目根目录的 .env，让接口转发跟随服务端端口
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = env.PORT ?? '6102';
  return {
    root: 'src/web',
    plugins: [react()],
    server: {
      port: 6101,
      strictPort: true,
      // 开发时把接口请求转发给本地服务端
      proxy: { '/api': `http://127.0.0.1:${serverPort}` },
    },
    build: { outDir: '../../dist/web', emptyOutDir: true },
  };
});
