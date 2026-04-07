import { startJsonTestServer, type TestHttpServer } from '../../../unit/infrastructure/http-service-test-server.js';

export interface FakeMlService extends TestHttpServer {
  countRequests(pathname: string): number;
  clearRequests(): void;
  setFailure(pathname: string, statusCode: number, body?: Record<string, unknown>): void;
  clearFailures(): void;
  setDelay(pathname: string, durationMs: number): void;
  clearDelays(): void;
}

function buildEmbeddingVector(seed: string): number[] {
  const normalized = seed.toLowerCase();
  return Array.from({ length: 1024 }, (_, index) => {
    const codePoint = normalized.codePointAt(index % Math.max(normalized.length, 1)) ?? 0;
    const base = ((codePoint % 97) + 1) / 100;
    return Number((base + index / 10_000).toFixed(6));
  });
}

function toStringInput(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export async function startFakeMlService(): Promise<FakeMlService> {
  const failures = new Map<string, { statusCode: number; body: Record<string, unknown> }>();
  const delays = new Map<string, number>();
  const server = await startJsonTestServer(async (request, response) => {
    const configuredDelay = delays.get(request.url);
    if (configuredDelay !== undefined && configuredDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, configuredDelay));
    }

    const configuredFailure = failures.get(request.url);
    if (configuredFailure !== undefined) {
      response.statusCode = configuredFailure.statusCode;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(configuredFailure.body));
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');

    const body = JSON.parse(request.body || '{}') as Record<string, unknown>;

    if (request.url === '/embeddings') {
      const inputs = Array.isArray(body['input'])
        ? (body['input'] as unknown[]).map((value) => String(value))
        : [toStringInput(body['input'], '')];

      response.end(JSON.stringify({
        object: 'list',
        data: inputs.map((input, index) => ({
          object: 'embedding',
          index,
          embedding: buildEmbeddingVector(input),
        })),
        model: toStringInput(body['model'], 'vespa-e2e-test'),
      }));
      return;
    }

    if (request.url === '/rerank') {
      const texts = Array.isArray(body['texts'])
        ? (body['texts'] as unknown[]).map((value) => String(value))
        : [];

      response.end(JSON.stringify({
        results: texts.map((text, index) => ({
          index,
          score: Math.max(0, 1 - index * 0.05) + (text.toLowerCase().includes('champagne') ? 0.1 : 0),
        })),
      }));
      return;
    }

    if (request.url === '/match') {
      const candidates = Array.isArray(body['candidates'])
        ? (body['candidates'] as Array<Record<string, unknown>>)
        : [];
      const firstCandidate = candidates[0];

      response.end(JSON.stringify({
        results: firstCandidate === undefined
          ? []
          : [
              {
                entity_id: typeof firstCandidate['entity_id'] === 'string'
                  ? firstCandidate['entity_id']
                  : 'unknown-entity',
                match_probability: 0.92,
                model_id: 'fake-learned-matcher',
                model_version: 'test-v1',
                match_signal_vector: [0.92, 0.37, 0.11],
              },
            ],
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: `Unhandled fake ML route: ${request.url}` }));
  });

  return {
    ...server,
    countRequests(pathname: string): number {
      return server.requests.filter((request) => request.url === pathname).length;
    },
    clearRequests(): void {
      (server.requests as Array<unknown>).length = 0;
    },
    setFailure(pathname: string, statusCode: number, body: Record<string, unknown> = { error: 'forced_failure' }): void {
      failures.set(pathname, { statusCode, body });
    },
    clearFailures(): void {
      failures.clear();
    },
    setDelay(pathname: string, durationMs: number): void {
      delays.set(pathname, durationMs);
    },
    clearDelays(): void {
      delays.clear();
    },
  };
}
