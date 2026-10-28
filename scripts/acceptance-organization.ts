import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app';
import { DAY1, createHarness } from '../tests/fixtures/harness';

const h = createHarness();
const application = createApp({ services: h.services, clock: () => DAY1, devMode: true, webRoot: resolve('dist/web') });
const server = serve({ fetch: application.fetch, hostname: '127.0.0.1', port: 0 });

server.on('listening', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`ORGANIZATION_ACCEPTANCE_URL=http://127.0.0.1:${address.port}`);
  console.log('ISOLATED_MEMORY_DATABASE=true; FAKE_MODEL=true; REAL_USER_DATA=false');
});

async function shutdown() {
  server.close(() => {
    h.db.$client.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

const initialTopics = ['液压系统压力与流量', '离散时间信号与采样', '西班牙语规则动词'];
for (const title of initialTopics) await h.startTopic(title);
console.log(`FIXTURE_READY=${initialTopics.length}`);

let running = false;
const workerTimer = setInterval(() => {
  if (running) return;
  running = true;
  h.worker.runUntilIdle().catch((error) => console.error('FIXTURE_WORKER_ERROR', error)).finally(() => { running = false; });
}, 500);
workerTimer.unref();
