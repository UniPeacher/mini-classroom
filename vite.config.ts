import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    // 开发时把接口请求转发给本地服务端
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
