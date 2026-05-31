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

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
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

  it.each(['오푸스ㅇ', '오퍼스ㅇ'])(
    'incomplete Hangul IME entity prefix resolves through POST /v1/lookup/wine (%s)',
    async (query) => {
      const res = await post('/v1/lookup/wine', { query });
      expect(res.statusCode).toBe(200);

      const body = parseSearchResponse(res);
      expect(body.engine_decision.decision_status).toBe('resolved');
      expect(body.results[0]?.entity.entity_id).toBe('opus-one-2018');
    },
  );

  it.each(['오푸스', '오퍼스'])(
    'completed entity prefix resolves through POST /v1/lookup/wine (%s)',
    async (query) => {
      const res = await post('/v1/lookup/wine', { query });
      expect(res.statusCode).toBe(200);

      const body = parseSearchResponse(res);
      expect(body.engine_decision.decision_status).toBe('resolved');
      expect(body.results[0]?.entity.entity_id).toBe('opus-one-2018');
    },
  );

  it('latin partial prefix opu resolves through POST /v1/lookup/wine', async () => {
    const res = await post('/v1/lookup/wine', { query: 'opu' });
    expect(res.statusCode).toBe(200);

    const body = parseSearchResponse(res);
    expect(['resolved', 'ambiguous']).toContain(body.engine_decision.decision_status);
    expect(body.results[0]?.entity.entity_id).toBe('opus-one-2018');
  });

  it('latin short-form Opus does not leak uppercase acronym alias collisions through POST /v1/lookup/wine', async () => {
    const res = await post('/v1/lookup/wine', {
      query: 'opus',
    });
    expect(res.statusCode).toBe(200);

    const body = parseSearchResponse(res);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.entity.canonical_label.toLowerCase()).toContain('opus');
    expect(
      body.results.every((result) => {
        const surfaces = [
          result.entity.canonical_label,
          result.entity.producer,
        ].filter((value): value is string => typeof value === 'string');
        return surfaces.some((value) => value.toLowerCase().includes('opus'));
      }),
    ).toBe(true);
    expect(body.results.some((result) => result.match.matched_alias === 'PS')).toBe(false);
    expect(
      body.clarification?.candidates.some((candidate) => /paolo scavino|poderi sanguineto|psagot|podere sapaio/i.test(candidate.label))
        ?? false,
    ).toBe(false);
    expect(
      body.clarification?.candidates.every((candidate) => candidate.label.toLowerCase().includes('opus'))
        ?? true,
    ).toBe(true);
    if (body.clarification?.structured_payload?.options !== undefined && body.clarification.candidates.length > 0) {
      expect(body.clarification.structured_payload.options).toEqual(
        body.clarification.candidates.map((candidate) => candidate.label),
      );
    }
    if (body.clarification?.structured_payload?.option_entities !== undefined && body.clarification.candidates.length > 0) {
      expect(body.clarification.structured_payload.option_entities).toEqual(
        body.clarification.candidates.map((candidate) => ({
          entity_id: candidate.entity_id,
          label: candidate.label,
          ...(candidate.distinguishing_features.length > 0
            ? { distinguishing_features: candidate.distinguishing_features }
            : {}),
        })),
      );
    }
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

  it('lookup rejects mixed camelCase and snake_case query budget aliases together', async () => {
    const res = await post('/v1/lookup/wine', {
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
});
