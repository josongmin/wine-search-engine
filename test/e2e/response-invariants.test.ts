/**
 * E2E response-invariant tests for the Wine Search Engine.
 *
 * These tests assert structural and semantic contracts that MUST hold for
 * every successful response, regardless of the query or search mode.
 * They validate the RFC-014 / RFC-015 guarantees about shape, completeness,
 * and determinism of the search engine's output.
 *
 * Does NOT duplicate tests already in search-api.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getSearchDecision,
  getSearchDecisionSnapshot,
  getSearchEntityIds,
  getSearchRelevanceScores,
  getSearchRequestId,
  parseErrorResponse,
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

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Evidence obligation invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('Evidence obligation invariant', () => {
  const HYBRID_QUERIES = [
    'Opus One 2018',
    'Château Margaux',
    'Sassicaia',
    'DRC',
  ] as const;

  for (const query of HYBRID_QUERIES) {
    it(`every result item for '${query}' has evidenceItems.length > 0 (with real evidence)`, async () => {
      const res = await postJson(server.app, '/v1/search', {
        query,
        options: { mode: 'hybrid', explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const body = parseSearchResponse(res);
      const results = body.results;

      expect(results.length).toBeGreaterThan(0);

      for (const item of results) {
        const evidenceItems = item.evidence_items;
        expect(Array.isArray(evidenceItems)).toBe(true);
        expect(evidenceItems.length).toBeGreaterThan(0);

        const realEvidence = evidenceItems.filter((e) => e.type !== 'no_evidence_available');
        expect(realEvidence.length).toBeGreaterThan(0);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// decisionSnapshot completeness (RFC-015)
// ─────────────────────────────────────────────────────────────────────────────

describe('decisionSnapshot completeness (RFC-015)', () => {
  const MODES = ['entity', 'hybrid', 'auto'] as const;

  for (const mode of MODES) {
    it(`mode='${mode}' → decisionSnapshot has all required RFC-015 fields`, async () => {
      const res = await postJson(server.app, '/v1/search', {
        query: 'Opus One 2018',
        options: { mode, explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const snapshot = getSearchDecisionSnapshot(parseSearchResponse(res));

      expect(snapshot).toBeDefined();
      expect(typeof snapshot['model_versions']).toBe('object');
      expect(snapshot['model_versions']).not.toBeNull();
      expect(typeof snapshot['index_versions']).toBe('object');
      expect(snapshot['index_versions']).not.toBeNull();
      expect(typeof snapshot['policy_rule_version']).toBe('string');
      expect((snapshot['policy_rule_version']).length).toBeGreaterThan(0);
      expect(typeof snapshot['threshold_profile_id']).toBe('string');
      expect((snapshot['threshold_profile_id']).length).toBeGreaterThan(0);
      expect(typeof snapshot['planner_version']).toBe('string');
      expect((snapshot['planner_version']).length).toBeGreaterThan(0);
      expect(typeof snapshot['feature_flags']).toBe('object');
      expect(snapshot['feature_flags']).not.toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// engine_schema_version is always 'search_response_v1'
// ─────────────────────────────────────────────────────────────────────────────

describe("engine_schema_version always 'search_response_v1'", () => {
  const QUERIES = [
    'Opus One 2018',
    '풀바디 레드 와인',
    'DRC',
    '스파클링 와인',
    '달달한 와인',
  ] as const;

  for (const query of QUERIES) {
    it(`'${query}' → meta.engine_schema_version === 'search_response_v1'`, async () => {
      const res = await postJson(server.app, '/v1/search', { query });

      expect(res.statusCode).toBe(200);
      expect(parseSearchResponse(res).meta.engine_schema_version).toBe('search_response_v1');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// queryTimeMs is a non-negative integer
// ─────────────────────────────────────────────────────────────────────────────

describe('queryTimeMs is a non-negative integer', () => {
  const QUERIES = ['Opus One 2018', 'Château Margaux', '풀바디 레드 와인'] as const;

  for (const query of QUERIES) {
    it(`'${query}' → meta.queryTimeMs >= 0 and is integer`, async () => {
      const res = await postJson(server.app, '/v1/search', { query });

      expect(res.statusCode).toBe(200);
      const queryTimeMs = parseSearchResponse(res).meta.query_time_ms;

      expect(typeof queryTimeMs).toBe('number');
      expect(Number.isInteger(queryTimeMs)).toBe(true);
      expect(queryTimeMs).toBeGreaterThanOrEqual(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// confidenceSemantics value for resolved responses
// ─────────────────────────────────────────────────────────────────────────────

describe('confidenceSemantics for resolved responses', () => {
  it("entity response has confidenceSemantics === 'calibrated_decision_confidence' (regardless of decisionStatus)", async () => {
    const res = await postJson(server.app, '/v1/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const decision = getSearchDecision(parseSearchResponse(res));
    expect(decision.decision_status).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(decision.confidence_semantics).toBe('calibrated_decision_confidence');
  });

  it("'DRC' entity mode → confidenceSemantics is 'calibrated_decision_confidence'", async () => {
    const res = await postJson(server.app, '/v1/search', {
      query: 'DRC',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const decision = getSearchDecision(parseSearchResponse(res));
    expect(decision.decision_status).not.toBe('failed');
    expect(decision.confidence_semantics).toBe('calibrated_decision_confidence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replay idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('Replay idempotency', () => {
  const MATCHING_SNAPSHOT = {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
  };

  it('same query + same matching snapshot → 200 twice with same decisionStatus and results', async () => {
    const replayBody = {
      query: 'Opus One 2018',
      decision_snapshot: MATCHING_SNAPSHOT,
    };

    const [res1, res2] = await Promise.all([
      postJson(server.app, '/v1/search/replay', replayBody),
      postJson(server.app, '/v1/search/replay', replayBody),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const body1 = parseSearchResponse(res1);
    const body2 = parseSearchResponse(res2);
    const status1 = body1.engine_decision.decision_status;
    const status2 = body2.engine_decision.decision_status;

    expect(status1).toBe(status2);
    expect(getSearchEntityIds(body1)).toEqual(getSearchEntityIds(body2));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT_MISMATCH error structure
// ─────────────────────────────────────────────────────────────────────────────

describe('SNAPSHOT_MISMATCH error structure (RFC-015)', () => {
  it('409 SNAPSHOT_MISMATCH has the full RFC-014 error contract', async () => {
    const res = await postJson(server.app, '/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '9.9.9',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
    });

    expect(res.statusCode).toBe(409);
    const error = parseErrorResponse(res).error;

    expect(error.code).toBe('SNAPSHOT_MISMATCH');
    expect(error.retryable).toBe(false);
    expect(typeof error.request_id).toBe('string');
    expect(error.request_id).toBeTruthy();
    expect(error.failure_reason === null || typeof error.failure_reason === 'string').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results is always an array on successful responses
// ─────────────────────────────────────────────────────────────────────────────

describe("'results' is always an array on successful responses", () => {
  const CASES: Array<{ query: string; mode: string }> = [
    { query: 'Opus One 2018', mode: 'entity' },
    { query: '풀바디 레드 와인', mode: 'hybrid' },
    { query: 'DRC', mode: 'auto' },
    { query: '스파클링 와인', mode: 'hybrid' },
    { query: 'Château Margaux', mode: 'entity' },
  ];

  for (const { query, mode } of CASES) {
    it(`mode='${mode}', query='${query}' → Array.isArray(body.results) === true with descending order`, async () => {
      const res = await postJson(server.app, '/v1/search', {
        query,
        options: { mode, explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const body = parseSearchResponse(res);
      expect(Array.isArray(body.results)).toBe(true);
      const scores = getSearchRelevanceScores(body);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// request_id correlation: body matches X-Request-Id header
// ─────────────────────────────────────────────────────────────────────────────

describe('request_id correlation', () => {
  it('successful search: body meta.requestId matches X-Request-Id header', async () => {
    const res = await postJson(server.app, '/v1/search', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const headerRequestId = getHeader(res, 'x-request-id');

    expect(headerRequestId).toBeTruthy();
    expect(getSearchRequestId(parseSearchResponse(res))).toBe(headerRequestId);
  });

  it('SNAPSHOT_MISMATCH error: error.request_id matches X-Request-Id header', async () => {
    const res = await postJson(server.app, '/v1/search/replay', {
      query: 'Opus One 2018',
      decision_snapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '9.9.9',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
    });

    expect(res.statusCode).toBe(409);
    const headerRequestId = getHeader(res, 'x-request-id');

    expect(headerRequestId).toBeTruthy();
    expect(parseErrorResponse(res).error.request_id).toBe(headerRequestId);
  });

  it('validation error: error.request_id matches X-Request-Id header', async () => {
    const res = await postJson(server.app, '/v1/search', { query: '' });

    expect(res.statusCode).toBe(400);
    const headerRequestId = getHeader(res, 'x-request-id');

    expect(headerRequestId).toBeTruthy();
    expect(parseErrorResponse(res).error.request_id).toBe(headerRequestId);
  });
});
