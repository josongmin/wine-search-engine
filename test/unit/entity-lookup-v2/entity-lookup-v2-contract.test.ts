import { describe, expect, it, vi } from 'vitest';
import {
  EntityLookupV2RequestSchema,
  EntityLookupV2ResponseSchema,
} from '../../../src/interface/http/schemas/entity-lookup-v2.schema.js';
import { ConceptAdmissionGate } from '../../../src/domain/resolver/v2/concept-admission-gate.js';
import { EntityLookupV2UseCase } from '../../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import {
  LOOKUP_V2_ENGINE_VERSION,
  mapResolverStatusToLookupStatus,
} from '../../../src/application/search/entity-lookup-v2/entity-lookup-v2-mapping.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';
import type {
  EntityResolverPort,
  QueryPlannerPort,
} from '../../../src/application/search/port/search-pipeline-deps.port.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeViews(query: string): NormalizedQueryViews {
  return {
    raw: query,
    strict: query.toLowerCase(),
    accentless: query.toLowerCase(),
    collapsedWhitespace: query.toLowerCase(),
    punctuationStripped: query.toLowerCase(),
    compact: query.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: query.toLowerCase(),
    vintageStripped: query.toLowerCase(),
    semanticVariants: [query.toLowerCase()],
    lookupVariants: [query.toLowerCase()],
  };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    rawQuery: 'Opus One',
    normalizedQuery: 'opus one',
    intent: 'known_item',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'known-item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {},
    uncertainty: {},
    normalizedQueryViews: makeViews('Opus One'),
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

function makeResolver(
  status: 'resolved' | 'ambiguous' | 'failed',
  candidates: ReadonlyArray<{ id: string; label: string; score: number }> = [],
): EntityResolverPort {
  return {
    resolve: vi.fn().mockResolvedValue({
      status,
      candidates: candidates.map((c, i) => ({
        entityId: createEntityId(c.id),
        canonicalLabel: c.label,
        calibratedScore: c.score,
        rank: i + 1,
        evidenceRefs: [],
      })),
      topEntity:
        status === 'resolved' && candidates[0] !== undefined
          ? {
              entityId: createEntityId(candidates[0].id),
              canonicalLabel: candidates[0].label,
              calibratedScore: candidates[0].score,
            }
          : undefined,
      decisionTrace: {
        queryClass: 'known-item',
        top1CalibratedScore: candidates[0]?.score ?? 0,
        top2CalibratedScore: candidates[1]?.score,
        calibratedGap:
          candidates[0] !== undefined && candidates[1] !== undefined
            ? candidates[0].score - candidates[1].score
            : undefined,
        decisionConfidenceC: candidates[0]?.score ?? 0,
        calibrationTrusted: true,
        ambiguityDetected: status === 'ambiguous',
        ambiguityTypes: status === 'ambiguous' ? ['multi_vintage'] : [],
        appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
        outcomeReasonCodes: [status === 'resolved' ? 'exact_identity' : status],
      },
      conformalSetSize: status === 'resolved' ? 1 : candidates.length,
    }),
  };
}

function makeUseCase(plannerPlan: Record<string, unknown>, resolver: EntityResolverPort): EntityLookupV2UseCase {
  const queryPlanner: QueryPlannerPort = { plan: vi.fn().mockResolvedValue(plannerPlan) };
  return new EntityLookupV2UseCase({
    admissionGate: new ConceptAdmissionGate(),
    queryPlanner,
    entityResolver: resolver,
    querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
  });
}

// ── ConceptAdmissionGate ──────────────────────────────────────────────────────

describe('ConceptAdmissionGate (T-ELV2-02 baseline)', () => {
  const gate = new ConceptAdmissionGate();

  it('rejects empty / whitespace-only queries', () => {
    expect(gate.classify({ rawQuery: '   ', views: makeViews('   ') }).decision).toBe('reject');
    expect(gate.classify({ rawQuery: '', views: makeViews('') }).reasonCode).toBe('empty_query');
  });

  it('rejects under-specified single-signal-char queries', () => {
    const v = gate.classify({ rawQuery: 'a', views: makeViews('a') });
    expect(v.decision).toBe('reject');
    expect(v.reasonCode).toBe('under_specified');
  });

  it('admits multi-char Latin / Korean / accented entity references (rule 5 scripts)', () => {
    expect(gate.classify({ rawQuery: 'Opus One', views: makeViews('Opus One') }).decision).toBe('admit');
    expect(gate.classify({ rawQuery: '오푸스원', views: makeViews('오푸스원') }).decision).toBe('admit');
    expect(gate.classify({ rawQuery: 'Méo-Camuzet', views: makeViews('Méo-Camuzet') }).decision).toBe('admit');
    // 2-char producer initialism (e.g. "CM") must still be admitted.
    expect(gate.classify({ rawQuery: 'CM', views: makeViews('CM') }).decision).toBe('admit');
  });

  it('counts CJK as signal chars (single Hangul syllable is under-specified)', () => {
    expect(gate.classify({ rawQuery: '와', views: makeViews('와') }).decision).toBe('reject');
    // '와인' (= "wine") clears the length gate but is a generic concept word →
    // redirect_discovery (handled by the T-02 concept lexicon), not admit.
    expect(gate.classify({ rawQuery: '와인', views: makeViews('와인') }).decision).toBe('redirect_discovery');
  });
});

// ── request/response schema ───────────────────────────────────────────────────

describe('EntityLookupV2RequestSchema', () => {
  it('applies the max_candidates default and rejects unknown keys', () => {
    const parsed = EntityLookupV2RequestSchema.parse({ query: 'Opus One' });
    expect(parsed.max_candidates).toBe(10);
    // `mode` is NOT on the public surface (review P3) — only the trusted ops plane.
    expect(parsed).not.toHaveProperty('mode');
    expect(() => EntityLookupV2RequestSchema.parse({ query: 'x', extra: 1 })).toThrow();
    // a public caller cannot smuggle the internal diagnostics knob
    expect(() => EntityLookupV2RequestSchema.parse({ query: 'x', mode: 'diagnostic' })).toThrow();
  });

  it('rejects empty query and out-of-range max_candidates', () => {
    expect(() => EntityLookupV2RequestSchema.parse({ query: '' })).toThrow();
    expect(() => EntityLookupV2RequestSchema.parse({ query: 'x', max_candidates: 0 })).toThrow();
  });
});

describe('EntityLookupV2ResponseSchema invariants', () => {
  const baseViews = {
    raw: 'Opus One',
    strict: 'opus one',
    accentless: 'opus one',
    compact: 'opusone',
    vintage_canonicalized: 'opus one',
    vintage_stripped: 'opus one',
    lookup_variants: ['opus one'],
  };
  const evidence = {
    admission_reason_code: 'admitted_entity_reference',
    decision_reason_code: 'exact_identity',
    calibration_trusted: true,
    query_class: 'known-item',
    candidate_pool_size: 1,
    channel_coverage: [],
  };
  const candidate = {
    entity_id: 'opus-one-2018',
    canonical_label: 'Opus One 2018',
    calibrated_score: 0.97,
    rank: 1,
    channel_agreement: 0,
    channel_hits: [],
  };
  const meta = { query_time_ms: 12, version: 'v', engine_schema_version: 'entity_lookup_v2' as const };

  it('accepts a well-formed resolved response', () => {
    const ok = EntityLookupV2ResponseSchema.safeParse({
      status: 'resolved',
      decision_reason: 'ok',
      normalized_query_views: baseViews,
      candidates: [candidate],
      top_candidate: candidate,
      clarification_options: [],
      evidence_summary: evidence,
      meta,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects resolved status with null top_candidate', () => {
    const r = EntityLookupV2ResponseSchema.safeParse({
      status: 'resolved',
      decision_reason: 'ok',
      normalized_query_views: baseViews,
      candidates: [candidate],
      top_candidate: null,
      clarification_options: [],
      evidence_summary: evidence,
      meta,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-resolved status carrying a top_candidate', () => {
    const r = EntityLookupV2ResponseSchema.safeParse({
      status: 'failed',
      decision_reason: 'no',
      normalized_query_views: baseViews,
      candidates: [],
      top_candidate: candidate,
      clarification_options: [],
      evidence_summary: evidence,
      meta,
    });
    expect(r.success).toBe(false);
  });

  it('rejects clarification_options unless status is ambiguous', () => {
    const r = EntityLookupV2ResponseSchema.safeParse({
      status: 'failed',
      decision_reason: 'no',
      normalized_query_views: baseViews,
      candidates: [],
      top_candidate: null,
      clarification_options: [{ entity_id: 'x', label: 'X' }],
      evidence_summary: evidence,
      meta,
    });
    expect(r.success).toBe(false);
  });

  it('accepts redirect_discovery with empty candidates + null top', () => {
    const r = EntityLookupV2ResponseSchema.safeParse({
      status: 'redirect_discovery',
      decision_reason: 'concept',
      normalized_query_views: baseViews,
      candidates: [],
      top_candidate: null,
      clarification_options: [],
      evidence_summary: { ...evidence, decision_reason_code: 'concept_query' },
      meta,
    });
    expect(r.success).toBe(true);
  });
});

// ── use case end-to-end mapping ───────────────────────────────────────────────

describe('EntityLookupV2UseCase', () => {
  it('maps a resolved resolver result to status=resolved with a top_candidate', async () => {
    const resolver = makeResolver('resolved', [{ id: 'opus-one-2018', label: 'Opus One 2018', score: 0.97 }]);
    const useCase = makeUseCase(makePlan(), resolver);

    const out = await useCase.execute({ query: 'Opus One', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('resolved');
    expect(out.topCandidate?.entityId).toBe('opus-one-2018');
    expect(out.evidenceSummary.calibrationTrusted).toBe(true);
    expect(out.evidenceSummary.topConfidence).toBeCloseTo(0.97);
    expect(out.meta.version).toBe(LOOKUP_V2_ENGINE_VERSION);
    expect(out.meta.engineSchemaVersion).toBe('entity_lookup_v2');
    // response must pass the wire schema after snake-casing
  });

  it('maps an ambiguous result to clarification options and a null top_candidate', async () => {
    const resolver = makeResolver('ambiguous', [
      { id: 'opus-one-2018', label: 'Opus One 2018', score: 0.6 },
      { id: 'opus-one-2019', label: 'Opus One 2019', score: 0.55 },
    ]);
    const useCase = makeUseCase(makePlan(), resolver);

    const out = await useCase.execute({ query: 'Opus One', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('ambiguous');
    expect(out.topCandidate).toBeNull();
    expect(out.clarificationOptions.length).toBe(2);
    expect(out.evidenceSummary.top1Top2Margin).toBeCloseTo(0.05);
  });

  it('closes a noisy non-match as failed (no wrong-positive)', async () => {
    const resolver = makeResolver('failed', []);
    const useCase = makeUseCase(makePlan({ rawQuery: 'opu one', normalizedQuery: 'opu one', normalizedQueryViews: makeViews('opu one') }), resolver);

    const out = await useCase.execute({ query: 'opu one', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('failed');
    expect(out.topCandidate).toBeNull();
    expect(out.clarificationOptions).toHaveLength(0);
  });

  it('rejects under-specified input at the gate WITHOUT calling the resolver', async () => {
    const resolver = makeResolver('failed', []);
    const useCase = makeUseCase(makePlan({ rawQuery: 'a', normalizedQuery: 'a', normalizedQueryViews: makeViews('a') }), resolver);

    const out = await useCase.execute({ query: 'a', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('failed');
    expect(out.evidenceSummary.admissionReasonCode).toBe('under_specified');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('fails fast on contradictory hard constraints without calling the resolver', async () => {
    const resolver = makeResolver('failed', []);
    const useCase = makeUseCase(
      makePlan({
        constraints: {
          hard: [
            { attribute: 'price', operator: '<=', value: 20 },
            { attribute: 'price', operator: '>=', value: 50 },
          ],
          soft: [],
          inferred: [],
        },
      }),
      resolver,
    );

    // Query must ADMIT past the front-door gate (a concept-only query like
    // "cheap expensive merlot" would redirect before the planner); the stubbed
    // plan carries the contradictory hard constraints that trip the SAT check.
    const out = await useCase.execute({ query: 'Opus One', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('failed');
    expect(out.evidenceSummary.decisionReasonCode).toBe('hard_constraint_violation');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});

describe('T-ELV2-06 clarification contract on the wire', () => {
  it('surfaces clarification_kind + ambiguity_types from the in-process graph (no persisted dict)', async () => {
    const resolver = makeResolver('ambiguous', [
      { id: 'opus-one-2018', label: 'Opus One 2018', score: 0.6 },
      { id: 'opus-one-2019', label: 'Opus One 2019', score: 0.55 },
    ]);
    const out = await makeUseCase(makePlan(), resolver).execute({ query: 'Opus One', maxCandidates: 10, mode: 'default' });
    expect(out.status).toBe('ambiguous');
    expect(out.evidenceSummary.clarificationKind).toBe('multi_vintage');
    expect(out.evidenceSummary.ambiguityTypes).toContain('multi_vintage');
    expect(out.evidenceSummary.ambiguitySeverity).toBeUndefined(); // no persisted severity
  });

  it('prefers the PERSISTED ambiguity graph (types + severity) over the in-process classifier', async () => {
    const resolver = makeResolver('ambiguous', [
      { id: 'opus-one-2018', label: 'Opus One 2018', score: 0.6 },
      { id: 'opus-one-2019', label: 'Opus One 2019', score: 0.55 },
    ]);
    const queryPlanner: QueryPlannerPort = { plan: vi.fn().mockResolvedValue(makePlan()) };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      queryPlanner,
      entityResolver: resolver,
      ambiguityDictionary: {
        isKnownAmbiguous: vi.fn().mockResolvedValue(true),
        getAmbiguityInfo: vi.fn().mockResolvedValue({ types: ['alias_collision'], severity: 'high' }),
        getAmbiguityInfoBatch: vi.fn().mockResolvedValue(new Map()),
      },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });
    const out = await useCase.execute({ query: 'Opus One', maxCandidates: 10, mode: 'default' });
    expect(out.evidenceSummary.ambiguityTypes).toEqual(['alias_collision']);
    expect(out.evidenceSummary.ambiguitySeverity).toBe('high');
  });
});

describe('mapResolverStatusToLookupStatus', () => {
  it('maps resolver advisory status to terminal lookup status', () => {
    expect(mapResolverStatusToLookupStatus('resolved')).toBe('resolved');
    expect(mapResolverStatusToLookupStatus('ambiguous')).toBe('ambiguous');
    expect(mapResolverStatusToLookupStatus('failed')).toBe('failed');
  });
});
