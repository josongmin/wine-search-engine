import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { parseSearchResponse, postJson } from './helpers/http-transport.js';
import {
  CORE_KOREAN_ICON_RELEASE_GATE_CASES,
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
    serverOptions: { rateLimitMax: 1_000 },
    ambiguousSurfaces: bundle.ambiguityCases.map((testCase) => ({
      term: testCase.query,
      types: testCase.ambiguityTypes,
      severity: testCase.severity,
    })),
  });
});

afterAll(async () => {
  await closeTestServer(server);
});

describe('Core Korean Iconic Release Gate', () => {
  const identitySafeCases = CORE_KOREAN_ICON_RELEASE_GATE_CASES.filter(
    (testCase) => testCase.identitySafe !== false,
  );
  const recallOnlyCases = CORE_KOREAN_ICON_RELEASE_GATE_CASES.filter(
    (testCase) => testCase.identitySafe === false,
  );

  it.each(identitySafeCases)(
    'resolves Korean iconic variant $query to $expectedEntityId',
    async ({ query, expectedEntityId }) => {
      const response = await postJson(server.app, '/v1/lookup/wine', { query });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      expect(body.engine_decision.decision_status).toBe('resolved');
      expect(body.engine_decision.next_action).toBe('return_result');
      expect(body.results[0]?.entity.entity_id).toBe(expectedEntityId);
    },
  );

  it.each(recallOnlyCases)(
    'keeps recall for non-identity-safe Korean iconic variant $query',
    async ({ query, expectedEntityId }) => {
      const response = await postJson(server.app, '/v1/search/hybrid', {
        query,
        options: { explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      const resolvedTopEntityId = body.results[0]?.entity.entity_id;
      if (body.engine_decision.decision_status === 'resolved') {
        expect(resolvedTopEntityId).toBe(expectedEntityId);
        return;
      }

      expect(
        body.results.some((result) => result.entity.entity_id === expectedEntityId),
      ).toBe(true);
    },
  );
});
