import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAutocompleteRoute } from '../../../../src/interface/http/routes/autocomplete.route.js';
import type { AutocompleteRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import { MAX_QUERY_LENGTH } from '../../../../src/domain/shared/constants.js';
import type { AutocompleteResponse } from '../../../../src/application/search/autocomplete-response.dto.js';

// ---------------------------------------------------------------------------
// Reproducible Korean fixtures.
//
// Editors and review tooling sometimes silently re-normalize Hangul on save,
// which would invalidate hand-typed NFC/NFD comparisons. Build "오푸" from
// Choseong/Jungseong jamo so the bytes never depend on this file's encoding.
// 오 = U+C624, 푸 = U+D478 (precomposed); their NFD decompositions are below.
// ---------------------------------------------------------------------------
const HANGUL_IEUNG = 'ᄋ';     // ᄋ Choseong
const HANGUL_O_VOWEL = 'ᅩ';   // ᅩ Jungseong
const HANGUL_P = 'ᄑ';         // ᄑ Choseong
const HANGUL_U_VOWEL = 'ᅮ';   // ᅮ Jungseong
const OH_NFD = HANGUL_IEUNG + HANGUL_O_VOWEL;
const PU_NFD = HANGUL_P + HANGUL_U_VOWEL;
const OHPU_NFD = OH_NFD + PU_NFD;                  // 4 code units
const OHPU_NFC = OHPU_NFD.normalize('NFC');        // 2 code units (오푸)

const CANONICAL_AUTOCOMPLETE_TRACE_REF =
  'decision:v1:autocomplete:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function buildAutocompleteResponse(overrides?: {
  status?: AutocompleteResponse['status'];
  suggestions?: AutocompleteResponse['suggestions'];
}): AutocompleteResponse {
  return {
    status: overrides?.status ?? 'resolved',
    suggestions: overrides?.suggestions ?? [
      {
        entity: {
          entity_id: 'wine-opus-one-2018',
          canonical_label: 'Opus One 2018',
          entity_type: 'wine',
          producer: 'Opus One',
          region: 'Napa Valley',
        },
        rank: 1,
        calibrated_score: 0.99,
        source: 'alias',
      },
      {
        entity: {
          entity_id: 'wine-opus-one-2016',
          canonical_label: 'Opus One 2016',
          entity_type: 'wine',
        },
        rank: 2,
        calibrated_score: 0.92,
        source: 'alias',
      },
    ],
    decision_trace_ref: CANONICAL_AUTOCOMPLETE_TRACE_REF,
    authority_trace_ref: CANONICAL_AUTOCOMPLETE_TRACE_REF,
  };
}

function buildEmptyAutocompleteResponse(): AutocompleteResponse {
  return {
    status: 'failed',
    suggestions: [],
    decision_trace_ref: CANONICAL_AUTOCOMPLETE_TRACE_REF,
    authority_trace_ref: CANONICAL_AUTOCOMPLETE_TRACE_REF,
  };
}

function makeDeps(executeMock = vi.fn().mockResolvedValue(buildAutocompleteResponse())): AutocompleteRouteDeps {
  return {
    autocompleteUseCase: {
      execute: executeMock,
    },
  };
}

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/entity/autocomplete',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

describe('POST /v1/entity/autocomplete', () => {
  let app: FastifyInstance;
  let deps: AutocompleteRouteDeps;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps();
    registerAutocompleteRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Happy path: common ASCII prefix surface
  // -------------------------------------------------------------------------
  it('returns suggestions for a common ASCII prefix like "opu"', async () => {
    // The autocomplete contract guarantees that a short prefix forwards to the
    // resolver verbatim and that the suggestion list — including ranking — is
    // surfaced as-is. The route MUST NOT silently dedupe, reorder, or trim the
    // use case's output.
    const response = await post(app, { query: 'opu' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0].entity.canonical_label).toBe('Opus One 2018');
    expect(body.suggestions[1].entity.canonical_label).toBe('Opus One 2016');
    // Ranks are preserved in the order produced by the use case.
    expect(body.suggestions[0].rank).toBe(1);
    expect(body.suggestions[1].rank).toBe(2);
    expect(deps.autocompleteUseCase.execute).toHaveBeenCalledTimes(1);
    const args = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: 'opu' });
  });

  // -------------------------------------------------------------------------
  // Korean prefix surface
  // -------------------------------------------------------------------------
  it('accepts a Korean prefix (NFC) and forwards it verbatim to the use case', async () => {
    // Korean prefixes are first-class. The use case (entity-identity) handles
    // alias canonicalization; the route's job is to not lossy-encode the input.
    deps.autocompleteUseCase.execute = vi.fn().mockResolvedValue(
      buildAutocompleteResponse({
        suggestions: [
          {
            entity: {
              entity_id: 'wine-opus-one-2018',
              canonical_label: '오푸스 원 2018',
              entity_type: 'wine',
            },
            rank: 1,
            calibrated_score: 0.97,
            source: 'alias',
          },
        ],
      }),
    );

    const response = await post(app, { query: OHPU_NFC });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.suggestions[0].entity.canonical_label).toBe('오푸스 원 2018');
    const args = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: OHPU_NFC });
  });

  // -------------------------------------------------------------------------
  // Korean NFC vs NFD: route is a transport, not a normalizer
  // -------------------------------------------------------------------------
  it('preserves Korean NFC and NFD forms verbatim at the route boundary', async () => {
    // The route MUST NOT auto-normalize Korean input — that responsibility
    // belongs to the entity-identity layer downstream. Two clients sending
    // identical-looking "오푸" in different normal forms must both reach the
    // use case unchanged so canonical alias matching can apply a uniform
    // normalization policy across all entry points.
    expect(OHPU_NFC.length).toBe(2);
    expect(OHPU_NFD.length).toBe(4);
    expect(OHPU_NFC).not.toBe(OHPU_NFD);
    expect(OHPU_NFD.normalize('NFC')).toBe(OHPU_NFC);

    await post(app, { query: OHPU_NFC });
    await post(app, { query: OHPU_NFD });

    const calls = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0]?.[0] as { query: string }).query).toBe(OHPU_NFC);
    expect((calls[1]?.[0] as { query: string }).query).toBe(OHPU_NFD);
    expect((calls[1]?.[0] as { query: string }).query.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Single-char prefix
  // -------------------------------------------------------------------------
  it('accepts a single-character prefix and forwards it to the use case', async () => {
    // The HTTP schema bound is min 1 — single chars are legal at the boundary.
    // Typeahead UX issues a request as soon as the first character arrives.
    // Any minimum-prefix policy is enforced downstream (use case / resolver),
    // not at the HTTP boundary.
    const response = await post(app, { query: 'a' });

    expect(response.statusCode).toBe(200);
    expect(deps.autocompleteUseCase.execute).toHaveBeenCalledTimes(1);
    const args = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toMatchObject({ query: 'a' });
  });

  // -------------------------------------------------------------------------
  // Empty prefix — schema bound just outside (min 1)
  // -------------------------------------------------------------------------
  it('rejects empty-string query with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, { query: '' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.request_id).toEqual(expect.any(String));
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(deps.autocompleteUseCase.execute).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Missing field
  // -------------------------------------------------------------------------
  it('rejects missing query field with 400 + RFC-014 VALIDATION_ERROR envelope', async () => {
    const response = await post(app, {});

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.autocompleteUseCase.execute).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Oversized prefix — schema bound just outside (max MAX_QUERY_LENGTH)
  // -------------------------------------------------------------------------
  it('rejects oversized query (> MAX_QUERY_LENGTH chars) with 400 + RFC-014 envelope', async () => {
    const oversized = 'a'.repeat(MAX_QUERY_LENGTH + 1);

    const response = await post(app, { query: oversized });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(deps.autocompleteUseCase.execute).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Boundary: just inside MAX_QUERY_LENGTH
  // -------------------------------------------------------------------------
  it('accepts a query of EXACTLY MAX_QUERY_LENGTH chars (boundary just inside)', async () => {
    // Schema-bound boundary test (CLAUDE.md test-discipline rule 6): a value
    // just inside the bound must pass; rule 6 also requires a value just
    // outside, covered by the oversized test above.
    const boundary = 'a'.repeat(MAX_QUERY_LENGTH);

    const response = await post(app, { query: boundary });

    expect(response.statusCode).toBe(200);
    expect(deps.autocompleteUseCase.execute).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // No-match surface
  // -------------------------------------------------------------------------
  it('returns 200 with empty suggestions when nothing matches (not 404)', async () => {
    // Autocomplete never 404s — a miss surfaces as an empty suggestions list
    // with status 'failed'. UI consumers detect "no completions" via
    // suggestions.length === 0, not HTTP status.
    deps.autocompleteUseCase.execute = vi.fn().mockResolvedValue(buildEmptyAutocompleteResponse());

    const response = await post(app, { query: 'zzqxqxqxqx-no-match' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.suggestions).toEqual([]);
    expect(body.status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Adjacent regression: special characters preserved
  // -------------------------------------------------------------------------
  it('preserves special characters (apostrophe, accented Latin) in the forwarded query', async () => {
    // Autocomplete payloads are JSON bodies — apostrophes, accents, and HTML
    // metacharacters need no client-side escaping and the route must not
    // strip or transform them. This guards against accidental over-eager
    // sanitization at the HTTP layer.
    const query = "Château d'Yquem";

    const response = await post(app, { query });

    expect(response.statusCode).toBe(200);
    const args = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((args?.[0] as { query: string }).query).toBe(query);
  });

  // -------------------------------------------------------------------------
  // Adjacent regression: requestId threading
  // -------------------------------------------------------------------------
  it('threads a non-empty requestId through to the autocomplete use case', async () => {
    // The request-id middleware assigns a per-request id; the route mapper
    // forwards it into the use case's ResolveRequest. Without this, downstream
    // tracing/logging cannot correlate the HTTP request with the use-case run.
    const response = await post(app, { query: 'opu' });

    expect(response.statusCode).toBe(200);
    const args = (deps.autocompleteUseCase.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwarded = args?.[0] as { requestId?: string };
    expect(forwarded.requestId).toEqual(expect.any(String));
    expect(forwarded.requestId).toBeTruthy();
    expect((forwarded.requestId as string).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Adjacent regression: AbortSignal plumbing
  // -------------------------------------------------------------------------
  it('passes an AbortSignal to the autocomplete use case for cooperative cancellation', async () => {
    // Typeahead clients abort in-flight requests when the user keeps typing —
    // each keystroke supersedes the previous. The route MUST plumb a real
    // AbortSignal so the use case can short-circuit expensive resolver work
    // instead of running to completion against a disconnected socket.
    let capturedSignal: AbortSignal | undefined;
    deps.autocompleteUseCase.execute = vi.fn().mockImplementation(
      async (_req: unknown, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        return buildAutocompleteResponse();
      },
    );

    const response = await post(app, { query: 'opu' });

    expect(response.statusCode).toBe(200);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
