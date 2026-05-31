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
      const response = await postJson(isolatedServer.app, '/v1/search/hybrid', {
        query: '펜폴즈',
        options: { explain: false, clarification: true },
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
    'keeps broad Korean surface $query fail-closed on hybrid discovery',
    async ({ query, forbiddenResolvedEntityId, allowResolved = false }) => {
      const response = await postJson(server.app, '/v1/search/hybrid', {
        query,
        options: { explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      const topEntityId = body.results[0]?.entity.entity_id;

      if (allowResolved) {
        expect(body.engine_decision.decision_status).toMatch(/^(resolved|ambiguous)$/);
      } else {
        expect(body.engine_decision.decision_status).toBe('ambiguous');
        expect(body.engine_decision.next_action).toBe('clarify');
        expect(
          body.engine_decision.decision_status === 'resolved'
          && topEntityId === forbiddenResolvedEntityId,
        ).toBe(false);
      }
    },
  );

  it.each(CORE_KOREAN_ICON_AMBIGUITY_CASES.filter(
    (testCase) => testCase.expectedCandidateEntityId !== undefined,
  ))(
    'keeps candidate recall for ambiguous Korean surface $query in default search',
    async ({ query, expectedCandidateEntityId, forbiddenResolvedEntityId, allowResolved = false }) => {
      const response = await postJson(server.app, '/v1/search/hybrid', {
        query,
        options: { explain: false, clarification: true },
      });

      expect(response.statusCode).toBe(200);

      const body = parseSearchResponse(response);
      const topEntityId = body.results[0]?.entity.entity_id;

      expect(body.engine_decision.decision_status).toMatch(
        allowResolved ? /^(resolved|ambiguous)$/ : /^ambiguous$/,
      );
      if (!allowResolved) {
        expect(body.engine_decision.next_action).toBe('clarify');
        expect(
          body.engine_decision.decision_status === 'resolved'
          && topEntityId === forbiddenResolvedEntityId,
        ).toBe(false);
      }
      expect(
        body.results.some((result) => result.entity.entity_id === expectedCandidateEntityId),
      ).toBe(true);
    },
  );
});
