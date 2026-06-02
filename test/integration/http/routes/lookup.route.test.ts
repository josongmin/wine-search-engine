import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerLookupWineRoute } from '../../../../src/interface/http/routes/primitive-search.route.js';
import type { SearchRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../../src/domain/response/model/comparison-response.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import { MAX_QUERY_LENGTH } from '../../../../src/domain/shared/constants.js';

const CANONICAL_ENTITY_TRACE_REF =
  'decision:v1:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// Korean fixture construction: build NFC/NFD test inputs from code points so
// the tests never depend on the source file's own encoding form. Editors and
// review tooling sometimes silently re-normalize Korean literals on save,
// which would invalidate hand-typed NFC/NFD comparisons.
// ---------------------------------------------------------------------------
// 샤 (sya) — single precomposed Hangul syllable, U+C144 → bytes for "샤".
// We compute it from the Choseong + Jungseong jamo so the test is reproducible.
const HANGUL_S_CHOSEONG = 'ᄉ'; // ᄉ
const HANGUL_YA_JUNGSEONG = 'ᅣ'; // ᅣ
const SHA_NFD = HANGUL_S_CHOSEONG + HANGUL_YA_JUNGSEONG; // 2 code units
const SHA_NFC = SHA_NFD.normalize('NFC'); // 1 code unit (precomposed 샤)

function buildSnapshot() {
  return {
    snapshot_id: 'snap-lookup-1',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'search_response_v1',
  };
}

/**
 * Build a minimal SearchResponseV1 with empty results. Use cases that fail to
 * resolve an entity (lookup miss) return this shape — the lookup route never
 * 404s; the empty/failed payload is the documented "not found" surface.
 */
function buildEmptyLookupResponse(overrides?: {
  decisionStatus?: 'failed' | 'resolved';
  failureReason?: string;
}): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: overrides?.decisionStatus ?? 'failed',
      nextAction: 'fail',
      route: 'entity',
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: CANONICAL_ENTITY_TRACE_REF,
      decisionSnapshot: buildSnapshot(),
      failure_reason: overrides?.failureReason ?? 'NO_RESULTS',
    },
    results: [],
    meta: {
      requestId: 'test-request',
      queryTimeMs: 1,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: buildSnapshot(),
      response_hash: 'hash-lookup',
    },
  };
}

function makeDeps(executeMock = vi.fn().mockResolvedValue(buildEmptyLookupResponse())): SearchRouteDeps {
  return {
    searchUseCase: {
      execute: executeMock,
    },
  };
}

async function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

describe('POST /v1/lookup/wine', () => {
  let app: FastifyInstance;
  let deps: SearchRouteDeps;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps();
    registerLookupWineRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects caller-provided mode overrides and keeps lane authority on the path', async () => {
    // The lookup endpoint is entity-only and the compatibility `options`
    // envelope is intentionally narrow. Callers cannot smuggle a lane/mode
    // override through the body; the route must fail closed instead of
    // silently accepting incompatible knobs.
    const response = await post(app, '/v1/lookup/wine', {
      query: 'Opus One 2018',
      options: {
        mode: 'hybrid',
        explain: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
  });

  it('forwards the same observability execution options shape as the discovery primitives', async () => {
    const response = await post(app, '/v1/lookup/wine', { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    expect(deps.searchUseCase.execute).toHaveBeenCalledTimes(1);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[2]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
      stageTimer: expect.any(Object),
    });
    expect(args?.[2]).toHaveProperty('debugRequest');
  });

  it('returns 200 with empty results when the entity is not found (not 404)', async () => {
    // Lookup never returns 404 — a miss surfaces as the SearchResponseV1
    // empty-result + failure_reason envelope. Callers detect "not found" via
    // results.length === 0 and engine_decision.failure_reason.
    deps.searchUseCase.execute = vi
      .fn()
      .mockResolvedValue(buildEmptyLookupResponse({ failureReason: 'NO_RESULTS' }));

    const response = await post(app, '/v1/lookup/wine', { query: 'this-wine-does-not-exist-9999' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results).toEqual([]);
    expect(body.engine_decision.failure_reason).toBe('NO_RESULTS');
  });

  it('prefers the V2 compatibility seam when it is wired', async () => {
    const compatibilityResponse = buildEmptyLookupResponse({ decisionStatus: 'resolved' });
    const compatibilityExecute = vi.fn().mockResolvedValue(compatibilityResponse);
    deps = {
      ...deps,
      lookupWineV2CompatibilityUseCase: {
        execute: compatibilityExecute,
      },
      searchUseCase: {
        execute: vi.fn(),
      },
    };
    await app.close();
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    registerLookupWineRoute(app, deps);
    await app.ready();

    const response = await post(app, '/v1/lookup/wine', {
      query: 'Opus One 2018',
      context: { locale: 'ko', currency: 'KRW' },
      limit: 3,
    });

    expect(response.statusCode).toBe(200);
    expect(compatibilityExecute).toHaveBeenCalledWith(
      {
        query: 'Opus One 2018',
        limit: 3,
        locale: 'ko',
        requestId: expect.any(String),
      },
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        stageTimer: expect.any(Object),
      }),
    );
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
  });

  it('accepts Korean entity aliases (NFC composed) and forwards the query unchanged', async () => {
    // Korean queries are first-class citizens. The route must not lossy-encode
    // them on the way to the use case (entity alias resolution happens
    // downstream of HTTP).
    const koreanQuery = `${SHA_NFC} 2016`;
    const response = await post(app, '/v1/lookup/wine', { query: koreanQuery });

    expect(response.statusCode).toBe(200);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: koreanQuery, retrieval_mode: 'entity' });
  });

  it('preserves Korean NFC and NFD forms verbatim at the route boundary', async () => {
    // The route does not normalize Unicode forms — that is the entity-identity
    // layer's job. We assert here that whatever NFC/NFD form the client sends
    // is what the use case sees. Without this guarantee, an upstream silent
    // re-normalization could break canonical alias matching downstream.
    // SHA_NFC is 1 code unit (precomposed 샤); SHA_NFD is 2 code units (샤).
    expect(SHA_NFC.length).toBe(1);
    expect(SHA_NFD.length).toBe(2);
    expect(SHA_NFC).not.toBe(SHA_NFD);
    // Both collapse to the same NFC form.
    expect(SHA_NFD.normalize('NFC')).toBe(SHA_NFC);

    await post(app, '/v1/lookup/wine', { query: SHA_NFC });
    await post(app, '/v1/lookup/wine', { query: SHA_NFD });

    const calls = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    // Each call gets the EXACT Unicode form the client sent — the route does
    // not auto-collapse NFD into NFC at the boundary.
    expect(calls[0]?.[0]).toMatchObject({ query: SHA_NFC });
    expect(calls[1]?.[0]).toMatchObject({ query: SHA_NFD });
    expect((calls[1]?.[0] as { query: string }).query.length).toBe(2);
  });

  it('rejects missing query field with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, '/v1/lookup/wine', {});

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.request_id).toEqual(expect.any(String));
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects empty-string query with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, '/v1/lookup/wine', { query: '' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects oversized query (> MAX_QUERY_LENGTH chars) with 400 + RFC-014 envelope', async () => {
    const oversized = 'a'.repeat(MAX_QUERY_LENGTH + 1);

    const response = await post(app, '/v1/lookup/wine', { query: oversized });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
  });

  it('accepts a query of EXACTLY MAX_QUERY_LENGTH chars (boundary just inside)', async () => {
    // Schema-bound boundary test (CLAUDE.md test-discipline rule 6): a value
    // just inside the bound must pass; rule 6 also requires a value just
    // outside, covered by the oversized test above.
    const boundary = 'a'.repeat(MAX_QUERY_LENGTH);

    const response = await post(app, '/v1/lookup/wine', { query: boundary });

    expect(response.statusCode).toBe(200);
    expect(deps.searchUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a comparison-typed use-case response with 400 INVALID_REQUEST', async () => {
    // The decomposition detector runs BEFORE route dispatch and may return a
    // ComparisonSearchResponse even when retrieval_mode is forced to 'entity'.
    // The lookup route must refuse it — a single-entity caller should never
    // receive a "wine A vs wine B" response shape.
    const comparison: ComparisonSearchResponse = {
      queryType: 'comparison',
      originalQuery: 'A vs B',
      comparisonIntent: 'compare',
      entities: [],
      meta: {
        requestId: 'test-request',
        queryTimeMs: 1,
        route: 'entity',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decisionSnapshot: buildSnapshot(),
        response_hash: 'hash-comparison',
      },
    } as unknown as ComparisonSearchResponse;

    deps.searchUseCase.execute = vi.fn().mockResolvedValue(comparison);

    const response = await post(app, '/v1/lookup/wine', { query: 'Opus One vs Caymus' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.request_id).toEqual(expect.any(String));
  });

  it('threads requestId through to the use case and into the response meta', async () => {
    deps.searchUseCase.execute = vi
      .fn()
      .mockImplementation(async (_req: unknown, requestId: string) => {
        const r = buildEmptyLookupResponse({ failureReason: 'NO_RESULTS' });
        return {
          ...r,
          meta: { ...r.meta, requestId },
        };
      });

    const response = await post(app, '/v1/lookup/wine', { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    const usedRequestId = args?.[1] as string;
    expect(usedRequestId).toEqual(expect.any(String));
    expect(usedRequestId.length).toBeGreaterThan(0);
    const body = response.json();
    expect(body.meta.request_id).toBe(usedRequestId);
  });

  it('accepts queries containing special chars and forwards them verbatim', async () => {
    // Lookup payloads are JSON bodies, not URL query strings — special chars
    // need no encoding. The route must not strip or escape them.
    const query = "Chateau d'Yquem -- 2010 (Sauternes) <>&\"";

    const response = await post(app, '/v1/lookup/wine', { query });

    expect(response.statusCode).toBe(200);
    const args = (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query });
  });

  it('passes an AbortSignal to the use case for cooperative cancellation', async () => {
    // The route plumbs request-abort into the use case. Without this signal,
    // long-running lookups cannot be cancelled when the client disconnects.
    let capturedSignal: AbortSignal | undefined;
    deps.searchUseCase.execute = vi.fn().mockImplementation(
      async (_req: unknown, _requestId: string, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        return buildEmptyLookupResponse();
      },
    );

    const response = await post(app, '/v1/lookup/wine', { query: 'Opus One' });

    expect(response.statusCode).toBe(200);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
