import { connect, createServer } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';

export interface ListenOptions {
  fetch: (request: Request) => Response | Promise<Response>;
  hostname: string;
  /** 首选端口 */
  port: number;
  /** 首选端口被占用时，最多向后顺延几个端口 */
  maxShift?: number;
}

/** 监听首选端口；被占用时依次尝试下一个端口，返回实际监听的端口。 */
export async function listenWithFallback(options: ListenOptions): Promise<{ server: ServerType; port: number }> {
  const maxShift = options.maxShift ?? 20;
  for (let port = options.port; port <= options.port + maxShift; port++) {
    // 其他程序监听在所有地址（如 *:6201）时，系统仍允许再绑定更具体的 127.0.0.1:6201，
    // 结果会抢走对方的本机访问。所以先探测：本机这个端口已有程序响应，就视为被占用。
    if (await isAnswering(options.hostname, port)) continue;
    try {
      const server = await listenOnce(options, port);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('未能取得服务实际监听的端口');
      }
      return { server, port: address.port };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`端口 ${options.port}~${options.port + maxShift} 都被占用`);
}

/**
 * 找一个可用端口（首选端口被占用时顺延），供不能自己顺延的进程使用，例如前端开发服务器。
 * 判断标准与 listenWithFallback 相同：本机已有程序响应，或无法绑定，都视为被占用。
 */
export async function findAvailablePort(options: Omit<ListenOptions, 'fetch'>): Promise<number> {
  const maxShift = options.maxShift ?? 20;
  for (let port = options.port; port <= options.port + maxShift; port++) {
    if (await isAnswering(options.hostname, port)) continue;
    if (await canBind(options.hostname, port)) return port;
  }
  throw new Error(`端口 ${options.port}~${options.port + maxShift} 都被占用`);
}

function canBind(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, hostname, () => server.close(() => resolve(true)));
  });
}

/** 能否连上该端口（有程序在监听） */
function isAnswering(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port });
    const done = (answering: boolean) => {
      socket.destroy();
      resolve(answering);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function listenOnce(options: ListenOptions, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: options.fetch, port, hostname: options.hostname });
    server.once('error', (error) => {
      server.close();
      reject(error);
    });
    server.once('listening', () => resolve(server));
  });
}
