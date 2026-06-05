import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { postJson } from './helpers/http-transport.js';
import {
  CORE_KOREAN_ICON_QUERY_CASES,
  isIdentitySafeCoreKoreanEntityCase,
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
  it.each(CORE_KOREAN_ICON_QUERY_CASES.filter(isIdentitySafeCoreKoreanEntityCase))(
    'resolves $query to $expectedEntityId through POST /v2/entity-lookup',
    async ({ query, expectedEntityId }) => {
      const response = await postJson(server.app, '/v2/entity-lookup', { query });

      expect(response.statusCode).toBe(200);

      const body = response.json() as { status: string; top_candidate?: { entity_id?: string } | null };
      expect(body.status).toBe('resolved');
      expect(body.top_candidate?.entity_id).toBe(expectedEntityId);
    },
  );
});
