import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CapturedHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface TestHttpServer {
  readonly baseUrl: string;
  readonly requests: readonly CapturedHttpRequest[];
  close(): Promise<void>;
}

export async function startJsonTestServer(
  handler: (
    request: CapturedHttpRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<TestHttpServer> {
  const requests: CapturedHttpRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      await new Promise<void>((resolve, reject) => {
        req.on('end', () => resolve());
        req.on('error', reject);
      });

      const captured: CapturedHttpRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      requests.push(captured);
      await handler(captured, res);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to start test HTTP server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
