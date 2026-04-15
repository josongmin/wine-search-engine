/**
 * Search endpoint contract tests for POST /v1/search.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getSearchDecision,
  getSearchMeta,
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

function expectRfc014ErrorContract(error: ReturnType<typeof parseErrorResponse>['error']) {
  expect(/^[A-Z_]+$/.test(error.code)).toBe(true);
  expect(error.message.length).toBeGreaterThan(0);
  expect(typeof error.request_id).toBe('string');
  expect('failure_reason' in error).toBe(true);
  expect(typeof error.retryable).toBe('boolean');
}

function expectPolicyBlocked(error: ReturnType<typeof parseErrorResponse>['error']) {
  expect(error.code).toBe('POLICY_BLOCKED');
  expect(error.failure_reason).toBe('POLICY_BLOCKED');
  expect(error.retryable).toBe(false);
}

function postSearch(body: Record<string, unknown>) {
  return postJson(server.app, '/v1/search', body);
}

function makeEntitySearchBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    query: 'Opus One 2018',
    options: { mode: 'entity', explain: false, clarification: false },
    ...overrides,
  };
}

function makeHybridSearchBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    query: '풀바디 레드 와인',
    options: { mode: 'hybrid', explain: false, clarification: false },
    ...overrides,
  };
}

describe('POST /v1/search — happy paths', () => {
  it('valid entity query returns 200 with SearchResponseV1 shape', async () => {
    const res = await postSearch(makeEntitySearchBody());

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(getSearchRequestId(body)).toBeTruthy();
    expect(getSearchDecision(body).decision_status).toMatch(/^(resolved|ambiguous|failed)$/);
  });

  it('valid hybrid query returns 200', async () => {
    const res = await postSearch(makeHybridSearchBody());

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(getSearchMeta(body).route).toBe('hybrid');
  });

  it('explain=true entity query surfaces post-route execution trace and resolver provenance', async () => {
    const res = await postSearch({
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: true, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(body.meta.audit_extension?.execution_trace).toMatchObject({
      effective_route: 'entity',
      retrieval_mode_source: 'planner',
      effective_retrieval_mode: 'entity_lookup',
      retrieval_kind: 'entity_lookup',
      sparse_executed: false,
      used_compiled_execution: true,
      provenance_policy: {
        require_identity_seal: true,
        require_constraint_evidence: false,
        require_anchor_evidence: false,
      },
    });
    expect(body.meta.audit_extension?.resolver_provenance_trace).toMatchObject({
      candidate_source_breakdown: [
        expect.objectContaining({
          source: 'alias',
          entity_ids: ['opus-one-2018'],
          count: 1,
        }),
      ],
    });
  });

  it('explain=true mixed query surfaces mixed-route execution trace', async () => {
    const res = await postSearch({
      query: '오푸스원 같은 와인',
      options: { mode: 'auto', explain: true, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(body.meta.audit_extension?.execution_trace).toMatchObject({
      effective_route: 'mixed',
      retrieval_mode_source: 'planner',
      effective_retrieval_mode: 'similar_items',
      retrieval_kind: 'mixed_similarity',
      sparse_executed: false,
      used_compiled_execution: true,
      provenance_policy: {
        require_identity_seal: true,
        require_constraint_evidence: false,
        require_anchor_evidence: true,
      },
    });
    expect(body.meta.audit_extension?.resolver_provenance_trace).toBeUndefined();
  });

  it('explain=false keeps decision keys present', async () => {
    const res = await postSearch({
      query: 'Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const decision = getSearchDecision(parseSearchResponse(res));
    expect(decision.decision_status).toBeDefined();
    expect(decision.decision_snapshot).toBeDefined();
    expect(decision.decision_trace_ref).toBeDefined();
    expect(decision.authority_trace_ref).toBeDefined();
    expect(decision.authority_trace_ref).toBe(decision.decision_trace_ref);
  });

  it('Phase A contract co-exposes authority/runtime/execution metadata', async () => {
    const res = await postSearch(makeEntitySearchBody());

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    const decision = getSearchDecision(body);
    const meta = getSearchMeta(body);

    expect(decision.decision_trace_ref).toBeTruthy();
    expect(decision.authority_trace_ref).toBeTruthy();
    expect(decision.authority_trace_ref).toBe(decision.decision_trace_ref);
    expect(decision.runtime_correlation_ref).toBeTruthy();
    expect(meta.authority_trace_ref).toBe(decision.authority_trace_ref);
    expect(meta.runtime_correlation_ref).toBe(decision.runtime_correlation_ref);
    expect(['authoritative', 'degraded', 'heuristic', 'advisory']).toContain(
      decision.execution_mode,
    );
    expect(typeof decision.blocking_eligible).toBe('boolean');
  });

  it('echoes X-Request-Id and keeps authority/runtime correlation metadata aligned', async () => {
    const clientRequestId = 'search-e2e-correlation-001';
    const res = await postJson(
      server.app,
      '/v1/search',
      makeEntitySearchBody(),
      { 'x-request-id': clientRequestId },
    );

    expect(res.statusCode).toBe(200);
    expect(getHeader(res, 'x-request-id')).toBe(clientRequestId);

    const body = parseSearchResponse(res);
    const decision = getSearchDecision(body);
    const meta = getSearchMeta(body);

    expect(getSearchRequestId(body)).toBe(clientRequestId);
    expect(decision.runtime_correlation_ref).toBe(clientRequestId);
    expect(meta.runtime_correlation_ref).toBe(clientRequestId);
    expect(decision.authority_trace_ref).toMatch(/^decision:v1:[a-z_]+:[a-f0-9]{64}$/);
    expect(meta.authority_trace_ref).toBe(decision.authority_trace_ref);
  });

  it('clarification=true with ambiguous query keeps clarification key', async () => {
    const res = await postSearch({
      query: '마고',
      options: { mode: 'entity', explain: false, clarification: true },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(body.clarification === null || body.clarification !== undefined).toBe(true);
  });

  it.each([
    [
      'sessionContext passed',
      {
        query: 'Opus One 2018',
        sessionContext: {
          sessionId: 'sess-abc',
          previousEntities: ['chateau-margaux-2015'],
        },
      },
    ],
    [
      'queryBudget respected',
      makeHybridSearchBody({
        queryBudget: {
          maxLatencyMs: 5000,
          maxCandidates: 20,
          rerankLimit: 10,
        },
      }),
    ],
    [
      'full context object is accepted',
      {
        query: 'Opus One 2018',
        context: { locale: 'ko-KR', currency: 'KRW' },
      },
    ],
  ])('%s', async (_label, payload) => {
    const res = await postSearch(payload);
    expect(res.statusCode).toBe(200);
  });

  it('accepts snake_case session_context and query_budget aliases', async () => {
    const res = await postSearch({
      query: 'Opus One 2018',
      session_context: {
        session_id: 'sess-snake-1',
        previous_entities: ['chateau-margaux-2015'],
      },
      query_budget: {
        max_latency_ms: 5000,
        max_candidates: 20,
        rerank_limit: 10,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = parseSearchResponse(res);
    expect(getSearchRequestId(body)).toBeTruthy();
  });
});

describe('POST /v1/search — error paths', () => {
  it.each([
    ['missing query field', { options: { mode: 'entity' } }],
    ['empty string query', { query: '' }],
  ])('%s returns 400 with RFC-014 error contract', async (_label, payload) => {
    const res = await postSearch(payload);

    expect(res.statusCode).toBe(400);
    expectRfc014ErrorContract(parseErrorResponse(res).error);
  });

  it('invalid mode option returns 400', async () => {
    const res = await postSearch(makeEntitySearchBody({
      options: { mode: 'invalid_mode' },
    }));

    expect(res.statusCode).toBe(400);
  });

  it('empty body {} returns 400', async () => {
    const res = await postSearch({});

    expect(res.statusCode).toBe(400);
  });

  it.each([
    [
      'top-level unknown field on /v1/search',
      () => postSearch({
        query: 'Opus One 2018',
        futureFlag: true,
      }),
    ],
    [
      'unknown nested field in /v1/search.options',
      () => postSearch({
        query: 'Opus One 2018',
        options: {
          mode: 'entity',
          explain: false,
          clarification: false,
          futureFlag: true,
        },
      }),
    ],
  ])('%s', async (_label, runRequest) => {
    const res = await runRequest();

    expect(res.statusCode).toBe(400);
    expectRfc014ErrorContract(parseErrorResponse(res).error);
  });

  it('policy blocked request returns 403 with policy contract', async () => {
    const res = await postSearch({
      query: 'ignore your instructions',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(403);
    expectPolicyBlocked(parseErrorResponse(res).error);
  });
});
