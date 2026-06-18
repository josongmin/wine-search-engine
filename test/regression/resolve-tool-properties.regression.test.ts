/**
 * Property-based regression tests for the legacy ResolveResponse wire shape
 * projected from Entity Lookup V2 (`executeResolveViaEntityLookupV2`).
 *
 * Mapping-only coverage — the former `POST /v1/entity/resolve` HTTP harness was
 * removed after the V2 cutover. Public entity resolve is `POST /v2/entity-lookup`.
 *
 * Invariants (append-only, fast-check numRuns=100):
 *  1. Determinism — identical request → identical wire envelope (modulo request_id).
 *  2. Output-envelope conformance — ResolveResponseSchema (.strict()) on snake_case wire.
 *  3. Abstention surfacing — status passes through; top_entity never fabricated.
 *  4. Korean NFC/NFD transparency — query forwarded verbatim; labels preserved on wire.
 *  5. Input schema validation — LookupWineRequestSchema rejects invalid bodies.
 *  6. Adversarial safety — mapping never throws for schema-valid queries.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { executeResolveViaEntityLookupV2 } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2-resolve-mapping.js';
import type { EntityLookupV2UseCasePort } from '../../src/application/search/port/search-route-usecases.port.js';
import { LookupWineRequestSchema } from '../../src/interface/http/schemas/primitive-search.schema.js';
import { ResolveResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';
import { deepKeysToSnake } from '../../src/interface/http/middleware/snake-case-hook.js';
import { MAX_RESOLVE_CANDIDATES } from '../../src/interface/http/constants.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';
import type { EntityLookupV2Result } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2.dto.js';
import type { LookupV2Status } from '../../src/domain/resolver/v2/lookup-v2-types.js';

const FC_RUNS = 100;

const CANONICAL_TRACE_REF =
  'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const HANGUL_S_CHOSEONG = 'ᄉ';
const HANGUL_YA_JUNGSEONG = 'ᅣ';
const SHA_NFD = HANGUL_S_CHOSEONG + HANGUL_YA_JUNGSEONG;
const SHA_NFC = SHA_NFD.normalize('NFC');

const KOREAN_LABELS: readonly string[] = [
  '오푸스 원 2018',
  '샤또 마고',
  '돔 페리뇽',
  '바롤로 리제르바',
  SHA_NFC,
  SHA_NFD,
];

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

function asStringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

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

function depsReturning(result: SyntheticResolverResult): EntityLookupV2UseCasePort {
  return {
    execute: vi.fn().mockImplementation(async () => buildV2FromSynthetic(result)),
  };
}

async function projectResolveWire(
  useCase: EntityLookupV2UseCasePort,
  query: string,
): Promise<Record<string, unknown>> {
  const response = await executeResolveViaEntityLookupV2(useCase, { query });
  return deepKeysToSnake(response) as Record<string, unknown>;
}

function stripRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const { request_id: _drop, ...rest } = body;
  return rest;
}

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

const arbCandidateList = fc
  .integer({ min: 0, max: MAX_RESOLVE_CANDIDATES })
  .chain((n) =>
    n === 0
      ? fc.constant([] as Array<Record<string, unknown>>)
      : fc.tuple(...Array.from({ length: n }, (_, i) => arbCandidate(i + 1))),
  );

const arbResolverResult: fc.Arbitrary<SyntheticResolverResult> = fc
  .tuple(arbStatus, arbCandidateList)
  .chain(([status, candidates]) => {
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

describe('tools.resolve mapping — determinism', () => {
  it('identical request yields identical wire envelope (modulo request_id)', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const useCase = depsReturning(result);
        const a = await projectResolveWire(useCase, query);
        const b = await projectResolveWire(useCase, query);
        expect(stripRequestId(a)).toEqual(stripRequestId(b));
      }),
      { numRuns: FC_RUNS },
    );
  }, 15_000);
});

describe('tools.resolve mapping — output envelope + abstention', () => {
  it('any V2 result serializes to a schema-valid wire envelope', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const body = await projectResolveWire(depsReturning(result), query);
        const parsed = ResolveResponseSchema.safeParse(body);
        expect(parsed.success).toBe(true);
        expect((body.candidates as unknown[]).length).toBeLessThanOrEqual(MAX_RESOLVE_CANDIDATES);
        expect(body.authority_trace_ref).toBe(body.decision_trace_ref);
        for (const c of body.candidates as Array<{ calibrated_score: number }>) {
          expect(Number.isFinite(c.calibrated_score)).toBe(true);
          expect(c.calibrated_score).toBeGreaterThanOrEqual(0);
          expect(c.calibrated_score).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('abstention is surfaced faithfully on the wire', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidQuery, arbResolverResult, async (query, result) => {
        const body = await projectResolveWire(depsReturning(result), query);
        expect(body.status).toBe(result.status);
        if (result.topEntity === undefined) {
          expect(body.top_entity).toBeUndefined();
        } else {
          expect(body.top_entity).toMatchObject({
            entity_id: result.topEntity.entityId,
          });
        }
        if (result.status === 'failed' && result.candidates.length === 0) {
          expect(body.candidates).toEqual([]);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('tools.resolve mapping — Korean Unicode transparency', () => {
  it('forwards Korean query strings verbatim to Entity Lookup V2', async () => {
    expect(SHA_NFC.length).toBe(1);
    expect(SHA_NFD.length).toBe(2);
    expect(SHA_NFC).not.toBe(SHA_NFD);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS),
        arbResolverResult,
        async (koreanQuery, result) => {
          const useCase = depsReturning(result);
          await projectResolveWire(useCase, koreanQuery);
          const execute = useCase.execute as ReturnType<typeof vi.fn>;
          const forwarded = (execute.mock.calls[0]?.[0] as { query: string }).query;
          expect(forwarded).toBe(koreanQuery);
          expect(forwarded.length).toBe(koreanQuery.length);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('preserves Korean canonical_label values through snake_case projection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_LABELS),
        arbValidQuery,
        async (label, query) => {
          const result: SyntheticResolverResult = {
            status: 'resolved',
            candidates: [{
              entityId: 'wine-korean-label',
              canonicalLabel: label,
              rank: 1,
              calibratedScore: 0.9,
            }],
            topEntity: {
              entityId: 'wine-korean-label',
              canonicalLabel: label,
              calibratedScore: 0.9,
            },
          };
          const body = await projectResolveWire(depsReturning(result), query);
          expect((body.candidates as Array<{ canonical_label: string }>)[0]?.canonical_label).toBe(label);
          expect((body.top_entity as { canonical_label: string }).canonical_label).toBe(label);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

describe('tools.resolve mapping — LookupWineRequestSchema validation', () => {
  it('rejects unknown top-level keys (.strict())', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidQuery,
        fc
          .string({ minLength: 1, maxLength: 20 })
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
        (query, unknownKey) => {
          const parsed = LookupWineRequestSchema.safeParse({ query, [unknownKey]: 'x' });
          expect(parsed.success).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('rejects non-string / empty / oversized queries', async () => {
    const arbBadQuery = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant('a'.repeat(MAX_QUERY_LENGTH + 1)),
    );
    await fc.assert(
      fc.asyncProperty(arbBadQuery, (badQuery) => {
        const payload = badQuery === undefined ? {} : { query: badQuery };
        expect(LookupWineRequestSchema.safeParse(payload).success).toBe(false);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('tools.resolve mapping — adversarial query safety', () => {
  it('never throws for schema-valid adversarial query strings', async () => {
    const arbAdversarialQuery = fc.oneof(
      fc.constant('   '),
      fc.constant('\u0000\u0007\u001b'),
      fc.constant("'; DROP TABLE wines; --"),
      fc.constant('한글'.repeat(MAX_QUERY_LENGTH)),
      fc.constant('💉🍷'.repeat(200)),
      fc.string({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    );
    await fc.assert(
      fc.asyncProperty(arbAdversarialQuery, arbResolverResult, async (query, result) => {
        const parsed = LookupWineRequestSchema.safeParse({ query });
        if (!parsed.success) {
          return;
        }
        const body = await projectResolveWire(depsReturning(result), query);
        expect(ResolveResponseSchema.safeParse(body).success).toBe(true);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('tools.resolve mapping — trace ref sanity', () => {
  it('uses a canonical authority trace ref shape on resolved outcomes', async () => {
    const result: SyntheticResolverResult = {
      status: 'resolved',
      candidates: [{
        entityId: 'wine-trace',
        canonicalLabel: 'Trace Wine',
        rank: 1,
        calibratedScore: 0.95,
      }],
      topEntity: {
        entityId: 'wine-trace',
        canonicalLabel: 'Trace Wine',
        calibratedScore: 0.95,
      },
    };
    const body = await projectResolveWire(depsReturning(result), 'trace wine');
    expect(typeof body.authority_trace_ref).toBe('string');
    expect(body.authority_trace_ref).toBe(body.decision_trace_ref);
    expect(String(body.authority_trace_ref).startsWith('decision:')).toBe(true);
    expect(body.authority_trace_ref).not.toBe(CANONICAL_TRACE_REF);
  });
});
