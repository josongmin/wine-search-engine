import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';
import {
  closeVespaTestServer,
  createVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { startFakeMlService, type FakeMlService } from './helpers/fake-ml-service.js';
import { parseSearchResponse, postJson } from '../helpers/http-transport.js';

const OPUS_ONE_2018_ID = createEntityId('opus-one-2018');

describe.skipIf(!HAS_REACHABLE_VESPA)('Vespa E2E — smoke lane', () => {
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

  it('direct Vespa sparse search keeps Opus One in the top hits', async () => {
    const hits = await server.parts.vespaSearchIndex.sparseSearch(['Opus One 2018'], [], 5);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entityId).toBe(OPUS_ONE_2018_ID);
  });

  it('hybrid search returns results through the Vespa-backed HTTP stack', async () => {
    // Lane is chosen by the URL path; the body carries no `mode` (the monolith
    // `options.mode` control surface was removed — the strict primitive schema
    // 400s on it).
    const response = await postJson(server.app, '/v1/search/hybrid', {
      query: '샴페인 와인 추천',
      options: { explain: false, clarification: false },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.meta.route).toBe('hybrid');
    expect(body.results.length).toBeGreaterThan(0);
    // Embeddings no longer flow over the HTTP fake-ML service (HttpEmbeddingService
    // was removed in c4fba804). Assert the dense channel still ran via the
    // container-level counter. Cross-encoder rerank is intentionally NOT asserted
    // here: it is gate-controlled (evaluateRerankGate / enablePrecisionRerank) and
    // legitimately skipped for broad concept queries like this one.
    expect(server.parts.embeddingInvocations()).toBeGreaterThan(0);
  });

  it('entity-mode search stays wired to the learned matcher over HTTP', async () => {
    // `options.mode` is gone (strict 400); the entity/identity lane runs
    // automatically on the discovery route (dual-lane topology), so the learned
    // matcher is still exercised over HTTP.
    const response = await postJson(server.app, '/v1/search/hybrid', {
      query: '오푸스원',
      options: { explain: false, clarification: false },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.engine_decision.decision_status).toMatch(/^(resolved|ambiguous)$/);
    expect(fakeMlService.countRequests('/match')).toBeGreaterThan(0);
  });
});
