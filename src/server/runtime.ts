import { createAiSource } from '../ai-settings';
import { createHandlers } from '../jobs/handlers';
import { enqueue } from '../jobs/queue';
import { createWorker } from '../jobs/worker';
import { settingsSource } from '../settings';
import { openDb } from '../store/db';
import { createApp } from './app';
import { listenWithFallback } from './listen';
import { createServices } from './services';

export interface RuntimeOptions {
  dbPath: string;
  port: number;
  migrationsFolder?: string;
  webRoot?: string;
  frontendUrl?: () => string | null;
  devMode?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * 启动本机服务和后台任务，供源码版与安装版共用。
 *
 * Args:
 *   options: 数据与资源位置、监听端口和模型默认配置。
 *
 * Returns:
 *   实际地址、数据库和等待当前任务结束的停止方法。
 */
export async function startRuntime(options: RuntimeOptions) {
  const clock = () => new Date();
  const db = openDb(options.dbPath, options.migrationsFolder);
  const env = options.env ?? process.env;
  const { model, illustrator } = createAiSource(db, env);
  const settings = settingsSource(db, env);
  const worker = createWorker(db, createHandlers({ db, model, clock, settings, illustrator }), clock);
  const application = createApp({
    services: createServices({ db, model, settings, illustrator, env }),
    clock,
    devMode: options.devMode ?? false,
    frontendUrl: options.frontendUrl,
    webRoot: options.webRoot,
  });

  const activeRequests = new Set<Promise<Response>>();
  const handleRequest = (request: Request): Promise<Response> => {
    const pending = Promise.resolve(application.fetch(request));
    activeRequests.add(pending);
    return pending.finally(() => activeRequests.delete(pending));
  };

  let listening;
  try {
    listening = await listenWithFallback({ fetch: handleRequest, hostname: '127.0.0.1', port: options.port });
  } catch (error) {
    db.$client.close();
    throw error;
  }
  const { server, port } = listening;
  const refreshPool = () => enqueue(db, 'fill_pool', {}, clock(), { dedupe: true });
  refreshPool();
  worker.start();
  const refreshTimer = setInterval(refreshPool, 3600 * 1000);
  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    if (stopping) return stopping;
    clearInterval(refreshTimer);
    stopping = (async () => {
      const idle = worker.stop();
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      // 连接断开不等于模型回复已落库；停止接收请求后等所有业务调用完成。
      await closed;
      const settled = await Promise.allSettled([idle, ...activeRequests]);
      db.$client.close();
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return stopping;
  }

  return { db, port, url: `http://127.0.0.1:${port}`, stop };
}

export type Runtime = Awaited<ReturnType<typeof startRuntime>>;
