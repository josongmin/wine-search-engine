/**
 * E2E input/query edge cases for the Wine Search Engine.
 *
 * Covers Unicode/special-character queries and input validation boundaries.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  parseSearchResponse,
  postJson,
} from './helpers/http-transport.js';
import { loadCoreKoreanIconFixtureBundle } from '../support/core-korean-icon-fixtures.js';

let server: TestServer;
const OPUS_ENTITY_ID = 'w-opus-one-2018';

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

async function post(path: string, body: unknown) {
  return postJson(server.app, path, body);
}

async function expectSearchNot500(
  query: string,
  expectedStatuses: readonly number[],
) {
  const res = await post('/v1/search/hybrid', { query });
  expect(res.statusCode).not.toBe(500);
  expect(expectedStatuses).toContain(res.statusCode);
  return res;
}

describe('Unicode and special character queries', () => {
  it.each([
    ['null byte', 'Opus\x00One'],
    ['newline', 'test\nquery'],
    ['tab', 'test\tquery'],
  ])('ASCII control characters in query — no 500 (%s)', async (_label, query) => {
    await expectSearchNot500(query, [200, 400]);
  });

  it('XSS payload in query — sanitized, no 500', async () => {
    const res = await expectSearchNot500('<script>alert("xss")</script>', [200, 400, 403]);
    if (res.statusCode === 200) {
      const bodyStr = JSON.stringify(parseSearchResponse(res));
      expect(bodyStr).not.toContain('<script>');
      expect(bodyStr).not.toContain('alert(');
    }
  });

  it('SQL injection payload — no 500', async () => {
    const res = await expectSearchNot500("'; DROP TABLE entities; --", [200, 400, 403]);
    if (res.statusCode === 200) {
      const bodyStr = JSON.stringify(parseSearchResponse(res));
      expect(bodyStr).not.toContain('DROP TABLE');
      expect(bodyStr).not.toContain("'; ");
    }
  });

  it('very long query (2000 chars) — no 500', async () => {
    await expectSearchNot500('와인 '.repeat(400), [200, 400]);
  });

  it('emoji in query — processed without error', async () => {
    const res = await post('/v1/search/hybrid', { query: '🍷 red wine recommendation' });
    expect(res.statusCode).toBe(200);
  });

  it('RTL characters (Arabic mixed with English) — no 500', async () => {
    await expectSearchNot500('wine نبيذ أحمر', [200, 400]);
  });

  it('only digits — no 500 (vintage-style query)', async () => {
    const res = await expectSearchNot500('2018', [200]);
    expect(res.statusCode).toBe(200);
  });

  it('only punctuation — validated correctly (min(1) passes for 3 chars)', async () => {
    const res = await post('/v1/search/hybrid', { query: '!!!' });
    expect(res.statusCode).toBe(200);
  });

  it('Korean-English code-switching — returns 200', async () => {
    const res = await post('/v1/search/hybrid', { query: '오푸스원 2018 Napa Valley' });
    expect(res.statusCode).toBe(200);
  });

  // V2-only cutover: lookup resolves via POST /v2/entity-lookup (4-state
  // contract). The wire body is the snake_case EntityLookupV2 result
  // { status, top_candidate, candidates, clarification_options, ... }.
  it.each(['오푸스ㅇ', '오퍼스ㅇ'])(
    'incomplete Hangul IME entity prefix resolves through POST /v2/entity-lookup (%s)',
    async (query) => {
      const res = await post('/v2/entity-lookup', { query });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; top_candidate?: { entity_id?: string } | null };
      expect(body.status).toBe('resolved');
      expect(body.top_candidate?.entity_id).toBe(OPUS_ENTITY_ID);
    },
  );

  it.each(['오푸스', '오퍼스'])(
    'completed entity prefix resolves through POST /v2/entity-lookup (%s)',
    async (query) => {
      const res = await post('/v2/entity-lookup', { query });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; top_candidate?: { entity_id?: string } | null };
      expect(body.status).toBe('resolved');
      expect(body.top_candidate?.entity_id).toBe(OPUS_ENTITY_ID);
    },
  );

  it('latin partial prefix opu resolves through POST /v2/entity-lookup', async () => {
    const res = await post('/v2/entity-lookup', { query: 'opu' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      top_candidate?: { entity_id?: string } | null;
      candidates?: ReadonlyArray<{ entity_id?: string }>;
    };
    expect(['resolved', 'ambiguous']).toContain(body.status);
    const ids = [body.top_candidate?.entity_id, ...(body.candidates ?? []).map((c) => c.entity_id)];
    expect(ids).toContain(OPUS_ENTITY_ID);
  });

  it('latin short-form Opus does not leak uppercase acronym alias collisions through POST /v2/entity-lookup', async () => {
    const res = await post('/v2/entity-lookup', { query: 'opus' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      candidates?: ReadonlyArray<{ canonical_label?: string }>;
      clarification_options?: ReadonlyArray<{ label?: string }>;
    };
    const candidateLabels = (body.candidates ?? [])
      .map((c) => c.canonical_label)
      .filter((l): l is string => typeof l === 'string');
    const clarificationLabels = (body.clarification_options ?? [])
      .map((o) => o.label)
      .filter((l): l is string => typeof l === 'string');
    const allLabels = [...candidateLabels, ...clarificationLabels];
    // Fail-closed is acceptable here; the contract is "no wrong acronym leak",
    // not "must always surface a candidate".
    expect(body.status).not.toBe('resolved');
    expect(allLabels.every((label) => label.toLowerCase().includes('opus'))).toBe(true);
    expect(allLabels.some((label) => /paolo scavino|poderi sanguineto|psagot|podere sapaio/i.test(label))).toBe(false);
  });

  it('combining diacritical characters (NFD form) — NFC normalization handles it', async () => {
    const nfdQuery = 'Chateau\u0300 Margaux';
    const res = await post('/v1/search/hybrid', { query: nfdQuery });
    expect(res.statusCode).toBe(200);
    const decision = parseSearchResponse(res).engine_decision;
    expect(decision.decision_status).not.toBe('failed');
  });
});

describe('Input validation edge cases', () => {
  it('query field is number type — Zod rejects with 400', async () => {
    const res = await post('/v1/search/hybrid', { query: 42 });
    expect(res.statusCode).toBe(400);
  });

  it('query field is array — Zod rejects with 400', async () => {
    const res = await post('/v1/search/hybrid', { query: ['Opus One'] });
    expect(res.statusCode).toBe(400);
  });

  it('query field is boolean — Zod rejects with 400', async () => {
    const res = await post('/v1/search/hybrid', { query: true });
    expect(res.statusCode).toBe(400);
  });

  it('context with empty locale — Zod rejects with 400 (min(1))', async () => {
    const res = await post('/v1/search/hybrid', {
      query: 'Opus One',
      context: { locale: '', currency: 'KRW' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with negative maxLatencyMs — Zod rejects with 400', async () => {
    const res = await post('/v1/search/hybrid', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: -100, maxCandidates: 10, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with zero maxCandidates — Zod rejects with 400', async () => {
    const res = await post('/v1/search/hybrid', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: 1000, maxCandidates: 0, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('search rejects mixed camelCase and snake_case query budget aliases together', async () => {
    const res = await post('/v1/search/hybrid', {
      query: 'Opus One',
      queryBudget: {
        maxLatencyMs: 1000,
        maxCandidates: 10,
        rerankLimit: 5,
      },
      query_budget: {
        max_latency_ms: 1000,
        max_candidates: 10,
        rerank_limit: 5,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // (Removed: the mixed camelCase/snake_case query-budget-alias rejection test
  // targeted the V1 /v1/lookup/wine request schema, which no longer exists after
  // the V2-only cutover. The /v2/entity-lookup body has no queryBudget aliases.)
});
