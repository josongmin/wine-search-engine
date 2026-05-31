/**
 * Contract drift tests — locks in field-set parity between layers that
 * independently define the "same" entity.
 *
 * Each test asserts a structural fact about a pair of definitions. If the
 * two layers diverge (e.g. one adds a field the other doesn't), this test
 * fails immediately at PR time instead of producing a 400 in production.
 *
 * Append-only.
 */

import { describe, it, expect } from 'vitest';
import { SearchRequestSchema } from '../../src/interface/http/schemas/search-request.schema.js';
import { BatchSearchRequestSchema } from '../../src/interface/http/schemas/batch-search.schema.js';
import { SearchResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';


describe('Contract drift: QueryBudget — request schema must include max_dense_calls', () => {
  it('snake-case request schema accepts max_dense_calls', async () => {
    const result = SearchRequestSchema.safeParse({
      query: 'test',
      query_budget: {
        max_latency_ms: 5000,
        max_candidates: 100,
        rerank_limit: 20,
        max_dense_calls: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  it('camel-case request schema accepts maxDenseCalls', async () => {
    const result = SearchRequestSchema.safeParse({
      query: 'test',
      queryBudget: {
        maxLatencyMs: 5000,
        maxCandidates: 100,
        rerankLimit: 20,
        maxDenseCalls: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  it('batch-search schema accepts max_dense_calls', async () => {
    const result = BatchSearchRequestSchema.safeParse({
      requests: [
        {
          id: 'a',
          query: 'test',
          query_budget: {
            max_latency_ms: 5000,
            max_candidates: 100,
            rerank_limit: 20,
            max_dense_calls: 5,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('snake transform propagates maxDenseCalls into camelCase output', async () => {
    const parsed = SearchRequestSchema.parse({
      query: 'test',
      query_budget: {
        max_latency_ms: 5000,
        max_candidates: 100,
        rerank_limit: 20,
        max_dense_calls: 7,
      },
    });
    expect(parsed.queryBudget?.maxDenseCalls).toBe(7);
  });
});

describe('Contract drift: SessionContext — request and response use compatible bounds', () => {
  it('request session schema accepts up to 50 previous entities', async () => {
    const previous = Array.from({ length: 50 }, (_, i) => `entity-${i}`);
    const result = SearchRequestSchema.safeParse({
      query: 'test',
      sessionContext: { sessionId: 'sess-1', previousEntities: previous },
    });
    expect(result.success).toBe(true);
  });

  it('request session schema rejects 51 previous entities', async () => {
    const previous = Array.from({ length: 51 }, (_, i) => `entity-${i}`);
    const result = SearchRequestSchema.safeParse({
      query: 'test',
      sessionContext: { sessionId: 'sess-1', previousEntities: previous },
    });
    expect(result.success).toBe(false);
  });

  it('snake_case and camelCase variants accept the same input shape', async () => {
    const camelResult = SearchRequestSchema.safeParse({
      query: 'test',
      sessionContext: { sessionId: 'sess-1', previousEntities: ['e1'] },
    });
    const snakeResult = SearchRequestSchema.safeParse({
      query: 'test',
      session_context: { session_id: 'sess-1', previous_entities: ['e1'] },
    });
    expect(camelResult.success).toBe(true);
    expect(snakeResult.success).toBe(true);
  });
});

describe('Contract drift: EngineDecision cross-field invariants', () => {
  it('schema enforces authority_trace_ref === decision_trace_ref', async () => {
    const baseHash = 'a'.repeat(64);
    const result = SearchResponseSchema.safeParse({
      query_type: 'search',
      engine_decision: {
        decision_status: 'failed',
        next_action: 'fail',
        route: 'entity',
        decision_confidence: 0.1,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: `decision:v1:foo:${baseHash}`,
        authority_trace_ref: `decision:v1:bar:${baseHash}`, // mismatch
        decision_snapshot: {
          snapshot_id: 'snap',
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'v1',
          threshold_profile_id: 'default',
          planner_version: 'v1',
          feature_flags: {},
          response_contract_version: 'search_response_v1',
        },
      },
      results: [],
      meta: {
        query_time_ms: 1,
        route: 'entity',
        version: '1',
        engine_schema_version: 'search_response_v1',
      },
    });
    expect(result.success).toBe(false);
  });

  it('schema accepts MATCHING authority_trace_ref === decision_trace_ref (happy path)', () => {
    // Without this paired positive case, a regression that breaks the schema to
    // ALWAYS reject engine_decision would pass the negative-only test silently.
    const baseHash = 'a'.repeat(64);
    const matchingRef = `decision:v1:foo:${baseHash}`;
    const result = SearchResponseSchema.safeParse({
      query_type: 'search',
      engine_decision: {
        decision_status: 'failed',
        next_action: 'fail',
        route: 'entity',
        decision_confidence: 0.1,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: matchingRef,
        authority_trace_ref: matchingRef, // matching
        decision_snapshot: {
          snapshot_id: 'snap',
          model_versions: {},
          index_versions: {},
          policy_rule_version: 'v1',
          threshold_profile_id: 'default',
          planner_version: 'v1',
          feature_flags: {},
          response_contract_version: 'search_response_v1',
        },
      },
      results: [],
      meta: {
        query_time_ms: 1,
        route: 'entity',
        version: '1',
        engine_schema_version: 'search_response_v1',
      },
    });
    expect(result.success).toBe(true);
  });
});
