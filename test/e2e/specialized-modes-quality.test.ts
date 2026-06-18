import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchDecision,
  getSearchEntityIds,
  parseSearchResponse,
  postJson,
} from './helpers/http-transport.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

async function search(query: string) {
  const response = await postJson(server.app, '/v1/search/hybrid', {
    query,
    options: { explain: false, clarification: false },
  });

  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

describe('Specialized Modes Quality', () => {
  it('keeps free-text anchored similarity on the public hybrid discovery lane', async () => {
    const body = await search('Opus One 2018 비슷한 와인');

    expect(body.meta.route).toBe('hybrid');
    expect(body.retrieval_mode).toBe('attribute_search');
    expect(body.results.length).toBeGreaterThan(0);
    expect(getSearchEntityIds(body).slice(0, 5)).toContain('opus-one-2018');
  });

  it('keeps recommendation queries on a ranked set-retrieval path with non-empty results', async () => {
    const body = await search('wine for steak');

    expect(body.meta.route).toBe('hybrid');
    expect(body.retrieval_mode).toBe('recommendation');
    expect(body.result_type).toBe('entity_set');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.engine_decision.decision_status).not.toBe('failed');
  });

  it('does not falsely resolve fictional wines in the smoke no-match path', async () => {
    const body = await search('Chateau Fantaisie 2025');
    const decision = getSearchDecision(body);

    expect(body.meta.route).toBe('hybrid');
    expect(decision.decision_status).not.toBe('resolved');
  });
});
