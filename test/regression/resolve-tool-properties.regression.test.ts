/**
 * Property-based regression tests for the `tools.resolve` AGENT TOOL /
 * HTTP endpoint (POST /v1/entity/resolve).
 *
 * SCOPE: this suite exercises the *tool contract* — input validation, the
 * snake_case output envelope, abstention surfacing, candidate bounding, and
 * Unicode (Korean) transparency. It does NOT re-test resolver internals
 * (those live in nlu.entity-resolver / resolver.ts); the resolve use case is
 * mocked so the property generators can drive arbitrary resolver outputs
 * through the route boundary deterministically.
 *
 * Invariants verified (append-only, SOTA++ grade), fast-check numRuns=100:
 *
 *  1. Determinism — identical request body → identical status code AND
 *     identical response body (the route is a pure transform over a fixed
 *     resolver output; no Math.random / Date / iteration-order leakage).
 *
 *  2. Output-envelope conformance — for ANY resolver result the use case
 *     returns, the 200 response body MUST validate against
 *     `ResolveResponseSchema` (.strict()): snake_cased keys, bounded
 *     candidates (<= MAX_RESOLVE_CANDIDATES), calibrated_score in [0,1],
 *     decision_trace_ref === authority_trace_ref.
 *
 *  3. Abstention surfacing — a resolver that abstains (status 'ambiguous'
 *     or 'failed', topEntity omitted) is surfaced faithfully: status passes
 *     through verbatim and `top_entity` is NEVER fabricated. The route never
 *     turns an abstain into a 'resolved' match.
 *
 *  4. Korean label transparency (NFC + NFD) — Korean query strings AND
 *     Korean canonical_label values pass through the route boundary verbatim
 *     in whatever normalization form they arrived in. The HTTP layer must not
 *     silently re-normalize Unicode (that is the entity-identity layer's job;
 *     re-normalizing here would break NFC/NFD-aware alias lookup downstream).
 *     NEVER uses `\b` on Korean.
 *
 *  5. Input schema validation — the request body schema is `.strict()`
 *     (this is an HTTP request body, NOT LLM-generated tool-call input, so
 *     strictness is correct per CLAUDE.md test-discipline rule 10). Unknown
 *     top-level keys, non-string / empty / oversized queries, and missing
 *     queries are rejected with a 400 RFC-014 VALIDATION_ERROR envelope and
 *     the use case is NOT invoked.
 *
 *  6. Empty / adversarial safety — whitespace-only, control-char, prototype-
 *     pollution-shaped, and length-attack inputs never crash the route; they
 *     either pass through as a valid query (forwarded verbatim) or are
 *     rejected with the RFC-014 envelope. Never a 5xx, never a fabricated 200.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify route or
 * use-case source. Any property that cannot hold is documented in
 * tools/feature-catalog/features/tools/resolve.yaml under known_limitations.
 */

import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fc from 'fast-check';
import { registerResolveRoute } from '../../src/interface/http/routes/resolve.route.js';
import type { ResolveRouteDeps } from '../../src/interface/http/routes/route-deps.js';
import { errorHandler } from '../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../src/interface/http/middleware/request-context.js';
import { resolveIncomingRequestId } from '../../src/interface/http/request-id.js';
import {
  ResolveResponseSchema,
  ErrorResponseSchema,
} from '../../src/interface/http/schemas/search-response.schema.js';
import { MAX_RESOLVE_CANDIDATES } from '../../src/interface/http/constants.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';
import type { EntityLookupV2Result } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2.dto.js';
import type { LookupV2Status } from '../../src/domain/resolver/v2/lookup-v2-types.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md test-discipline rule 15: no magic numbers).
// ---------------------------------------------------------------------------

/** fast-check property runs — fixed by directive to 100. */
const FC_RUNS = 100;

/**
 * Canonical decision-trace ref shape used by all happy-path mocks. Matches
 * CANONICAL_AUTHORITY_TRACE_REF_PATTERN: `^(decision|admission):v1:[A-Za-z0-9_]+:[a-f0-9]{64}$`.
 * On resolve responses decision_trace_ref MUST equal authority_trace_ref
 * (ResolveResponseSchema superRefine), so a single constant keeps them in lock-step.
 */
const CANONICAL_TRACE_REF =
  'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Upper bound on synthetic candidate-list length we ask the resolver mock to emit. */
const MAX_SYNTHETIC_CANDIDATES = MAX_RESOLVE_CANDIDATES;

// ---------------------------------------------------------------------------
// Korean fixtures built from code points so the source file's own on-disk
// normalization form cannot invalidate NFC/NFD assertions (editors silently
// re-normalize Korean literals on save).
// ---------------------------------------------------------------------------
// 샤 (sya) = Choseong ㅅ + Jungseong ㅑ.
const HANGUL_S_CHOSEONG = 'ᄉ'; // ᄉ
const HANGUL_YA_JUNGSEONG = 'ᅣ'; // ᅣ
const SHA_NFD = HANGUL_S_CHOSEONG + HANGUL_YA_JUNGSEONG; // 2 code units (decomposed)
const SHA_NFC = SHA_NFD.normalize('NFC'); // 1 code unit (precomposed 샤)

// Korean wine-domain labels used as canonical_label generator values. These
// exercise the snake_case serializer + strict-schema path with non-ASCII text.
const KOREAN_LABELS: readonly string[] = [
  '오푸스 원 2018', // Opus One 2018
  '샤또 마고', // Château Margaux
  '돔 페리뇽', // Dom Pérignon
  '바롤로 리제르바', // Barolo Riserva
  SHA_NFC, // precomposed 샤
  SHA_NFD, // decomposed 샤
];

// ---------------------------------------------------------------------------
// App + deps harness.
// ---------------------------------------------------------------------------

function buildApp(deps: ResolveRouteDeps): FastifyInstance {
  const app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  registerResolveRoute(app, deps);
  return app;
}

interface SyntheticResolverResult {
  readonly status: 'resolved' | 'ambiguous' | 'failed';
  readonly candidates: ReadonlyArray<Record<string, unknown>>;
  readonly topEntity?: Record<string, unknown> | undefined;
}

const BASE_V2_VIEWS = {
  raw: 'q',
  strict: 'q',
  accentless: 'q',
  compact: 'q',
  vintageCanonicalized: 'q',
  vintageStripped: 'q',
  lookupVariants: ['q'],
} as const;

const BASE_V2_EVIDENCE = {
  admissionReasonCode: 'admitted',
  decisionReasonCode: 'exact_identity',
  calibrationTrusted: true,
  queryClass: 'exact_entity',
  candidatePoolSize: 1,
  channelCoverage: [],
} as const;

const BASE_V2_META = {
  queryTimeMs: 1,
  version: 'entity-lookup-v2/1.0.0',
  engineSchemaVersion: 'entity_lookup_v2',
} as const;

/** Builds a V2 lookup authority result the resolve route maps to ResolveResponse. */
function buildV2FromSynthetic(result: SyntheticResolverResult): EntityLookupV2Result {
  const status: LookupV2Status =
    result.status === 'resolved' || result.status === 'ambiguous'
      ? result.status
      : 'failed';

  return {
    status,
    decisionReason: 'synthetic',
    normalizedQueryViews: BASE_V2_VIEWS,
    candidates: result.candidates.map((candidate, index) => ({
      entityId: asStringField(candidate.entityId, 'e'),
      canonicalLabel: asStringField(candidate.canonicalLabel, 'L'),
      calibratedScore: Number(candidate.calibratedScore ?? 0),
      rank: typeof candidate.rank === 'number' ? candidate.rank : index + 1,
      channelAgreement: 1,
      channelHits: [],
    })),
    topCandidate: result.topEntity !== undefined
      ? {
          entityId: asStringField(result.topEntity.entityId, 'e'),
          canonicalLabel: asStringField(result.topEntity.canonicalLabel, 'L'),
          calibratedScore: Number(result.topEntity.calibratedScore ?? 0),
        }
      : null,
    clarificationOptions: [],
    evidenceSummary: BASE_V2_EVIDENCE,
    meta: BASE_V2_META,
  };
}

type MockedResolveRouteDeps = ResolveRouteDeps & {
  readonly entityLookupV2UseCase: { readonly execute: ReturnType<typeof vi.fn> };
};

function depsReturning(result: SyntheticResolverResult): MockedResolveRouteDeps {
  const execute = vi.fn().mockImplementation(async () => buildV2FromSynthetic(result));
  return { entityLookupV2UseCase: { execute } };
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
// Arbitraries.
// ---------------------------------------------------------------------------

/** A valid, non-empty query string (ASCII + Korean + accented Latin + emoji). */
const arbValidQuery = fc.oneof(
  fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.length >= 1),
  fc.constantFrom(...KOREAN_LABELS),
  fc.constantFrom('Château Margaux', 'Niño', 'Côtes du Rhône', '🍷 opus one', '오푸스 원 🍇'),
);

const arbStatus = fc.constantFrom<'resolved' | 'ambiguous' | 'failed'>(
  'resolved',
  'ambiguous',
  'failed',
);

const arbSource = fc.constantFrom('alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed');

/** A single resolver candidate (camelCase, as the use case emits it). */
const arbCandidate = (rank: number) =>
  fc.record(
    {
      entityId: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length >= 1),
      canonicalLabel: fc.oneof(
        fc.constantFrom(...KOREAN_LABELS),
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length >= 1),
      ),
      calibratedScore: fc.double({ min: 0, max: 1, noNaN: true }),
      source: arbSource,
      evidenceRefs: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
    },
    { requiredKeys: ['entityId', 'canonicalLabel', 'calibratedScore'] },
  ).map((c) => ({ ...c, rank }));

/** A bounded, rank-ordered candidate list (1..MAX_SYNTHETIC_CANDIDATES items). */
const arbCandidateList = fc
  .integer({ min: 0, max: MAX_SYNTHETIC_CANDIDATES })
  .chain((n) =>
    n === 0
      ? fc.constant([] as Array<Record<string, unknown>>)
      : fc.tuple(...Array.from({ length: n }, (_, i) => arbCandidate(i + 1))),
  );

/**
 * Coerce an `unknown` candidate field to a string with a fallback. Candidate
 * records are typed `Record<string, unknown>`, so `entityId`/`canonicalLabel`
 * widen to `unknown`; narrow to a real string before use (a bare `String()` on
 * `unknown` could stringify an object to "[object Object]").
 */
function asStringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A full synthetic resolver result with abstention shapes represented. */
const arbResolverResult: fc.Arbitrary<SyntheticResolverResult> = fc
  .tuple(arbStatus, arbCandidateList)
  .chain(([status, candidates]) => {
    // Faithful abstention: when there is no clear winner the resolver omits
    // topEntity. We generate both "has top" and "abstained" variants so the
    // route is exercised on both surfaces. topEntity, when present, mirrors a
    // candidate so the score stays in [0,1].
    const topArb =
      candidates.length > 0
        ? fc.boolean().map((hasTop) =>
            hasTop
              ? {
                  entityId: asStringField(candidates[0]?.entityId, 'e'),
                  canonicalLabel: asStringField(candidates[0]?.canonicalLabel, 'L'),
                  calibratedScore: Number(candidates[0]?.calibratedScore ?? 0),
                }
              : undefined,
          )
        : fc.constant(undefined);
    return topArb.map((topEntity) => ({
      status,
      candidates,
      ...(topEntity !== undefined ? { topEntity } : {}),
    }));
  });

// ---------------------------------------------------------------------------
// Property 1 — Determinism.
// ---------------------------------------------------------------------------

describe('tools.resolve route — determinism', () => {
  it('identical request body yields identical status code and response body', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const app = buildApp(depsReturning(result));
        try {
          const a = await post(app, { query });
          const b = await post(app, { query });
          expect(a.statusCode).toBe(b.statusCode);
          // request_id is the only intentionally-varying field (generated per
          // request). Strip it before comparing the deterministic envelope.
          const stripId = (raw: string): unknown => {
            const obj = JSON.parse(raw) as Record<string, unknown>;
            const { request_id: _drop, ...rest } = obj;
            return rest;
          };
          expect(stripId(a.body)).toEqual(stripId(b.body));
        } finally {
          await app.close();
        }
      }),
      { numRuns: FC_RUNS },
    );
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Property 2 — Output-envelope conformance + Property 3 — abstention surfacing.
// ---------------------------------------------------------------------------

describe('tools.resolve route — output envelope + abstention', () => {
  it('any resolver result serializes to a schema-valid 200 envelope', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const app = buildApp(depsReturning(result));
        try {
          const res = await post(app, { query });
          expect(res.statusCode).toBe(200);
          const body = res.json();

          // Envelope MUST validate against the strict outbound contract.
          const parsed = ResolveResponseSchema.safeParse(body);
          expect(parsed.success).toBe(true);

          // Bounded candidate count.
          expect(body.candidates.length).toBeLessThanOrEqual(MAX_RESOLVE_CANDIDATES);
          // Trace refs equal + present.
          expect(body.authority_trace_ref).toBe(body.decision_trace_ref);
          // Every calibrated_score in [0,1] and finite.
          for (const c of body.candidates as Array<{ calibrated_score: number }>) {
            expect(Number.isFinite(c.calibrated_score)).toBe(true);
            expect(c.calibrated_score).toBeGreaterThanOrEqual(0);
            expect(c.calibrated_score).toBeLessThanOrEqual(1);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('abstention is surfaced faithfully — status passes through, top_entity never fabricated', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const app = buildApp(depsReturning(result));
        try {
          const res = await post(app, { query });
          const body = res.json();

          // Status is passed through verbatim — the route never upgrades an
          // abstain ('ambiguous'/'failed') into a 'resolved' decision.
          expect(body.status).toBe(result.status);

          // When the resolver abstained from a top entity, the route MUST NOT
          // invent one (no fabricated match).
          if (result.topEntity === undefined) {
            expect(body.top_entity).toBeUndefined();
          } else {
            expect(body.top_entity).toMatchObject({
              entity_id: result.topEntity.entityId,
            });
          }

          // 'failed' with empty candidates is a valid abstain surface (still 200).
          if (result.status === 'failed' && result.candidates.length === 0) {
            expect(body.candidates).toEqual([]);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Korean (NFC + NFD) transparency at the route boundary.
// ---------------------------------------------------------------------------

describe('tools.resolve route — Korean Unicode transparency', () => {
  it('forwards Korean query strings (NFC and NFD) verbatim to the use case', async () => {
    // Sanity: the two forms are genuinely distinct at the code-unit level.
    expect(SHA_NFC.length).toBe(1);
    expect(SHA_NFD.length).toBe(2);
    expect(SHA_NFC).not.toBe(SHA_NFD);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS),
        arbResolverResult,
        async (koreanQuery, result) => {
          const deps = depsReturning(result);
          const app = buildApp(deps);
          try {
            const res = await post(app, { query: koreanQuery });
            expect(res.statusCode).toBe(200);
            const calls = deps.entityLookupV2UseCase.execute.mock.calls;
            const forwarded = (calls[0]?.[0] as { query: string }).query;
            // Verbatim: identical string, identical normalization form, identical length.
            expect(forwarded).toBe(koreanQuery);
            expect(forwarded.length).toBe(koreanQuery.length);
            expect(forwarded.normalize('NFC') === koreanQuery).toBe(
              koreanQuery.normalize('NFC') === koreanQuery,
            );
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('preserves Korean canonical_label values verbatim through the snake_case serializer', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS),
        arbValidQuery,
        async (label, query) => {
          const result: SyntheticResolverResult = {
            status: 'resolved',
            candidates: [
              {
                entityId: 'wine-korean-label',
                canonicalLabel: label,
                rank: 1,
                calibratedScore: 0.9,
              },
            ],
            topEntity: {
              entityId: 'wine-korean-label',
              canonicalLabel: label,
              calibratedScore: 0.9,
            },
          };
          const app = buildApp(depsReturning(result));
          try {
            const res = await post(app, { query });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            // The Korean label survives serialization byte-for-byte (no NFC/NFD shift).
            expect(body.candidates[0].canonical_label).toBe(label);
            expect(body.top_entity.canonical_label).toBe(label);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Input schema validation (strict body; RFC-014 envelope).
// ---------------------------------------------------------------------------

describe('tools.resolve route — input validation envelope', () => {
  it('rejects unknown top-level keys with a 400 RFC-014 envelope and does not invoke the use case', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidQuery,
        fc
          .string({ minLength: 1, maxLength: 20 })
          // Avoid colliding with real schema keys so the body stays valid
          // except for the injected unknown key. Also exclude prototype-
          // pollution-shaped keys: Fastify's secure JSON body parser rejects
          // `__proto__`/`constructor`/`prototype` at PARSE time with
          // MALFORMED_JSON_BODY, before schema validation runs — so the
          // VALIDATION_ERROR claim only holds for benign unknown keys. The
          // proto-pollution path is asserted separately below (invariant 6).
          .filter(
            (k) =>
              ![
                'query',
                'context',
                'sessionContext',
                'session_context',
                'queryBudget',
                'query_budget',
                '__proto__',
                'constructor',
                'prototype',
              ].includes(k),
          ),
        async (query, unknownKey) => {
          const deps = depsReturning({ status: 'resolved', candidates: [] });
          const app = buildApp(deps);
          try {
            const res = await post(app, { query, [unknownKey]: 'x' });
            expect(res.statusCode).toBe(400);
            const body = res.json();
            expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
            expect(body.error.code).toBe('VALIDATION_ERROR');
            expect(body.error.request_id.length).toBeGreaterThan(0);
            expect(deps.entityLookupV2UseCase.execute).not.toHaveBeenCalled();
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('rejects non-string / empty / oversized queries with a 400 RFC-014 envelope', async () => {
    const arbBadQuery = fc.oneof(
      fc.constant(undefined), // missing
      fc.constant(''), // empty
      fc.integer(), // non-string
      fc.boolean(), // non-string
      fc.constant(null), // null
      fc.constant('a'.repeat(MAX_QUERY_LENGTH + 1)), // oversized
    );
    await fc.assert(
      fc.asyncProperty(arbBadQuery, async (badQuery) => {
        const deps = depsReturning({ status: 'resolved', candidates: [] });
        const app = buildApp(deps);
        try {
          const payload = badQuery === undefined ? {} : { query: badQuery };
          const res = await post(app, payload);
          expect(res.statusCode).toBe(400);
          const body = res.json();
          expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
          expect(body.error.code).toBe('VALIDATION_ERROR');
          expect(deps.entityLookupV2UseCase.execute).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — Empty / adversarial safety (never 5xx, never fabricated 200).
// ---------------------------------------------------------------------------

describe('tools.resolve route — adversarial input safety', () => {
  it('handles control chars, prototype-pollution shapes, and length attacks without 5xx', async () => {
    const arbAdversarialQuery = fc.oneof(
      fc.constant('   '), // whitespace only (valid: min length is char count, not trimmed)
      fc.constant(' '), // control chars
      fc.constant('__proto__'),
      fc.constant('constructor'),
      fc.constant('{"$ne": null}'),
      fc.constant("'; DROP TABLE wines; --"),
      fc.constant('한글'.repeat(MAX_QUERY_LENGTH)), // far oversized, multibyte
      fc.constant('💉🍷'.repeat(200)), // emoji length attack
      fc.string({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    );
    await fc.assert(
      fc.asyncProperty(arbAdversarialQuery, arbResolverResult, async (query, result) => {
        const app = buildApp(depsReturning(result));
        try {
          const res = await post(app, { query });
          // Never a server error; either a contracted 200 or a 400 RFC-014 reject.
          expect(res.statusCode).toBeLessThan(500);
          const body = res.json();
          if (res.statusCode === 200) {
            expect(ResolveResponseSchema.safeParse(body).success).toBe(true);
          } else {
            expect(res.statusCode).toBe(400);
            expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('rejects a non-object JSON body (array / string / number) with the RFC-014 envelope, never 5xx', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant<unknown>([]),
          fc.constant<unknown>([{ query: 'opus one' }]),
          fc.constant<unknown>('opus one'),
          fc.constant<unknown>(42),
          fc.constant<unknown>(true),
        ),
        async (body) => {
          const deps = depsReturning({ status: 'resolved', candidates: [] });
          const app = buildApp(deps);
          try {
            const res = await post(app, body);
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
            expect(res.statusCode).toBeLessThan(500);
            const parsed = res.json();
            expect(ErrorResponseSchema.safeParse(parsed).success).toBe(true);
            expect(deps.entityLookupV2UseCase.execute).not.toHaveBeenCalled();
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('rejects prototype-pollution-shaped top-level KEYS with a 400 RFC-014 envelope, never 5xx, use case not invoked', async () => {
    // The dangerous keys must appear in the wire bytes verbatim, so we send a
    // raw JSON string (a JS object literal could re-route `__proto__` through
    // prototype assignment instead of an own key). Fastify's secure JSON body
    // parser rejects these at PARSE time (before schema validation), so the
    // code is MALFORMED_JSON_BODY rather than VALIDATION_ERROR — but it MUST
    // still be a 400 RFC-014 envelope and MUST NOT reach the use case. This is
    // the proto-pollution half of invariant 6 that the benign unknown-key
    // property above deliberately excludes.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        async (dangerousKey) => {
          const deps = depsReturning({ status: 'resolved', candidates: [] });
          const app = buildApp(deps);
          try {
            const rawBody = `{"query":"opus one","${dangerousKey}":{"polluted":true}}`;
            const res = await post(app, rawBody);
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
            expect(res.statusCode).toBeLessThan(500);
            const body = res.json();
            expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
            expect(body.error.request_id.length).toBeGreaterThan(0);
            expect(deps.entityLookupV2UseCase.execute).not.toHaveBeenCalled();
            // Sanity: the global Object prototype was not polluted.
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
