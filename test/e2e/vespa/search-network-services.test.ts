import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeVespaTestServer,
  createVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { startFakeMlService, type FakeMlService } from './helpers/fake-ml-service.js';
import {
  parseSearchResponse,
  postJson,
} from '../helpers/http-transport.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

const OPUS_ONE_2018_ID = createEntityId('opus-one-2018');

describe.skipIf(!HAS_REACHABLE_VESPA)('Vespa E2E — external ML services', () => {
  let server: VespaTestServer;
  let fakeMlService: FakeMlService;

  beforeAll(async () => {
    fakeMlService = await startFakeMlService();
    server = await createVespaTestServer({
      mlServiceBaseUrl: fakeMlService.baseUrl,
      rerankThreshold: 1,
    });

    await server.parts.seedAlias('오푸스원', OPUS_ONE_2018_ID, 0.99);
  });

  beforeEach(() => {
    fakeMlService.clearRequests();
    fakeMlService.clearFailures();
  });

  afterAll(async () => {
    await closeVespaTestServer(server);
    await fakeMlService.close();
  });

  it('hybrid search hits embedding and reranker services over real HTTP', async () => {
    const response = await postJson(server.app, '/v1/search', {
      query: '샴페인 와인 추천',
      options: {
        mode: 'hybrid',
        explain: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.results.length).toBeGreaterThan(0);

    expect(fakeMlService.countRequests('/embeddings')).toBeGreaterThan(0);
    expect(fakeMlService.countRequests('/rerank')).toBeGreaterThan(0);

    const embeddingRequest = fakeMlService.requests.find((request) => request.url === '/embeddings');
    expect(embeddingRequest).toBeDefined();
    expect(JSON.parse(embeddingRequest!.body)).toEqual(
      expect.objectContaining({
        model: 'vespa-e2e-test',
      }),
    );

    const rerankRequest = fakeMlService.requests.find((request) => request.url === '/rerank');
    expect(rerankRequest).toBeDefined();
    expect(JSON.parse(rerankRequest!.body)).toEqual(
      expect.objectContaining({
        query: expect.any(String),
        texts: expect.any(Array),
      }),
    );
  });

  it('entity-mode search hits learned matcher over real HTTP once candidates are hydrated', async () => {
    const response = await postJson(server.app, '/v1/search', {
      query: '오푸스원',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.engine_decision.decision_status).toMatch(/^(resolved|ambiguous)$/);

    expect(fakeMlService.countRequests('/match')).toBeGreaterThan(0);

    const matchRequest = fakeMlService.requests.find((request) => request.url === '/match');
    expect(matchRequest).toBeDefined();
    expect(JSON.parse(matchRequest!.body)).toEqual(
      expect.objectContaining({
        query: '오푸스원',
        candidates: [
          expect.objectContaining({
            entity_id: 'opus-one-2018',
            canonical_label: 'Opus One 2018',
          }),
        ],
        context: expect.objectContaining({
          anchor_lookup_strategies: expect.arrayContaining(['compact_exact']),
        }),
      }),
    );
  });

  it('hybrid search degrades gracefully when reranker returns 500', async () => {
    fakeMlService.setFailure('/rerank', 500, { error: 'reranker_down' });

    const response = await postJson(server.app, '/v1/search', {
      query: '샴페인 와인 추천',
      options: {
        mode: 'hybrid',
        explain: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.results.length).toBeGreaterThan(0);
    expect(fakeMlService.countRequests('/embeddings')).toBeGreaterThan(0);
    expect(fakeMlService.countRequests('/rerank')).toBeGreaterThan(0);
  });

  it('entity-mode search degrades gracefully when learned matcher returns 500', async () => {
    fakeMlService.setFailure('/match', 500, { error: 'matcher_down' });

    const response = await postJson(server.app, '/v1/search', {
      query: '오푸스원',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.engine_decision.decision_status).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(fakeMlService.countRequests('/match')).toBeGreaterThan(0);
  });
});
