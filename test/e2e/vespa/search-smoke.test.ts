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
    const response = await postJson(server.app, '/v1/search', {
      query: '샴페인 와인 추천',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);
    expect(body.meta.route).toBe('hybrid');
    expect(body.results.length).toBeGreaterThan(0);
    expect(fakeMlService.countRequests('/embeddings')).toBeGreaterThan(0);
    expect(fakeMlService.countRequests('/rerank')).toBeGreaterThan(0);
  });

  it('resolve route stays wired to the learned matcher over HTTP', async () => {
    const response = await postJson(server.app, '/v1/entity/resolve', {
      query: '오푸스원',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        status: expect.any(String),
      }),
    );
    expect(fakeMlService.countRequests('/match')).toBeGreaterThan(0);
  });
});
