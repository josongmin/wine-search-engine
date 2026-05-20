import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerResolveRoute } from '../../../../src/interface/http/routes/resolve.route.js';
import type { ResolveRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { resolveIncomingRequestId } from '../../../../src/interface/http/request-id.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import { MAX_QUERY_LENGTH } from '../../../../src/domain/shared/constants.js';

// ---------------------------------------------------------------------------
// Canonical decision-trace ref shape used across all happy-path mocks.
// Matches CANONICAL_AUTHORITY_TRACE_REF_PATTERN
//   `^(decision|admission):v1:[A-Za-z0-9_]+:[a-f0-9]{64}$`.
// Both decision_trace_ref and authority_trace_ref must be EQUAL on resolve
// responses (superRefine in ResolveResponseSchema). Keeping a single constant
// keeps all fixtures in lock-step.
// ---------------------------------------------------------------------------
const CANONICAL_TRACE_REF =
  'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// Korean fixture construction: build NFC/NFD test inputs from code points so
// the tests never depend on the source file's own encoding form. Editors and
// review tooling sometimes silently re-normalize Korean literals on save,
// which would invalidate hand-typed NFC/NFD comparisons.
// ---------------------------------------------------------------------------
// 샤 (sya) — single precomposed Hangul syllable.
// We compute it from Choseong + Jungseong jamo so the test is reproducible.
const HANGUL_S_CHOSEONG = 'ᄉ';
const HANGUL_YA_JUNGSEONG = 'ᅣ';
const SHA_NFD = HANGUL_S_CHOSEONG + HANGUL_YA_JUNGSEONG; // 2 code units
const SHA_NFC = SHA_NFD.normalize('NFC'); // 1 code unit (precomposed 샤)

function buildResolvedResponse(overrides?: {
  status?: 'resolved' | 'ambiguous' | 'failed';
  candidates?: ReadonlyArray<Record<string, unknown>>;
  topEntity?: Record<string, unknown> | undefined;
  requestId?: string;
}) {
  // Distinguish "caller explicitly passed topEntity: undefined" (omit it) from
  // "caller did not mention topEntity at all" (use the default Opus One stub).
  // Without this, mocking a status=ambiguous/failed response always carried a
  // stray top_entity that violates the conformal-prediction abstention shape.
  const hasExplicitTopEntity =
    overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, 'topEntity');
  const topEntityValue = hasExplicitTopEntity
    ? overrides?.topEntity
    : {
        entityId: 'wine-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        calibratedScore: 0.99,
      };
  return {
    status: overrides?.status ?? 'resolved',
    candidates: overrides?.candidates ?? [
      {
        entityId: 'wine-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        rank: 1,
        calibratedScore: 0.99,
        evidenceRefs: ['opus one'],
      },
    ],
    // Omit topEntity entirely (rather than setting to undefined) so the snake
    // case serializer does not emit `top_entity: undefined` in the JSON body.
    ...(topEntityValue !== undefined ? { topEntity: topEntityValue } : {}),
    decision_trace_ref: CANONICAL_TRACE_REF,
    authority_trace_ref: CANONICAL_TRACE_REF,
    request_id: overrides?.requestId ?? 'test-request',
  };
}

function makeDeps(
  executeMock = vi.fn().mockResolvedValue(buildResolvedResponse()),
): ResolveRouteDeps {
  return { resolveUseCase: { execute: executeMock } };
}

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/entity/resolve',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

// ---------------------------------------------------------------------------
// Pre-existing tests preserved verbatim (other than `beforeAll` → `beforeEach`
// app rebuild, which is required so each test gets a fresh deps mock instead
// of mutating a long-lived singleton). The new regression suite below extends
// this file to bump maturity 2 → 3 for tools.resolve.
// ---------------------------------------------------------------------------
describe('POST /v1/entity/resolve', () => {
  let app: FastifyInstance;
  let deps: ResolveRouteDeps;

  beforeEach(async () => {
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps();
    registerResolveRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Preserved legacy assertions
  // -------------------------------------------------------------------------
  it('passes requestId through to the resolve use case', async () => {
    const response = await post(app, { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ request_id: expect.any(String) }));
    expect(deps.resolveUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Opus One 2018', requestId: expect.any(String) }),
      expect.any(Object),
    );
  });

  it('passes queryBudget through to the resolve use case', async () => {
    const response = await post(app, {
      query: 'Opus One 2018',
      queryBudget: { maxLatencyMs: 750, maxCandidates: 16, rerankLimit: 8 },
    });

    expect(response.statusCode).toBe(200);
    expect(deps.resolveUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        queryBudget: { maxLatencyMs: 750, maxCandidates: 16, rerankLimit: 8 },
      }),
      expect.any(Object),
    );
  });

  it('accepts resolver provenance fields on candidate responses', async () => {
    deps.resolveUseCase.execute = vi.fn().mockResolvedValue({
      status: 'ambiguous',
      candidates: [
        {
          entityId: 'wine-opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          rank: 1,
          calibratedScore: 0.77,
          evidenceRefs: ['opus one'],
          source: 'blocker_seed',
          sources: ['alias', 'blocker_seed'],
          blockerSeed: true,
        },
      ],
      topEntity: undefined,
      decision_trace_ref: CANONICAL_TRACE_REF,
      authority_trace_ref: CANONICAL_TRACE_REF,
      request_id: 'test-request',
    });

    const response = await post(app, { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidates: [
        { source: 'blocker_seed', sources: ['alias', 'blocker_seed'], blocker_seed: true },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // Happy-path: response shape — candidates + top_entity + trace refs + status
  // -------------------------------------------------------------------------
  it('returns 200 with full ResolveResponse shape on resolved entity', async () => {
    // Asserts the contract surface a downstream consumer relies on:
    //   - status === 'resolved'
    //   - candidates[] with rank/calibrated_score
    //   - top_entity present with entity_id + calibrated_score
    //   - decision_trace_ref / authority_trace_ref EQUAL and canonical-shaped
    // The route response is snake_cased by deepKeysToSnake, so we assert
    // snake_case keys here (top_entity, calibrated_score, entity_id).
    const response = await post(app, { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('resolved');
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      entity_id: 'wine-opus-one-2018',
      canonical_label: 'Opus One 2018',
      rank: 1,
      calibrated_score: 0.99,
    });
    expect(body.top_entity).toMatchObject({
      entity_id: 'wine-opus-one-2018',
      canonical_label: 'Opus One 2018',
      calibrated_score: 0.99,
    });
    expect(body.decision_trace_ref).toBe(CANONICAL_TRACE_REF);
    expect(body.authority_trace_ref).toBe(CANONICAL_TRACE_REF);
    // RFC-006: authority_trace_ref MUST equal decision_trace_ref for resolve.
    expect(body.authority_trace_ref).toBe(body.decision_trace_ref);
  });

  it('returns status="ambiguous" with multiple candidates and no top_entity', async () => {
    // Conformal prediction → abstention surface. When the resolver cannot pick
    // a unique winner, the contract is:
    //   - status: 'ambiguous'
    //   - >1 candidate
    //   - top_entity omitted
    // This is the documented abstention shape — there is no separate `abstention`
    // boolean field on the resolve contract; ambiguity is signalled by
    // status === 'ambiguous' + absent top_entity.
    deps.resolveUseCase.execute = vi.fn().mockResolvedValue(
      buildResolvedResponse({
        status: 'ambiguous',
        topEntity: undefined,
        candidates: [
          {
            entityId: 'wine-margaux-2015',
            canonicalLabel: 'Château Margaux 2015',
            rank: 1,
            calibratedScore: 0.52,
            evidenceRefs: ['margaux'],
          },
          {
            entityId: 'wine-margaux-2016',
            canonicalLabel: 'Château Margaux 2016',
            rank: 2,
            calibratedScore: 0.48,
            evidenceRefs: ['margaux'],
          },
        ],
      }),
    );

    const response = await post(app, { query: 'margaux' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ambiguous');
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(body.top_entity).toBeUndefined();
  });

  it('returns status="failed" with empty candidates on no match', async () => {
    // The "no match" surface: status === 'failed', candidates: [], no top_entity.
    // The route still returns 200 (the resolver is not an error condition — a
    // miss is a valid outcome and travels via the contracted envelope).
    deps.resolveUseCase.execute = vi.fn().mockResolvedValue(
      buildResolvedResponse({ status: 'failed', candidates: [], topEntity: undefined }),
    );

    const response = await post(app, { query: 'zzzzz-nonexistent-wine-9999' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('failed');
    expect(body.candidates).toEqual([]);
    expect(body.top_entity).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Korean — first-class language; rule 5 + 8 of CLAUDE.md test discipline.
  // -------------------------------------------------------------------------
  it('forwards Korean queries (NFC composed) verbatim to the use case', async () => {
    // 오푸스 원 — canonical Korean alias for "Opus One".
    const koreanQuery = '오푸스 원';
    const response = await post(app, { query: koreanQuery });

    expect(response.statusCode).toBe(200);
    const args = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: koreanQuery });
  });

  it('forwards Korean aliases like 샤또 마고 to the use case unchanged', async () => {
    // Alias resolution itself is downstream of HTTP — we only assert the
    // route is Unicode-transparent for Korean inputs.
    const koreanQuery = '샤또 마고';
    const response = await post(app, { query: koreanQuery });

    expect(response.statusCode).toBe(200);
    const args = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: koreanQuery });
  });

  it('preserves Korean NFC and NFD forms verbatim at the route boundary', async () => {
    // The route does not normalize Unicode forms — that is the entity-identity
    // layer's job. A silent re-normalization at HTTP would break the resolver's
    // NFC/NFD-aware alias lookup downstream.
    // SHA_NFC is 1 code unit (precomposed 샤); SHA_NFD is 2 code units (샤).
    expect(SHA_NFC.length).toBe(1);
    expect(SHA_NFD.length).toBe(2);
    expect(SHA_NFC).not.toBe(SHA_NFD);
    expect(SHA_NFD.normalize('NFC')).toBe(SHA_NFC);

    await post(app, { query: SHA_NFC });
    await post(app, { query: SHA_NFD });

    const calls = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({ query: SHA_NFC });
    expect(calls[1]?.[0]).toMatchObject({ query: SHA_NFD });
    expect((calls[1]?.[0] as { query: string }).query.length).toBe(2);
  });

  it('accepts English-only queries and forwards them verbatim', async () => {
    const response = await post(app, { query: 'opus one' });

    expect(response.statusCode).toBe(200);
    const args = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: 'opus one' });
  });

  // -------------------------------------------------------------------------
  // Validation: RFC-014 error envelope on bad inputs.
  // -------------------------------------------------------------------------
  it('rejects missing query field with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, {});

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.request_id).toEqual(expect.any(String));
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(deps.resolveUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects empty-string query with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, { query: '' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.resolveUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects oversized query (> MAX_QUERY_LENGTH chars) with 400 + RFC-014 envelope', async () => {
    // Schema-bound boundary test (CLAUDE.md test-discipline rule 6): a value
    // JUST OUTSIDE the bound. The corresponding JUST-INSIDE case is covered by
    // the next test.
    const oversized = 'a'.repeat(MAX_QUERY_LENGTH + 1);

    const response = await post(app, { query: oversized });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.resolveUseCase.execute).not.toHaveBeenCalled();
  });

  it('accepts a query of EXACTLY MAX_QUERY_LENGTH chars (boundary just inside)', async () => {
    // Boundary just inside the schema bound — pairs with the just-outside
    // oversized test above to give bidirectional coverage of the limit.
    const boundary = 'a'.repeat(MAX_QUERY_LENGTH);

    const response = await post(app, { query: boundary });

    expect(response.statusCode).toBe(200);
    expect(deps.resolveUseCase.execute).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Adjacent regression: special chars / request-id threading / abort signal.
  // -------------------------------------------------------------------------
  it('preserves special chars, quotes, and apostrophes verbatim in the query', async () => {
    // Resolve payloads are JSON bodies, not URL query strings — special chars
    // need no encoding. The route must not strip or escape them.
    const query = "Chateau d'Yquem -- 2010 (Sauternes) <>&\"";

    const response = await post(app, { query });

    expect(response.statusCode).toBe(200);
    const args = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query });
  });

  it('threads the X-Request-Id header through to the use case and into the response', async () => {
    // The X-Request-Id header sets the canonical request id used by the
    // resolver and is mirrored back in the response body as `request_id`.
    // This is the contract for distributed tracing across the resolver chain.
    deps.resolveUseCase.execute = vi.fn().mockImplementation(
      async (req: { requestId?: string }) =>
        buildResolvedResponse({ requestId: req.requestId ?? 'unknown' }),
    );

    const inboundRequestId = 'req-resolve-fixture-12345';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/entity/resolve',
      headers: { 'content-type': 'application/json', 'x-request-id': inboundRequestId },
      payload: { query: 'Opus One 2018' },
    });

    expect(response.statusCode).toBe(200);
    const args = (deps.resolveUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((args?.[0] as { requestId?: string }).requestId).toBe(inboundRequestId);
    const body = response.json();
    expect(body.request_id).toBe(inboundRequestId);
  });

  it('passes an AbortSignal to the use case for cooperative cancellation', async () => {
    // The route plumbs request-abort into the use case. Without this signal,
    // long-running resolve calls cannot be cancelled when the client
    // disconnects. We assert the option exists and is an AbortSignal.
    let capturedSignal: AbortSignal | undefined;
    deps.resolveUseCase.execute = vi.fn().mockImplementation(
      async (_req: unknown, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        return buildResolvedResponse();
      },
    );

    const response = await post(app, { query: 'Opus One' });

    expect(response.statusCode).toBe(200);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces unexpected use case errors as RFC-014 envelope (not a 200 fabricated success)', async () => {
    // Per CLAUDE.md "schema quality bar": unexpected errors MUST NOT be
    // mapped to a fake success-shaped 200. They must travel through the
    // error handler and emit the RFC-014 envelope.
    deps.resolveUseCase.execute = vi.fn().mockRejectedValue(new Error('boom'));

    const response = await post(app, { query: 'Opus One' });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.statusCode).toBeLessThan(600);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.request_id).toEqual(expect.any(String));
    expect(body.error.code.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy-shaped fixture suite is kept for completeness — confirms the original
// beforeAll/beforeEach pattern still passes against the same route.
// ---------------------------------------------------------------------------
describe('POST /v1/entity/resolve (legacy fixture suite)', () => {
  let app: FastifyInstance;
  let mockDeps: ResolveRouteDeps;

  beforeAll(async () => {
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    mockDeps = {
      resolveUseCase: {
        execute: vi.fn().mockResolvedValue(buildResolvedResponse()),
      },
    };

    registerResolveRoute(app, mockDeps);
  });

  beforeEach(() => {
    mockDeps.resolveUseCase.execute = vi.fn().mockResolvedValue(buildResolvedResponse());
  });

  afterAll(async () => {
    await app.close();
  });

  it('legacy: returns request_id and forwards query', async () => {
    const response = await post(app, { query: 'Opus One 2018' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ request_id: expect.any(String) }));
  });
});
