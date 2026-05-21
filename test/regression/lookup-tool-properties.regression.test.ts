/**
 * Property-based regression suite: `tools.lookup` (POST /v1/search/lookup)
 * agent/detail-fetch ENDPOINT contract.
 *
 * Scope (per directive): this file pins the LOOKUP HTTP-tool boundary
 * invariants — entity-only direct fetch by ID or exact label — NOT the
 * downstream entity-resolution internals (retrieval.entity-lookup). The
 * route is the seam under test; the use case is mocked at the
 * SearchExecutorPort boundary (NO LLM, NO net, NO DB).
 *
 * Invariants locked (each property: fast-check numRuns = 100):
 *
 *   1. Determinism — identical input ⇒ byte-identical downstream SearchRequest
 *      shape (query, retrieval_mode, options) on repeated invocation. Routing
 *      is forced 'entity' and never varies.
 *   2. retrieval_mode is ALWAYS 'entity' — no caller field can override it,
 *      and clarification is ALWAYS false (lookup wants a direct answer).
 *   3. Query verbatim forwarding — the route does NOT normalize Unicode at the
 *      boundary; whatever NFC/NFD form the client sends is what the use case
 *      sees (NFC collapse is the entity-identity layer's job, downstream).
 *      We additionally assert NFC-equivalence so canonical alias matching is
 *      sound: NFC and NFD of the same Korean label normalize to ONE string.
 *   4. Input schema validation is fail-CLOSED on the validated axes:
 *      missing/empty/whitespace/oversized query ⇒ 400 RFC-014 VALIDATION_ERROR,
 *      and search is NEVER invoked. The body schema is `.strict()` (HTTP body,
 *      NOT an LLM tool-call input — CLAUDE.md rule 10 exception does not apply):
 *      unknown top-level fields ⇒ 400.
 *   5. Output envelope conformance — accepted lookups always return 200 with a
 *      SearchResponseV1-shaped body; the response_hash / meta survive.
 *   6. Not-found semantics — a lookup MISS surfaces as 200 + empty results +
 *      engine_decision.failure_reason, NEVER a 404 and NEVER a thrown crash.
 *      No fabricated match: empty in ⇒ empty out (results stays []).
 *   7. Bounded result — the route never inflates the result count; the response
 *      results length faithfully reflects the use-case output.
 *   8. Comparison rejection — any comparison-typed use-case response is refused
 *      with 400 INVALID_REQUEST (a single-entity caller must never receive an
 *      "A vs B" shape), regardless of the query string.
 *   9. requestId thread-through — the requestId handed to the use case is the
 *      same one echoed into response meta.
 *
 * Korean labels (샤또 마고, 오푸스 원, 돔 페리뇽, NFC+NFD) are MANDATORY coverage.
 * No `\b` is used on Korean (CLAUDE.md rules 5/8); Korean substring assertions
 * use `String.includes` / NFC equality, never an ASCII word boundary.
 *
 * Append-only — never delete (CLAUDE.md regression discipline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../src/interface/http/middleware/request-context.js';
import { registerLookupRoute } from '../../src/interface/http/routes/lookup.route.js';
import type { SearchRouteDeps } from '../../src/interface/http/routes/route-deps.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../src/domain/response/model/comparison-response.js';
import { ErrorResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';

const NUM_RUNS = 100;

/** RFC-014 status codes asserted in this suite (no magic numbers). */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

const CANONICAL_ENTITY_TRACE_REF =
  'decision:v1:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Korean wine labels — MANDATORY coverage. Constructed as precomposed (NFC)
 * literals; tests derive NFD on the fly so the assertions never depend on the
 * source file's own on-disk encoding form (editors silently re-normalize).
 */
const KOREAN_LABELS = ['샤또 마고', '오푸스 원', '돔 페리뇽', '로마네 콩티', '사시카이아'] as const;

/** Latin labels and exact-label / ID lookup shapes. */
const LATIN_LABELS = ['Opus One 2018', 'Chateau Margaux 2016', 'wine:entity:abc-123'] as const;

function buildSnapshot() {
  return {
    snapshot_id: 'snap-lookup-prop',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'search_response_v1',
  };
}

function makeWineResult(entityId: string, label: string): SearchResponseV1['results'][number] {
  return {
    entity: {
      entityId,
      canonicalLabel: label,
      type: 'wine',
      wineType: 'red',
      style: 'medium red',
    },
    relevanceScore: 0.9,
    match: {
      matchType: 'entity',
      scoreComponents: {
        lexical: 0.9,
        semantic: 0.9,
        attribute: 0.9,
        popularity: 0.5,
        preferenceAlignment: 0.5,
      },
    },
    constraints: { matched: [], unmet: [], inferred: [] },
    uncertainty: {
      uncertaintyConfidence: 0.95,
      missingInfo: [],
      approximationUsed: false,
    },
    evidenceItems: [],
  };
}

/**
 * Build a SearchResponseV1 with `n` results. n === 0 models a lookup MISS
 * (the documented not-found surface: 200 + empty results + failure_reason).
 */
function buildLookupResponse(n: number, failureReason = 'NO_RESULTS'): SearchResponseV1 {
  const results = Array.from({ length: n }, (_v, i) =>
    makeWineResult(`wine-${i}`, `Wine ${i}`),
  );
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: n > 0 ? 'resolved' : 'failed',
      nextAction: n > 0 ? 'return' : 'fail',
      route: 'entity',
      decisionConfidence: n > 0 ? 0.95 : 0,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: CANONICAL_ENTITY_TRACE_REF,
      decisionSnapshot: buildSnapshot(),
      ...(n > 0 ? {} : { failure_reason: failureReason }),
    },
    results,
    meta: {
      requestId: 'req-lookup-prop',
      queryTimeMs: 1,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: buildSnapshot(),
      response_hash: 'hash-lookup-prop',
    },
  };
}

function buildComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    originalQuery: 'A vs B',
    comparisonIntent: 'compare',
    entities: [],
    meta: {
      requestId: 'req-lookup-prop',
      queryTimeMs: 1,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: buildSnapshot(),
      response_hash: 'hash-comparison-prop',
    },
  } as unknown as ComparisonSearchResponse;
}

function makeApp(deps: SearchRouteDeps): Promise<FastifyInstance> {
  const app = Fastify();
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  registerLookupRoute(app, deps);
  return app.ready().then(() => app);
}

function makeDeps(
  execute: SearchRouteDeps['searchUseCase']['execute'],
): SearchRouteDeps {
  return {
    searchUseCase: { execute },
    decomposedSearchUseCase: { execute: vi.fn() },
  };
}

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/search/lookup',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const labelArb = fc.oneof(
  fc.constantFrom(...KOREAN_LABELS),
  fc.constantFrom(...LATIN_LABELS),
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
);

// ---------------------------------------------------------------------------
// Property 1 + 2 — determinism + forced entity routing + clarification:false.
// ---------------------------------------------------------------------------

describe('lookup properties — determinism + forced entity routing', () => {
  let app: FastifyInstance;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    execute = vi.fn().mockResolvedValue(buildLookupResponse(1));
    app = await makeApp(makeDeps(execute));
  });
  afterEach(async () => {
    await app.close();
  });

  it('identical input ⇒ byte-identical downstream SearchRequest, always retrieval_mode=entity', async () => {
    await fc.assert(
      fc.asyncProperty(labelArb, async (query) => {
        execute.mockClear();
        for (let i = 0; i < 3; i += 1) {
          const res = await post(app, { query });
          expect(res.statusCode).toBe(HTTP_OK);
        }
        const calls = execute.mock.calls;
        const first = calls[0]?.[0] as { query: string; retrieval_mode: string; options: unknown };
        for (const [req] of calls) {
          const r = req as { query: string; retrieval_mode: string; options: unknown };
          expect(r.query).toBe(first.query);
          expect(r.retrieval_mode).toBe('entity');
          expect(r.options).toEqual(first.options);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('caller attempts to override routing/clarification are dropped — entity + clarification:false always win', async () => {
    await fc.assert(
      fc.asyncProperty(
        labelArb,
        fc.constantFrom('hybrid', 'mixed', 'auto', 'entity'),
        fc.boolean(),
        async (query, mode, explain) => {
          execute.mockClear();
          // retrieval_mode / options.mode / options.clarification are NOT in the
          // lookup schema; strict() would reject mode/clarification, so only the
          // schema-allowed `explain` is sent here (override of routing is tested
          // by the strict-rejection property below).
          const res = await post(app, { query, options: { explain } });
          expect(res.statusCode).toBe(HTTP_OK);
          const req = execute.mock.calls[0]?.[0] as {
            retrieval_mode: string;
            options: { clarification: boolean; mode: string; explain: boolean };
          };
          expect(req.retrieval_mode).toBe('entity');
          expect(req.options.clarification).toBe(false);
          expect(req.options.mode).toBe('auto');
          expect(req.options.explain).toBe(explain);
          // `mode` is unused on purpose: lookup ignores caller routing intent.
          void mode;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — verbatim query forwarding + Korean NFC/NFD equivalence.
// ---------------------------------------------------------------------------

describe('lookup properties — verbatim query forwarding (no boundary normalization)', () => {
  let app: FastifyInstance;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    execute = vi.fn().mockResolvedValue(buildLookupResponse(1));
    app = await makeApp(makeDeps(execute));
  });
  afterEach(async () => {
    await app.close();
  });

  it('the exact Unicode form sent by the client reaches the use case unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS),
        fc.constantFrom('NFC' as const, 'NFD' as const),
        async (label, form) => {
          execute.mockClear();
          const query = label.normalize(form);
          const res = await post(app, { query });
          expect(res.statusCode).toBe(HTTP_OK);
          const seen = (execute.mock.calls[0]?.[0] as { query: string }).query;
          // Verbatim: the route does NOT collapse NFD→NFC at the boundary.
          expect(seen).toBe(query);
          // Korean syllables survive (NO \b — substring/NFC equality only).
          expect(seen.normalize('NFC')).toBe(label.normalize('NFC'));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('NFC and NFD of the same Korean label normalize to ONE string (alias soundness)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KOREAN_LABELS), async (label) => {
        execute.mockClear();
        const nfc = label.normalize('NFC');
        const nfd = label.normalize('NFD');
        await post(app, { query: nfc });
        await post(app, { query: nfd });
        const q0 = (execute.mock.calls[0]?.[0] as { query: string }).query;
        const q1 = (execute.mock.calls[1]?.[0] as { query: string }).query;
        // Each forwarded verbatim, but both fold to one canonical form.
        expect(q0.normalize('NFC')).toBe(q1.normalize('NFC'));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('special chars and surrounding whitespace-bearing labels are forwarded verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "Chateau d'Yquem -- 2010 (Sauternes) <>&\"",
          '샤또 마고 & 오푸스 원',
          'wine:entity:abc-123',
        ),
        async (query) => {
          execute.mockClear();
          const res = await post(app, { query });
          expect(res.statusCode).toBe(HTTP_OK);
          expect((execute.mock.calls[0]?.[0] as { query: string }).query).toBe(query);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — fail-closed validation + strict() body rejection.
// ---------------------------------------------------------------------------

describe('lookup properties — fail-closed input validation', () => {
  let app: FastifyInstance;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    execute = vi.fn().mockResolvedValue(buildLookupResponse(1));
    app = await makeApp(makeDeps(execute));
  });
  afterEach(async () => {
    await app.close();
  });

  it('missing / empty query ⇒ 400 VALIDATION_ERROR; search never invoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant({}),
          fc.constant({ query: '' }),
          fc.constant({ query: undefined }),
          fc.constant({ notquery: 'x' }),
        ),
        async (body) => {
          execute.mockClear();
          const res = await post(app, body);
          expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
          const parsed = ErrorResponseSchema.safeParse(res.json());
          expect(parsed.success).toBe(true);
          expect(res.json().error.code).toBe('VALIDATION_ERROR');
          expect(execute).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('oversized query (>MAX_QUERY_LENGTH) ⇒ 400; exactly MAX_QUERY_LENGTH ⇒ 200 (bound just-in/just-out)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 300 }), async (over) => {
        execute.mockClear();
        const tooLong = await post(app, { query: 'a'.repeat(MAX_QUERY_LENGTH + over) });
        expect(tooLong.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(tooLong.json().error.code).toBe('VALIDATION_ERROR');
        expect(execute).not.toHaveBeenCalled();

        const atBound = await post(app, { query: 'a'.repeat(MAX_QUERY_LENGTH) });
        expect(atBound.statusCode).toBe(HTTP_OK);
        expect(execute).toHaveBeenCalledTimes(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('strict() body — unknown top-level fields ⇒ 400 (HTTP body, not LLM tool input)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS, ...LATIN_LABELS),
        fc.constantFrom('retrieval_mode', 'mode', 'reasoning', 'confidence', '_extra', 'clarification'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        async (query, extraKey, extraVal) => {
          execute.mockClear();
          const res = await post(app, { query, [extraKey]: extraVal });
          // strict() schema: any unknown key (incl. a routing-override attempt
          // like retrieval_mode) is rejected — the body never reaches the route
          // handler, so search is not invoked.
          expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
          expect(ErrorResponseSchema.safeParse(res.json()).success).toBe(true);
          expect(res.json().error.code).toBe('VALIDATION_ERROR');
          expect(execute).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 + 6 + 7 — envelope conformance, not-found, bounded result.
// ---------------------------------------------------------------------------

describe('lookup properties — output envelope + not-found + bounded result', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('result count is faithfully reflected (no fabrication); miss ⇒ 200 + empty + failure_reason', async () => {
    await fc.assert(
      fc.asyncProperty(labelArb, fc.integer({ min: 0, max: 25 }), async (query, n) => {
        const execute = vi.fn().mockResolvedValue(buildLookupResponse(n));
        const app = await makeApp(makeDeps(execute));
        try {
          const res = await post(app, { query });
          expect(res.statusCode).toBe(HTTP_OK);
          const body = res.json();
          // Bounded + faithful: route never inflates the count.
          expect(Array.isArray(body.results)).toBe(true);
          expect(body.results.length).toBe(n);
          // Envelope conformance: meta survives the snake-case projection.
          expect(typeof body.meta.request_id).toBe('string');
          expect(body.meta.request_id.length).toBeGreaterThan(0);
          if (n === 0) {
            // Not-found is 200 (never 404) with a failure_reason — no crash,
            // no fabricated match.
            expect(body.results).toEqual([]);
            expect(body.engine_decision.failure_reason).toBe('NO_RESULTS');
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — comparison responses are always rejected with 400.
// ---------------------------------------------------------------------------

describe('lookup properties — comparison rejection', () => {
  it('any comparison-typed use-case response ⇒ 400 INVALID_REQUEST regardless of query', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(...KOREAN_LABELS, ...LATIN_LABELS),
          fc.constantFrom('A vs B', '오푸스 원 vs 샤또 마고', 'X 대 Y'),
        ),
        async (query) => {
          const execute = vi.fn().mockResolvedValue(buildComparisonResponse());
          const app = await makeApp(makeDeps(execute));
          try {
            const res = await post(app, { query });
            expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
            const body = res.json();
            expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
            expect(body.error.code).toBe('INVALID_REQUEST');
            expect(body.error.request_id.length).toBeGreaterThan(0);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9 — requestId thread-through (use case ↔ response meta).
// ---------------------------------------------------------------------------

describe('lookup properties — requestId thread-through', () => {
  it('the requestId passed to the use case is the one echoed in response meta', async () => {
    await fc.assert(
      fc.asyncProperty(labelArb, async (query) => {
        const execute = vi.fn().mockImplementation(
          async (_req: unknown, requestId: string) => {
            const r = buildLookupResponse(1);
            return { ...r, meta: { ...r.meta, requestId } };
          },
        );
        const app = await makeApp(makeDeps(execute));
        try {
          const res = await post(app, { query });
          expect(res.statusCode).toBe(HTTP_OK);
          const usedRequestId = execute.mock.calls[0]?.[1] as string;
          expect(typeof usedRequestId).toBe('string');
          expect(usedRequestId.length).toBeGreaterThan(0);
          expect(res.json().meta.request_id).toBe(usedRequestId);
        } finally {
          await app.close();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
