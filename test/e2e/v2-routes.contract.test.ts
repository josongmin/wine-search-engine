/**
 * Content negotiation contract tests.
 *
 * Verifies that V1 routes return the human-oriented response shape when the
 * client sends `Accept: application/vnd.cuvee.human+json` (RFC 7231 §5.3.2).
 *
 * - POST /v1/search + Accept human → { version: '2', responseType: 'human', ... }
 * - POST /v1/search/hybrid + Accept human → same
 * - POST /v1/search/interpret + Accept human → { version: '2', responseType: 'interpret', ... }
 * - V1 routes with default Accept still return V1 shape
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import { postJson, getJson } from './helpers/http-transport.js';
import { decodeAuthorityTraceRefDetailed } from '../../src/domain/decision/service/id-schema-decoder.js';
import { MEDIA_TYPE_HUMAN } from '../../src/interface/http/content-negotiation.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

const ACCEPT_HUMAN = { accept: MEDIA_TYPE_HUMAN };

function postHumanSearch(body: unknown, extraHeaders?: Record<string, string>) {
  return postJson(server.app, '/v1/search', body, { ...ACCEPT_HUMAN, ...extraHeaders });
}

function postHumanHybrid(body: unknown, extraHeaders?: Record<string, string>) {
  return postJson(server.app, '/v1/search/hybrid', body, { ...ACCEPT_HUMAN, ...extraHeaders });
}

function postHumanInterpret(body: unknown, extraHeaders?: Record<string, string>) {
  return postJson(server.app, '/v1/search/interpret', body, { ...ACCEPT_HUMAN, ...extraHeaders });
}

function injectTextPlain(url: string, body: unknown) {
  return server.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify(body),
  });
}

function expectRequestIdErrorShape(body: Record<string, unknown>) {
  const error = body['error'] as Record<string, unknown>;
  expect(typeof error['code']).toBe('string');
  expect(typeof error['request_id']).toBe('string');
}

// ---------------------------------------------------------------------------
// V2 search
// ---------------------------------------------------------------------------

describe('POST /v1/search + Accept human — V2 human response shape', () => {
  it('returns 200 with version=2 and responseType=human', async () => {
    const res = await postHumanSearch({
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
    expect(body['query_type']).toBe('search');
    expect(Array.isArray(body['results'])).toBe(true);
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['total_candidates']).toBe('number');
  });

  it('response validates against SearchResponseV2HumanSchema (camelCase pre-serialization)', async () => {
    const res = await postHumanSearch({
      query: 'Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // The server serialises camelCase → snake_case at the wire layer.
    // The raw JSON body uses snake_case; we verify structural properties.
    const body = res.json() as Record<string, unknown>;
    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
  });

  it('returns comparison envelope for decomposed "vs" queries', async () => {
    const res = await postHumanSearch({
      query: 'Opus One vs Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['query_type']).toBe('comparison');
    expect(body['comparison_intent']).toBeDefined();
    expect(Array.isArray(body['entities'])).toBe(true);
    expect((body['entities'] as unknown[]).length).toBe(2);
    expect(typeof body['original_query']).toBe('string');
    expect(typeof body['overall_status']).toBe('string');
    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
  });

  it('surfaces canonical authority/runtime metadata for comparison responses', async () => {
    const res = await postJson(
      server.app,
      '/v1/search',
      {
        query: 'Opus One vs Château Margaux',
        options: { mode: 'entity', explain: false, clarification: false },
      },
      { ...ACCEPT_HUMAN, 'x-request-id': 'req-v2-search-compare-123' },
    );

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['query_id']).toBe('req-v2-search-compare-123');
    expect(body['runtime_correlation_ref']).toBe('req-v2-search-compare-123');
    expect(typeof body['authority_trace_ref']).toBe('string');
    expect(decodeAuthorityTraceRefDetailed(String(body['authority_trace_ref']))).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it('each result item has version=2 and responseType=human', async () => {
    const res = await postHumanSearch({
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const results = body['results'] as Array<Record<string, unknown>>;

    for (const result of results) {
      expect(result['version']).toBe('2');
      expect(result['response_type']).toBe('human');
      expect(typeof result['entity_id']).toBe('string');
      expect(typeof result['canonical_label']).toBe('string');
      expect(typeof result['rank']).toBe('number');
      expect(typeof result['evidence_summary']).toBe('string');
      expect(typeof result['confidence']).toBe('number');
    }
  });

  it.each([
    ['missing required query field', () => postHumanSearch({ options: { mode: 'entity', explain: false, clarification: false } }), 400],
    ['empty body', () => postHumanSearch({}), 400],
    ['empty string query', () => postHumanSearch({ query: '' }), 400],
    ['text/plain body', () => injectTextPlain('/v1/search', { query: 'test' }), 415],
  ])('rejects %s', async (_label, runRequest, expectedStatus) => {
    const response = await runRequest();
    expect(response.statusCode).toBe(expectedStatus);
    if (expectedStatus === 400) {
      expectRequestIdErrorShape(response.json() as Record<string, unknown>);
    }
  });
});

// ---------------------------------------------------------------------------
// V2 hybrid
// ---------------------------------------------------------------------------

describe('POST /v1/search/hybrid + Accept human — V2 human response shape', () => {
  it('returns 200 with version=2 and responseType=human', async () => {
    const res = await postHumanHybrid({
      query: 'full bodied red wine',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('human');
    expect(body['query_type']).toBe('search');
    expect(Array.isArray(body['results'])).toBe(true);
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['total_candidates']).toBe('number');
  });

  it.each([
    ['missing required query field', () => postHumanHybrid({}), 400],
    ['text/plain body', () => injectTextPlain('/v1/search/hybrid', { query: 'test' }), 415],
  ])('rejects %s', async (_label, runRequest, expectedStatus) => {
    const response = await runRequest();
    expect(response.statusCode).toBe(expectedStatus);
    if (expectedStatus === 400) {
      expectRequestIdErrorShape(response.json() as Record<string, unknown>);
    }
  });

  it('surfaces canonical authority/runtime metadata for hybrid comparison responses', async () => {
    const res = await postJson(
      server.app,
      '/v1/search/hybrid',
      { query: 'Opus One vs Screaming Eagle' },
      { ...ACCEPT_HUMAN, 'x-request-id': 'req-v2-hybrid-compare-123' },
    );

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['query_type']).toBe('comparison');
    expect(body['query_id']).toBe('req-v2-hybrid-compare-123');
    expect(body['runtime_correlation_ref']).toBe('req-v2-hybrid-compare-123');
    expect(typeof body['authority_trace_ref']).toBe('string');
    expect(decodeAuthorityTraceRefDetailed(String(body['authority_trace_ref']))).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// V2 interpret
// ---------------------------------------------------------------------------

describe('POST /v1/search/interpret + Accept human — V2 interpret response shape', () => {
  it('returns 200 with version=2 and responseType=interpret', async () => {
    const res = await postHumanInterpret({
      query: 'Opus One 2018',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['version']).toBe('2');
    expect(body['response_type']).toBe('interpret');
    expect(typeof body['query_id']).toBe('string');
    expect(typeof body['query_text']).toBe('string');
    expect(typeof body['detected_intent']).toBe('string');
    expect(Array.isArray(body['active_channels'])).toBe(true);
    expect(Array.isArray(body['applied_constraints'])).toBe(true);
    expect(Array.isArray(body['ranking_signals'])).toBe(true);
    expect((body['ranking_signals'] as unknown[]).length).toBeGreaterThan(0);
    expect(typeof body['confidence']).toBe('number');
  });

  it('reuses X-Request-Id as the surfaced query_id for correlation', async () => {
    const res = await postJson(
      server.app,
      '/v1/search/interpret',
      { query: 'Opus One 2018' },
      { ...ACCEPT_HUMAN, 'x-request-id': 'req-v2-interpret-123' },
    );

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['query_id']).toBe('req-v2-interpret-123');
  });

  it.each([
    ['missing required query field', () => postHumanInterpret({}), 400],
    ['unknown request fields', () => postHumanInterpret({ query: 'Opus One 2018', futureFlag: true }), 400],
    ['text/plain body', () => injectTextPlain('/v1/search/interpret', { query: 'test' }), 415],
  ])('rejects %s', async (_label, runRequest, expectedStatus) => {
    const response = await runRequest();
    expect(response.statusCode).toBe(expectedStatus);
    if (expectedStatus === 400) {
      expectRequestIdErrorShape(response.json() as Record<string, unknown>);
    }
  });

  it('surfaces canonical comparison channels for plain comparison queries', async () => {
    const res = await postHumanInterpret({
      query: 'Barolo vs Amarone',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['response_type']).toBe('interpret');
    expect(body['detected_intent']).toBe('comparison');
    const activeChannels = body['active_channels'];
    expect(Array.isArray(activeChannels)).toBe(true);
    expect(activeChannels).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'compare_anchor',
    ]);
    expect(new Set(activeChannels as string[]).size).toBe(
      (activeChannels as string[]).length,
    );
    expect(activeChannels).not.toContain('sparse');
    expect(activeChannels).not.toContain('dense');
    expect(activeChannels).not.toContain('learned_sparse');
  });

  it('surfaces compare_anchor for side-by-side candidate comparison queries', async () => {
    const res = await postHumanInterpret({
      query: 'opus one vs napa cabs',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['detected_intent']).toBe('comparison');
    expect(body['decomposition_strategy']).toBe('comparison');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'compare_anchor',
    ]);
  });

  it('surfaces browse_region for hierarchical region browse queries', async () => {
    const res = await postHumanInterpret({
      query: 'Bordeaux/Medoc/Pauillac',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['detected_intent']).toBe('region_browse');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'browse_region',
    ]);
  });

  it('surfaces anchor_similarity for recommendation queries anchored on a reference wine', async () => {
    const res = await postHumanInterpret({
      query: 'wines cheaper than Opus One',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
  });

  it('surfaces canonical activeChannels for recommendation queries without leaking legacy aliases', async () => {
    const res = await postHumanInterpret({
      query: 'wines like Sassicaia',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(new Set(body['active_channels'] as string[]).size).toBe(
      (body['active_channels'] as string[]).length,
    );
    expect(body['active_channels']).not.toContain('sparse');
    expect(body['active_channels']).not.toContain('dense');
    expect(body['active_channels']).not.toContain('compare_anchor');
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });

  it('surfaces decomposition strategy for comparison queries without leaking V1 planner fields', async () => {
    const res = await postHumanInterpret({
      query: 'Barolo vs Amarone',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body['decomposition_strategy']).toBe('comparison');
    expect(body['query_text']).toBe('Barolo vs Amarone');
    expect(body['raw_query']).toBeUndefined();
    expect(body['normalized_query']).toBeUndefined();
    expect(body['route']).toBeUndefined();
  });

  it('surfaces attribute-level hard constraints instead of count labels', async () => {
    const res = await postHumanInterpret({
      query: 'red wine from france',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('attribute_constrained');
    expect(body['applied_constraints']).toEqual(['hard:wine_type', 'hard:country']);
  });

  it('surfaces attribute-level soft constraints for budget-style queries', async () => {
    const res = await postHumanInterpret({
      query: 'Chardonnay under 50 dollars',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['applied_constraints']).toEqual(['hard:grape_primary', 'soft:price_usd']);
  });

  it('surfaces compare_anchor for anchor-vs-catalog comparison queries', async () => {
    const res = await postHumanInterpret({
      query: 'opus one vs napa cabs',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('comparison');
    expect(body['decomposition_strategy']).toBe('comparison');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'compare_anchor',
    ]);
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });

  it('surfaces browse_region for region-browse queries', async () => {
    const res = await postHumanInterpret({
      query: 'Bordeaux/Medoc/Pauillac',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('region_browse');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'browse_region',
    ]);
  });

  it('surfaces anchor_similarity for anchor-conditioned recommendation queries', async () => {
    const res = await postHumanInterpret({
      query: 'wines cheaper than Opus One',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });

  it('surfaces anchor_similarity for English relative-anchor recommendation queries', async () => {
    const res = await postHumanInterpret({
      query: 'cheaper than Chateau Margaux',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });

  it('surfaces anchor_similarity for Korean relative-anchor recommendation queries', async () => {
    const res = await postHumanInterpret({
      query: '샤토 마고보다 저렴한 와인',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });

  it('surfaces anchor_similarity for Korean similarity-anchor recommendation queries', async () => {
    const res = await postHumanInterpret({
      query: '오퍼스 원 같은 와인',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['detected_intent']).toBe('recommendation');
    expect(body['active_channels']).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(body['ranking_signals']).toContain('anchor_similarity');
  });
});

// ---------------------------------------------------------------------------
// V1 routes unchanged
// ---------------------------------------------------------------------------

describe('V1 routes — shape unchanged', () => {
  it('POST /v1/search still returns V1 shape (no top-level version/responseType)', async () => {
    const res = await postJson(server.app, '/v1/search', {
      query: 'Opus One 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // V1 response has query_type, engine_decision, results, meta — NOT version/responseType
    expect(body['query_type']).toBe('search');
    expect(body['engine_decision']).toBeDefined();
    expect(body['meta']).toBeDefined();
    // No top-level version or response_type in V1
    expect(body['response_type']).toBeUndefined();
  });

  it('POST /v1/search/interpret still returns V1 interpret shape', async () => {
    const res = await postJson(server.app, '/v1/search/interpret', {
      query: 'Opus One 2018',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // V1 interpret has raw_query, intent, route — NOT version/responseType
    expect(body['raw_query']).toBeDefined();
    expect(body['normalized_query']).toBeDefined();
    expect(body['intent']).toBeDefined();
    expect(body['route']).toBeDefined();
    expect(body['query_class']).toBeDefined();
    expect(body['policy']).toBeDefined();
    expect(body['constraints']).toBeDefined();
    expect(body['version']).toBeUndefined();
    expect(body['response_type']).toBeUndefined();
    expect(body['query_id']).toBeUndefined();
    expect(body['query_text']).toBeUndefined();
    expect(body['detected_intent']).toBeUndefined();
    expect(body['active_channels']).toBeUndefined();
    expect(body['applied_constraints']).toBeUndefined();
    expect(body['ranking_signals']).toBeUndefined();
    expect(body['confidence']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /v1/claude-tools unchanged
// ---------------------------------------------------------------------------

describe('GET /v1/claude-tools — unchanged', () => {
  it('returns 200 with a tools list', async () => {
    const res = await getJson(server.app, '/v1/claude-tools');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Array.isArray(body['tools'])).toBe(true);
    expect(typeof body['request_id']).toBe('string');
  });
});
