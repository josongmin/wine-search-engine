/**
 * Schema contract tests — validates every response matches the RFC-014 schema exactly.
 *
 * Uses Zod for structural validation of the SearchResponseV1 shape.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import { DecisionSnapshotSchema } from '../../src/interface/http/schemas/search-request.schema.js';
import {
  ErrorResponseSchema,
  SearchResponseSchema,
} from '../../src/interface/http/schemas/search-response.schema.js';

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

async function searchPost(body: unknown): Promise<{
  statusCode: number;
  json: unknown;
  headers: Record<string, string>;
}> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/search',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return {
    statusCode: response.statusCode,
    json: JSON.parse(response.body) as unknown,
    headers: response.headers as Record<string, string>,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema contract tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SearchResponseV1 Schema Contract', () => {
  it('entity search response matches RFC-014 contract', async () => {
    const { statusCode, json } = await searchPost({
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(statusCode).toBe(200);
    const result = SearchResponseSchema.safeParse(json);
    if (!result.success) {
      // Print validation errors for debugging
      console.error('Schema validation failed:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('hybrid search response matches RFC-014 contract', async () => {
    const { statusCode, json } = await searchPost({
      query: '풀바디 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(statusCode).toBe(200);
    const result = SearchResponseSchema.safeParse(json);
    if (!result.success) {
      console.error('Schema validation failed:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('auto-mode response matches RFC-014 contract', async () => {
    const { statusCode, json } = await searchPost({
      query: '오푸스원',
    });

    expect(statusCode).toBe(200);
    const result = SearchResponseSchema.safeParse(json);
    expect(result.success).toBe(true);
  });

  it('engineDecision.decisionStatus is one of the valid statuses', async () => {
    const { statusCode, json } = await searchPost({ query: 'Château Margaux 2015' });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body['engineDecision']).toBeDefined();
    const decision = body['engineDecision'] as Record<string, unknown>;
    expect(decision['decisionStatus']).toMatch(/^(resolved|ambiguous|failed)$/);
  });

  it('meta.requestId is truthy in all successful responses', async () => {
    const { statusCode, json } = await searchPost({ query: 'Opus One 2018' });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    const meta = body['meta'] as Record<string, unknown>;
    expect(meta['requestId']).toBeTruthy();
    expect(typeof meta['requestId']).toBe('string');
  });

  it('meta.engineSchemaVersion is present and set correctly', async () => {
    const { statusCode, json } = await searchPost({ query: 'Opus One 2018' });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    const meta = body['meta'] as Record<string, unknown>;
    // The ResponseBuilder sets version to "1.0.0"
    expect(meta['version']).toBe('1.0.0');
  });

  it('every result has at least one evidenceItem with real (non-synthetic) evidence', async () => {
    const { statusCode, json } = await searchPost({
      query: '풀바디 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    const results = body['results'] as unknown[];
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const r = result as Record<string, unknown>;
      const evidenceItems = r['evidenceItems'] as unknown[];
      expect(evidenceItems.length).toBeGreaterThan(0);

      // Filter out synthetic fallback evidence (type === 'no_evidence_available')
      const realEvidence = evidenceItems.filter(
        (e) => (e as Record<string, unknown>)['type'] !== 'no_evidence_available'
      );
      // At least some REAL evidence must exist
      expect(realEvidence.length).toBeGreaterThan(0);
    }
  });

  it('decisionSnapshot in engineDecision has all required fields', async () => {
    const { statusCode, json } = await searchPost({ query: 'Opus One 2018' });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    const decision = body['engineDecision'] as Record<string, unknown>;
    const snapshot = decision['decisionSnapshot'] as Record<string, unknown>;

    expect(snapshot).toHaveProperty('model_versions');
    expect(snapshot).toHaveProperty('index_versions');
    expect(snapshot).toHaveProperty('policy_rule_version');
    expect(snapshot).toHaveProperty('threshold_profile_id');
    expect(snapshot).toHaveProperty('planner_version');
    expect(snapshot).toHaveProperty('feature_flags');
  });

  it('confidenceSemantics is always calibrated_decision_confidence', async () => {
    const { statusCode, json } = await searchPost({ query: 'Château Margaux' });

    expect(statusCode).toBe(200);
    const body = json as Record<string, unknown>;
    const decision = body['engineDecision'] as Record<string, unknown>;
    expect(decision['confidenceSemantics']).toBe('calibrated_decision_confidence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error response contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Error Response Schema Contract (RFC-014 §5)', () => {
  it('error response matches RFC-014 error contract', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as unknown;
    const result = ErrorResponseSchema.safeParse(body);
    if (!result.success) {
      console.error('Error schema validation failed:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('error.code is truthy in all error responses', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBeTruthy();
  });

  it('error.request_id is truthy in all error responses', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '' }),
    });

    const body = JSON.parse(response.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['request_id']).toBeTruthy();
  });

  it('error.failure_reason is null or string', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    const body = JSON.parse(response.body) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['failure_reason'] === null || typeof error['failure_reason'] === 'string').toBe(true);
  });

  it('409 SNAPSHOT_MISMATCH has correct error shape', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/search/replay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query: 'Opus One 2018',
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '99.0.0',
          threshold_profile_id: 'wrong',
          planner_version: '99.0.0',
          feature_flags: {},
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const result = ErrorResponseSchema.safeParse(body);
    expect(result.success).toBe(true);

    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('SNAPSHOT_MISMATCH');
    expect(error['request_id']).toBeTruthy();
    // SNAPSHOT_MISMATCH errors must not be retryable (fail-closed per RFC-014 §4.3)
    expect(error['retryable']).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural invariants across multiple queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Structural invariants', () => {
  const testQueries = [
    'Opus One 2018',
    '오푸스원',
    'Château Margaux',
    '풀바디 레드 와인',
    '스파클링 와인',
  ];

  for (const query of testQueries) {
    it(`response for "${query}" is always structurally valid`, async () => {
      const { statusCode, json } = await searchPost({ query });

      expect(statusCode).toBe(200);
      const result = SearchResponseSchema.safeParse(json);
      if (!result.success) {
        console.error(
          `Schema validation failed for query "${query}":`,
          JSON.stringify(result.error.issues, null, 2),
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
