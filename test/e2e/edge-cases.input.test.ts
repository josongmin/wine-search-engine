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
import { makeReplaySnapshot } from './helpers/replay-snapshot.js';

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

async function postReplay(body: unknown) {
  return post('/v1/search/replay', body);
}

async function expectSearchNot500(
  query: string,
  expectedStatuses: readonly number[],
) {
  const res = await post('/v1/search', { query });
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
    const res = await post('/v1/search', { query: '🍷 red wine recommendation' });
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
    const res = await post('/v1/search', { query: '!!!' });
    expect(res.statusCode).toBe(200);
  });

  it('Korean-English code-switching — returns 200', async () => {
    const res = await post('/v1/search', { query: '오푸스원 2018 Napa Valley' });
    expect(res.statusCode).toBe(200);
  });

  it('combining diacritical characters (NFD form) — NFC normalization handles it', async () => {
    const nfdQuery = 'Chateau\u0300 Margaux';
    const res = await post('/v1/search', { query: nfdQuery });
    expect(res.statusCode).toBe(200);
    const decision = parseSearchResponse(res).engine_decision;
    expect(decision.decision_status).not.toBe('failed');
  });
});

describe('Input validation edge cases', () => {
  it('query field is number type — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: 42 });
    expect(res.statusCode).toBe(400);
  });

  it('query field is array — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: ['Opus One'] });
    expect(res.statusCode).toBe(400);
  });

  it('query field is boolean — Zod rejects with 400', async () => {
    const res = await post('/v1/search', { query: true });
    expect(res.statusCode).toBe(400);
  });

  it('context with empty locale — Zod rejects with 400 (min(1))', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      context: { locale: '', currency: 'KRW' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with negative maxLatencyMs — Zod rejects with 400', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: -100, maxCandidates: 10, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('queryBudget with zero maxCandidates — Zod rejects with 400', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      queryBudget: { maxLatencyMs: 1000, maxCandidates: 0, rerankLimit: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('search rejects mixed camelCase and snake_case session/query budget aliases together', async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      sessionContext: {
        sessionId: 'sess-1',
        previousEntities: ['wine:opus-one-2018'],
      },
      session_context: {
        session_id: 'sess-2',
        previous_entities: ['wine:opus-one-2018'],
      },
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

  it('interpret rejects mixed camelCase and snake_case aliases together', async () => {
    const res = await post('/v1/search/interpret', {
      query: 'Opus One',
      sessionContext: {
        sessionId: 'sess-1',
        previousEntities: ['wine:opus-one-2018'],
      },
      session_context: {
        session_id: 'sess-2',
        previous_entities: ['wine:opus-one-2018'],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('resolve rejects mixed camelCase and snake_case aliases together', async () => {
    const res = await post('/v1/entity/resolve', {
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

  it('batch-search rejects mixed camelCase and snake_case aliases together inside an item', async () => {
    const res = await post('/v1/batch-search', {
      batch_id: 'batch-conflict',
      requests: [
        {
          id: '1',
          query: 'Opus One',
          sessionContext: {
            sessionId: 'sess-1',
            previousEntities: ['wine:opus-one-2018'],
          },
          session_context: {
            session_id: 'sess-2',
            previous_entities: ['wine:opus-one-2018'],
          },
        },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('replay missing all required snapshot fields — returns 400', async () => {
    const res = await postReplay({
      query: 'Opus One',
      decision_snapshot: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('replay snapshot with wrong types (model_versions as string) — returns 400', async () => {
    const res = await postReplay({
      query: 'Opus One',
      decision_snapshot: {
        model_versions: 'not-an-object',
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
