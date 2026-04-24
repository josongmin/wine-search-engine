import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { parseSearchResponse, postJson } from './helpers/http-transport.js';
import {
  CORE_KOREAN_ICON_AMBIGUITY_CASES,
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

describe('Core Korean Iconic Ambiguity Guards', () => {
  it('clarifies static broad Korean surface without seeded ambiguity registry', async () => {
    const bundle = await loadCoreKoreanIconFixtureBundle();
    const isolatedServer = await createTestServer({
      containerOptions: {
        fixtureAliases: bundle.fixtureAliases,
        fixtureDocuments: bundle.fixtureDocuments,
      },
      ambiguousSurfaces: [],
    });

    try {
      const response = await postJson(isolatedServer.app, '/v1/search', {
        query: '펜폴즈',
        options: { mode: 'entity', explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);

      expect(body.engine_decision.decision_status).toBe('ambiguous');
      expect(body.engine_decision.next_action).toBe('clarify');
    } finally {
      await closeTestServer(isolatedServer);
    }
  });

  it.each(CORE_KOREAN_ICON_AMBIGUITY_CASES)(
    'does not wrong-resolve ambiguous Korean surface $query in entity mode',
    async ({ query, forbiddenResolvedEntityId }) => {
      const response = await postJson(server.app, '/v1/search', {
        query,
        options: { mode: 'entity', explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      const topEntityId = body.results[0]?.entity.entity_id;

      expect(body.engine_decision.decision_status).toBe('ambiguous');
      expect(body.engine_decision.next_action).toBe('clarify');
      expect(
        body.engine_decision.decision_status === 'resolved'
        && topEntityId === forbiddenResolvedEntityId,
      ).toBe(false);
    },
  );

  it.each(CORE_KOREAN_ICON_AMBIGUITY_CASES.filter(
    (testCase) => testCase.expectedCandidateEntityId !== undefined,
  ))(
    'keeps candidate recall for ambiguous Korean surface $query in default search',
    async ({ query, expectedCandidateEntityId, forbiddenResolvedEntityId }) => {
      const response = await postJson(server.app, '/v1/search', {
        query,
        options: { explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      const topEntityId = body.results[0]?.entity.entity_id;

      expect(body.engine_decision.decision_status).toBe('ambiguous');
      expect(body.engine_decision.next_action).toBe('clarify');
      expect(
        body.engine_decision.decision_status === 'resolved'
        && topEntityId === forbiddenResolvedEntityId,
      ).toBe(false);
      expect(
        body.results.some((result) => result.entity.entity_id === expectedCandidateEntityId),
      ).toBe(true);
    },
  );
});
