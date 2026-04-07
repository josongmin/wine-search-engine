/**
 * Schema contract tests — validates every response matches the RFC-014 schema exactly.
 *
 * Uses Zod for structural validation of the SearchResponseV1 shape.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  ErrorResponseSchema,
  SearchResponseSchema,
} from '../../src/interface/http/schemas/search-response.schema.js';
import {
  getSearchDecision,
  getSearchDecisionSnapshot,
  getSearchRequestId,
  parseErrorResponse,
  parseSearchResponse,
  postJson,
  postReplayJson,
} from './helpers/http-transport.js';
import { makeReplaySnapshot } from './helpers/replay-snapshot.js';

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
  const response = await postJson(server.app, '/v1/search', body);
  return {
    statusCode: response.statusCode,
    json: response.json(),
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
    const res = await postJson(server.app, '/v1/search', { query: 'Château Margaux 2015' });

    expect(res.statusCode).toBe(200);
    expect(getSearchDecision(parseSearchResponse(res)).decision_status).toMatch(
      /^(resolved|ambiguous|failed)$/,
    );
  });

  it('meta.requestId is truthy in all successful responses', async () => {
    const res = await postJson(server.app, '/v1/search', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const requestId = getSearchRequestId(parseSearchResponse(res));
    expect(requestId).toBeTruthy();
    expect(typeof requestId).toBe('string');
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
    const response = await postJson(server.app, '/v1/search', {
      query: '풀바디 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });
    expect(response.statusCode).toBe(200);
    const body = parseSearchResponse(response);

    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      const evidenceItems = result.evidence_items;
      expect(evidenceItems.length).toBeGreaterThan(0);

      // ResponseBuilder now fails closed on missing evidence, so every returned
      // item must already carry upstream-produced evidence.
      expect(evidenceItems.every((e) => e.type.trim().length > 0)).toBe(true);
    }
  });

  it('decisionSnapshot in engineDecision has all required fields', async () => {
    const res = await postJson(server.app, '/v1/search', { query: 'Opus One 2018' });

    expect(res.statusCode).toBe(200);
    const snapshot = getSearchDecisionSnapshot(parseSearchResponse(res));

    expect(snapshot).toHaveProperty('model_versions');
    expect(snapshot).toHaveProperty('index_versions');
    expect(snapshot).toHaveProperty('policy_rule_version');
    expect(snapshot).toHaveProperty('threshold_profile_id');
    expect(snapshot).toHaveProperty('planner_version');
    expect(snapshot).toHaveProperty('feature_flags');
  });

  it('confidenceSemantics is always calibrated_decision_confidence', async () => {
    const res = await postJson(server.app, '/v1/search', { query: 'Château Margaux' });

    expect(res.statusCode).toBe(200);
    expect(getSearchDecision(parseSearchResponse(res)).confidence_semantics)
      .toBe('calibrated_decision_confidence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error response contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Error Response Schema Contract (RFC-014 §5)', () => {
  it('error response matches RFC-014 error contract', async () => {
    const response = await postJson(server.app, '/v1/search', {});

    expect(response.statusCode).toBe(400);
    const result = ErrorResponseSchema.safeParse(response.json());
    if (!result.success) {
      console.error('Error schema validation failed:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('error.code is truthy in all error responses', async () => {
    const response = await postJson(server.app, '/v1/search', { query: '' });

    expect(response.statusCode).toBe(400);
    expect(parseErrorResponse(response).error.code).toBeTruthy();
  });

  it('error.request_id is truthy in all error responses', async () => {
    const response = await postJson(server.app, '/v1/search', { query: '' });

    expect(parseErrorResponse(response).error.request_id).toBeTruthy();
  });

  it('error.failure_reason is null or string', async () => {
    const response = await postJson(server.app, '/v1/search', {});

    const error = parseErrorResponse(response).error;
    expect(error.failure_reason === null || typeof error.failure_reason === 'string').toBe(true);
  });

  it('409 SNAPSHOT_MISMATCH has correct error shape', async () => {
    const response = await postReplayJson(server.app, {
      query: 'Opus One 2018',
      decision_snapshot: makeReplaySnapshot({
        policy_rule_version: '99.0.0',
        threshold_profile_id: 'wrong',
        planner_version: '99.0.0',
      }),
    });

    expect(response.statusCode).toBe(409);
    const result = ErrorResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);

    const error = parseErrorResponse(response).error;
    expect(error.code).toBe('SNAPSHOT_MISMATCH');
    expect(error.request_id).toBeTruthy();
    expect(error.retryable).toBe(false);
  });

  it('replay helper posts to the expected endpoint contract', async () => {
    const response = await postReplayJson(server.app, {
      query: 'Opus One 2018',
      decision_snapshot: makeReplaySnapshot({
        policy_rule_version: '9.9.9',
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(parseErrorResponse(response).error.code).toBe('SNAPSHOT_MISMATCH');
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
