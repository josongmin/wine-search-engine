import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { parseSearchResponse, postJson } from './helpers/http-transport.js';
import {
  CORE_KOREAN_ICON_QUERY_CASES,
  loadCoreKoreanIconFixtureBundle,
} from '../support/core-korean-icon-fixtures.js';

let server: TestServer;

beforeAll(async () => {
  const bundle = await loadCoreKoreanIconFixtureBundle();
  server = await createTestServer({
    containerOptions: {
      fixtureAliases: bundle.fixtureAliases,
      fixtureDocuments: bundle.fixtureDocuments,
    },
  });
});

afterAll(async () => {
  await closeTestServer(server);
});

describe('Core Korean Iconic Entities', () => {
  it.each(CORE_KOREAN_ICON_QUERY_CASES)(
    'resolves $query to $expectedEntityId through POST /v1/lookup/wine',
    async ({ query, expectedEntityId }) => {
      const response = await postJson(server.app, '/v1/lookup/wine', { query });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      expect(body.engine_decision.decision_status).toBe('resolved');
      expect(body.results[0]?.entity.entity_id).toBe(expectedEntityId);
    },
  );
});
