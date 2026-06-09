/**
 * E2E response-invariant tests for the Wine Search Engine.
 *
 * These tests assert structural and semantic contracts that MUST hold for
 * every successful response, regardless of the query or public route.
 * They validate the RFC-014 / RFC-015 guarantees about shape, completeness,
 * and determinism of the search engine's output.
 *
 * Does NOT duplicate tests already owned by search-api.search/search-api.secondary,
 * search-api.ops, or infrastructure invariants/contracts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchDecision,
  getSearchDecisionSnapshot,
  getSearchRelevanceScores,
  parseEntityLookupResponse,
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

async function search(body: unknown) {
  const response = await postJson(server.app, '/v1/search/hybrid', body);
  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

async function lookup(query: string) {
  const response = await postJson(server.app, '/v2/entity-lookup', { query });
  expect(response.statusCode).toBe(200);
  return parseEntityLookupResponse(response);
}

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
      const body = await search({
        query,
        options: { explain: false, clarification: false },
      });
      const results = body.results;

      expect(results.length).toBeGreaterThan(0);

      for (const item of results) {
        const evidenceItems = item.evidence_items;
        expect(Array.isArray(evidenceItems)).toBe(true);
        expect(evidenceItems.length).toBeGreaterThan(0);

        expect(evidenceItems.every((e) => e.type.trim().length > 0)).toBe(true);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// decisionSnapshot completeness (RFC-015)
// ─────────────────────────────────────────────────────────────────────────────

describe('decisionSnapshot completeness (RFC-015)', () => {
  const CASES = [
    ['exact entity query', { query: 'Opus One 2018' }],
    ['semantic preference query', { query: '풀바디 레드 와인', options: { explain: false, clarification: false } }],
  ] as const;

  for (const [label, request] of CASES) {
    it(`${label} → decisionSnapshot has all required RFC-015 fields`, async () => {
      const snapshot = getSearchDecisionSnapshot(await search(request));

      expect(typeof snapshot['snapshot_id']).toBe('string');
      expect(snapshot['snapshot_id'].length).toBeGreaterThan(0);
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
      expect((await search({ query })).meta.engine_schema_version).toBe('search_response_v1');
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
      const queryTimeMs = (await search({ query })).meta.query_time_ms;

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
  it('keeps exact-query search confidence semantics aligned with calibration_trusted', async () => {
    const decision = getSearchDecision(await search({
      query: 'Opus One 2018',
    }));
    expect(decision.decision_status).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(decision.confidence_semantics).toBe(
      decision.calibration_trusted === false
        ? 'uncalibrated_decision_score'
        : 'calibrated_decision_confidence',
    );
  });

  it('maps untrusted semantic list scores to uncalibrated semantics', async () => {
    const decision = getSearchDecision(await search({
      query: '풀바디 레드 와인',
      options: { explain: false, clarification: false },
    }));
    expect(decision.decision_status).toMatch(/^(resolved|ambiguous)$/);
    expect(decision.calibration_trusted).toBe(false);
    expect(decision.confidence_semantics).toBe('uncalibrated_decision_score');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results is always an array on successful responses
// ─────────────────────────────────────────────────────────────────────────────

describe("'results' is always an array on successful responses", () => {
  const CASES = [
    { query: 'Opus One 2018' },
    { query: '풀바디 레드 와인', options: { explain: false, clarification: false } },
    { query: 'DRC', options: { explain: false, clarification: false } },
    { query: '스파클링 와인', options: { explain: false, clarification: false } },
    { query: 'Château Margaux' },
  ] as const;

  for (const request of CASES) {
    it(`query='${request.query}' → Array.isArray(body.results) === true with descending order`, async () => {
      const body = await search(request);
      expect(Array.isArray(body.results)).toBe(true);
      const scores = getSearchRelevanceScores(body);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!);
      }
    });
  }
});

describe('entity-lookup-v2 invariants', () => {
  it('lookup responses always carry the dedicated V2 schema marker', async () => {
    const body = await lookup('Opus One 2018');
    expect(body.meta.engine_schema_version).toBe('entity_lookup_v2');
  });

  it('comparison-style lookup queries fail closed inside the 4-state envelope', async () => {
    const body = await lookup('Opus One vs Sassicaia');
    expect(body.status).not.toBe('resolved');
    expect(body.top_candidate).toBeNull();
  });
});
