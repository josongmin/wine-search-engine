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

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  json: () => unknown;
}

async function post(path: string, body: unknown): Promise<InjectResponse> {
  const response = await server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  };
}

function getHeader(res: InjectResponse, name: string): string {
  const val = res.headers[name.toLowerCase()];
  return Array.isArray(val) ? (val[0] ?? '') : (val ?? '');
}

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
      // NOTE: Entity mode returns `ambiguous` with 0 results in test infra.
      // Using hybrid mode to get actual results and verify evidence obligation.
      const res = await post('/v1/search', {
        query,
        options: { mode: 'hybrid', explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const results = body['results'] as Array<Record<string, unknown>>;
      expect(Array.isArray(results)).toBe(true);

      // Hybrid mode must return results for these well-known wine queries
      expect(results.length).toBeGreaterThan(0);

      // Every result must have at least one evidenceItem
      for (const item of results) {
        const evidenceItems = item['evidenceItems'] as unknown[] | undefined;
        expect(Array.isArray(evidenceItems)).toBe(true);
        expect((evidenceItems as unknown[]).length).toBeGreaterThan(0);

        // At least some REAL evidence must exist (filter out synthetic fallback)
        const realEvidence = (evidenceItems as unknown[]).filter(
          (e) => (e as Record<string, unknown>)['type'] !== 'no_evidence_available'
        );
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
      const res = await post('/v1/search', {
        query: 'Opus One 2018',
        options: { mode, explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const decision = body['engineDecision'] as Record<string, unknown>;
      const snapshot = decision['decisionSnapshot'] as Record<string, unknown>;

      expect(snapshot).toBeDefined();

      // model_versions and index_versions must be objects (records)
      expect(typeof snapshot['model_versions']).toBe('object');
      expect(snapshot['model_versions']).not.toBeNull();
      expect(typeof snapshot['index_versions']).toBe('object');
      expect(snapshot['index_versions']).not.toBeNull();

      // Version strings must be non-empty
      expect(typeof snapshot['policy_rule_version']).toBe('string');
      expect((snapshot['policy_rule_version'] as string).length).toBeGreaterThan(0);

      expect(typeof snapshot['threshold_profile_id']).toBe('string');
      expect((snapshot['threshold_profile_id'] as string).length).toBeGreaterThan(0);

      expect(typeof snapshot['planner_version']).toBe('string');
      expect((snapshot['planner_version'] as string).length).toBeGreaterThan(0);

      // feature_flags must be an object
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
      const res = await post('/v1/search', { query });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const meta = body['meta'] as Record<string, unknown>;
      expect(meta['engine_schema_version']).toBe('search_response_v1');
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
      const res = await post('/v1/search', { query });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const meta = body['meta'] as Record<string, unknown>;
      const queryTimeMs = meta['queryTimeMs'] as number;

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
    const res = await post('/v1/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const decision = body['engineDecision'] as Record<string, unknown>;

    // In test infra, ambiguous is expected (conformal set >= 2); either way,
    // confidenceSemantics must always be present
    expect(decision['decisionStatus']).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(decision['confidenceSemantics']).toBe('calibrated_decision_confidence');
  });

  it("'DRC' entity mode → confidenceSemantics is 'calibrated_decision_confidence'", async () => {
    const res = await post('/v1/search', {
      query: 'DRC',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const decision = body['engineDecision'] as Record<string, unknown>;

    // DRC is a pre-registered alias — must not fail
    expect(decision['decisionStatus']).not.toBe('failed');
    // confidenceSemantics must always be calibrated_decision_confidence
    expect(decision['confidenceSemantics']).toBe('calibrated_decision_confidence');
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
      post('/v1/search/replay', replayBody),
      post('/v1/search/replay', replayBody),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const body1 = res1.json() as Record<string, unknown>;
    const body2 = res2.json() as Record<string, unknown>;

    const status1 = (body1['engineDecision'] as Record<string, unknown>)['decisionStatus'];
    const status2 = (body2['engineDecision'] as Record<string, unknown>)['decisionStatus'];

    expect(status1).toBe(status2);

    // Also compare entity IDs in results — must be identical for same query+snapshot
    const results1 = (body1['results'] as Record<string, unknown>[]).map(r =>
      (r['entity'] as Record<string, unknown>)['entityId']
    );
    const results2 = (body2['results'] as Record<string, unknown>[]).map(r =>
      (r['entity'] as Record<string, unknown>)['entityId']
    );
    expect(results1).toEqual(results2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT_MISMATCH error structure
// ─────────────────────────────────────────────────────────────────────────────

describe('SNAPSHOT_MISMATCH error structure (RFC-015)', () => {
  it('409 SNAPSHOT_MISMATCH has the full RFC-014 error contract', async () => {
    const res = await post('/v1/search/replay', {
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
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');

    const error = body['error'] as Record<string, unknown>;

    // code must be SNAPSHOT_MISMATCH
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');

    // Snapshot mismatches are not retryable (fail-closed per RFC-014 §4.3)
    expect(error['retryable']).toBe(false);

    // request_id must be a truthy string
    expect(typeof error['request_id']).toBe('string');
    expect(error['request_id']).toBeTruthy();

    // failure_reason is either null or a string — never undefined
    expect(error['failure_reason'] === null || typeof error['failure_reason'] === 'string').toBe(true);
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
      const res = await post('/v1/search', {
        query,
        options: { mode, explain: false, clarification: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(Array.isArray(body['results'])).toBe(true);

      // Verify results are sorted descending by relevanceScore
      const results = body['results'] as Array<Record<string, unknown>>;
      const scores = results.map(r => r['relevanceScore'] as number);
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
    const res = await post('/v1/search', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const headerRequestId = getHeader(res, 'x-request-id');
    const body = res.json() as Record<string, unknown>;
    const meta = body['meta'] as Record<string, unknown>;

    expect(headerRequestId).toBeTruthy();
    expect(meta['requestId']).toBe(headerRequestId);
  });

  it('SNAPSHOT_MISMATCH error: error.request_id matches X-Request-Id header', async () => {
    const res = await post('/v1/search/replay', {
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
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(headerRequestId).toBeTruthy();
    expect(error['request_id']).toBe(headerRequestId);
  });

  it('validation error: error.request_id matches X-Request-Id header', async () => {
    const res = await post('/v1/search', { query: '' }); // triggers 400

    expect(res.statusCode).toBe(400);
    const headerRequestId = getHeader(res, 'x-request-id');
    const body = res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;

    expect(headerRequestId).toBeTruthy();
    expect(error['request_id']).toBe(headerRequestId);
  });
});
