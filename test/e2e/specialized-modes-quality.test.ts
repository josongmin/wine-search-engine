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

async function searchAuto(query: string) {
  const response = await postJson(server.app, '/v1/search', {
    query,
    options: { mode: 'auto', explain: false, clarification: false },
  });

  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

describe('Specialized Modes Quality', () => {
  it('keeps similar-items queries on the mixed route and excludes the seed wine', async () => {
    const body = await searchAuto('Opus One 2018 비슷한 와인');

    expect(body.meta.route).toBe('mixed');
    expect(body.retrieval_mode).toBe('similar_items');
    expect(body.results.length).toBeGreaterThanOrEqual(3);
    expect(getSearchEntityIds(body).slice(0, 5)).not.toContain('opus-one-2018');
  });

  it('keeps recommendation queries on a ranked set-retrieval path with non-empty results', async () => {
    const body = await searchAuto('wine for steak');

    expect(body.meta.route).toBe('hybrid');
    expect(body.retrieval_mode).toBe('recommendation');
    expect(body.result_type).toBe('entity_set');
    expect(body.results.length).toBeGreaterThanOrEqual(5);
  });

  it('does not falsely resolve fictional wines in the smoke no-match path', async () => {
    const body = await searchAuto('Chateau Fantaisie 2025');
    const decision = getSearchDecision(body);

    expect(body.meta.route).toBe('hybrid');
    expect(decision.decision_status).not.toBe('resolved');
  });
});
