/**
 * DeterministicRouter — routing semantics & invariants.
 *
 * These tests exercise the 7 routing rules described in
 * `deterministic-router.ts` with a mix of Korean and English queries. Each
 * input is a hand-built `WineSearchAnalysis` (so we don't couple the router
 * tests to QueryAnalyzerService internals); the result is asserted both
 * structurally and via `ExecutionPlanSchema.parse(...)` to confirm the
 * planner never emits an invalid plan.
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedConstraint } from '@shared/types/index.js';
import { convertKrwToConstraintUsd } from '@shared/utils/canonical-price.js';
import { DeterministicRouter } from '../deterministic-router.js';
import { ExecutionPlanSchema } from '../execution-plan-schemas.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Builders — small, explicit, used per test. Keeping them inline (not
// shared with query-analyzer.test.ts) so router tests stay independent.
// ---------------------------------------------------------------------------

function makeRouter() {
  return new DeterministicRouter();
}

function baseAnalysis(overrides: Partial<WineSearchAnalysis> = {}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: true,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 3 },
    hangulDominant: false,
    preservedSurface: 'wine',
    ...overrides,
  };
}

function makeConstraint(
  attribute: string,
  value: NormalizedConstraint['value'],
  operator: NormalizedConstraint['operator'] = '=',
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: typeof value === 'string' ? value : attribute,
    confidence: 1.0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeterministicRouter — Rule 1: analysis-rejected guard', () => {
  it('intent=unknown + no anchors + no constraints + NON-wine surface → reject', () => {
    // The `preservedSurface` here intentionally does NOT contain a wine-domain
    // keyword (와인 / wine / 포도주 / …). The rule-1 guard only rejects when
    // the surface ALSO lacks wine-domain evidence — see the
    // `WINE_DOMAIN_KEYWORD_RE` false-positive guard in
    // `deterministic-router.ts` (CLAUDE.md rule 23 — benign conversational
    // wine queries must NOT route to `unsupported_intent`).
    const router = makeRouter();
    const plan = router.route(baseAnalysis({ intent: 'unknown', preservedSurface: 'hello there' }));
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('unsupported_intent');
    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan);
  });

  it('intent=unknown reject WITH a failed LLM fallback → analysis_unavailable (honest cause, not query-blaming)', () => {
    // Move 2: the analyzer already captures that its LLM fallback FAILED
    // (llmFallbackOutcome). The router must carry that cause forward as a
    // distinct reject reason so the response says "AI analysis unavailable"
    // instead of "unsupported intent — give a wine name" (which blames the
    // user when the real cause was an LLM outage).
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        preservedSurface: '보르고뉴',
        llmFallbackOutcome: { kind: 'failed_preserved_unknown', failureReason: 'validation' },
      }),
    );
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('analysis_unavailable');
    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan);
  });

  it('intent=unknown reject WITHOUT an LLM failure (not_attempted) → stays unsupported_intent', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        preservedSurface: 'asdfqwer',
        llmFallbackOutcome: { kind: 'not_attempted' },
      }),
    );
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('unsupported_intent');
  });

  it('intent=unknown + no anchors + no constraints + wine-domain surface → falls through to single-search', () => {
    // Regression guard for the CLAUDE.md rule 23 fix: "와인 좀 알려줘" /
    // "와인 추천해 주시겠어요?" produce zero anchors AND zero constraints
    // through the deterministic pipeline, yet they are unambiguously
    // wine-domain. The router must NOT reject these as unsupported.
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        preservedSurface: '와인 좀 알려줘',
        hangulDominant: true,
      }),
    );
    expect(plan.kind).toBe('single-search');
  });

  it('intent=unknown + no anchors + no constraints + English "wine" surface → falls through to single-search', () => {
    // Symmetric guard for the English path — "wine please" must not be
    // rejected even when the deterministic pipeline extracts no anchor /
    // constraint.
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        preservedSurface: 'wine please',
      }),
    );
    expect(plan.kind).toBe('single-search');
  });

  it('intent=unknown WITH constraints → does NOT reject (falls through to single-search)', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        normalizedConstraints: [makeConstraint('country', 'France')],
        preservedSurface: '프랑스 와인',
        hangulDominant: true,
      }),
    );
    expect(plan.kind).toBe('single-search');
  });

  it('intent=unknown WITH anchors → does NOT reject', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'unknown',
        anchors: [{ surface: 'Opus One', canonicalValue: 'Opus One', entityType: 'wine', confidence: 0.9 }],
        preservedSurface: 'Opus One',
      }),
    );
    expect(plan.kind).toBe('single-search');
  });
});

describe('DeterministicRouter — Rule 2: parallel-slot decomposition', () => {
  it('appetizer + main → parallel-search with 2 slots', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: 'red and white wine for a course meal',
        expectedMultiStep: true,
        decomposition: {
          kind: 'parallel-slot',
          slots: [
            { wineType: 'red', limit: 3 },
            { wineType: 'white', limit: 3 },
          ],
        },
      }),
    );
    expect(plan.kind).toBe('parallel-search');
    if (plan.kind !== 'parallel-search') return;
    expect(plan.searches).toHaveLength(2);
    // Each slot carries a wine_type filter.
    expect(plan.searches[0]?.filters?.some((c) => c.attribute === 'wine_type')).toBe(true);
    expect(plan.searches[1]?.filters?.some((c) => c.attribute === 'wine_type')).toBe(true);
  });

  it('splits total budget across slots — Korean "총 10만원 레드+화이트"', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '총 10만원 레드+화이트',
        hangulDominant: true,
        expectedMultiStep: true,
        normalizedConstraints: [makeConstraint('max_price_krw', 100_000)],
        decomposition: {
          kind: 'parallel-slot',
          slots: [{ wineType: 'red' }, { wineType: 'white' }],
        },
      }),
    );
    expect(plan.kind).toBe('parallel-search');
    if (plan.kind !== 'parallel-search') return;
    const slot0BudgetFilter = plan.searches[0]?.filters?.find((c) => c.attribute === 'price_usd');
    expect(slot0BudgetFilter?.value).toBe(convertKrwToConstraintUsd(50_000));
    expect(slot0BudgetFilter?.soft_promotion_authority).toBe('allow');
  });

  it('uses tiered constraints for parallel-slot budget split when legacy flat constraints are empty', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '총 12만원 레드+화이트',
        hangulDominant: true,
        expectedMultiStep: true,
        constraints: {
          hard: [makeConstraint('max_price_krw', 120_000, '<=')],
          soft: [],
          inferred: [],
        },
        normalizedConstraints: [],
        decomposition: {
          kind: 'parallel-slot',
          slots: [{ wineType: 'red' }, { wineType: 'white' }],
        },
      }),
    );
    expect(plan.kind).toBe('parallel-search');
    if (plan.kind !== 'parallel-search') return;
    const slot0BudgetFilter = plan.searches[0]?.filters?.find((c) => c.attribute === 'price_usd');
    expect(slot0BudgetFilter?.value).toBe(convertKrwToConstraintUsd(60_000));
    expect(slot0BudgetFilter?.soft_promotion_authority).toBe('allow');
  });
});

describe('DeterministicRouter — Rule 3: multi-step handoff', () => {
  it('expectedMultiStep=true with no specific decomposition → multi-step', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '복잡한 조건의 와인 추천 요청',
        hangulDominant: true,
        expectedMultiStep: true,
        recommendedBudget: { maxSteps: 6, perToolCap: 4 },
      }),
    );
    expect(plan.kind).toBe('multi-step');
    if (plan.kind !== 'multi-step') return;
    expect(plan.handoff.initialAction).toBe('search');
    expect(plan.handoff.budget.maxSteps).toBe(6);
  });

  it('compare intent without decomposition + expectedMultiStep → multi-step with initialAction=compare', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'compare',
        preservedSurface: 'something to compare',
        expectedMultiStep: true,
      }),
    );
    expect(plan.kind).toBe('multi-step');
    if (plan.kind !== 'multi-step') return;
    expect(plan.handoff.initialAction).toBe('compare');
  });

  it('anchored_similarity caller interpretation → multi-step even when expectedMultiStep=false', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: 'Opus One이랑 비슷한데 더 싼 거',
        callerInterpretation: {
          authority: 'caller',
          intent: 'mixed_query',
          queryClass: 'anchored_similarity',
        },
        expectedMultiStep: false,
      }),
    );
    expect(plan.kind).toBe('multi-step');
    if (plan.kind !== 'multi-step') return;
    expect(plan.handoff.initialAction).toBe('search');
  });
});

describe('DeterministicRouter — Rule 4: single-search (default)', () => {
  it('Korean "부르고뉴 피노누아 추천" → single-search', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '부르고뉴 피노누아 추천',
        hangulDominant: true,
        normalizedConstraints: [makeConstraint('region', 'Burgundy'), makeConstraint('grape_primary', 'Pinot Noir')],
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.query).toBe('부르고뉴 피노누아 추천');
    expect(plan.searchInput.filters).toHaveLength(2);
  });

  it('English "Bordeaux red under $50" → single-search', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: 'Bordeaux red under $50',
        normalizedConstraints: [makeConstraint('region', 'Bordeaux'), makeConstraint('wine_type', 'red')],
      }),
    );
    expect(plan.kind).toBe('single-search');
  });

  it('routes soft sensory constraints to preferences instead of hard filters', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '풀바디 레드 와인 추천',
        hangulDominant: true,
        normalizedConstraints: [
          makeConstraint('wine_type', 'red'),
          makeConstraint('body', 'full'),
        ],
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.filters).toEqual([
      expect.objectContaining({ attribute: 'wine_type', value: 'red' }),
    ]);
    expect(plan.searchInput.preferences).toEqual([
      expect.objectContaining({ attribute: 'body', value: 'full' }),
    ]);
  });

  it('routes soft budget preference to preferences instead of hard filters', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '와인 입문자 선물용',
        hangulDominant: true,
        normalizedConstraints: [
          makeConstraint('price_band', 'budget'),
        ],
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.filters).toBeUndefined();
    expect(plan.searchInput.preferences).toEqual([
      expect.objectContaining({ attribute: 'price_band', value: 'budget' }),
    ]);
  });

  it('exact-metadata signal → entity mode + limit', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: 'Opus One',
        anchors: [{ surface: 'Opus One', canonicalValue: 'Opus One', entityType: 'wine', confidence: 0.95 }],
        contract: {
          requiresDrinkabilityCheck: false,
          requiresGroundedWineSearch: true,
          hasEntityMetadataSignal: true,
        },
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.mode).toBe('entity');
    expect(plan.searchInput.limit).toBeGreaterThan(0);
  });

  it('routes exact-metadata + drinkability through the production normalizer path', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'drinkability',
        preservedSurface: '지금 마시기 좋은 2010년 오퍼스 원',
        contract: {
          requiresDrinkabilityCheck: true,
          requiresGroundedWineSearch: false,
          hasEntityMetadataSignal: true,
          exactMetadataTargetVintage: 2010,
        },
        constraints: {
          hard: [
            makeConstraint('country', 'United States'),
            makeConstraint('region', 'Napa Valley'),
          ],
          soft: [],
          inferred: [],
        },
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.query).toBe('2010년 오퍼스 원');
    expect(plan.searchInput.limit).toBe(1);
    expect(plan.searchInput.filters?.find((constraint) => constraint.attribute === 'country')).toBeUndefined();
    expect(plan.searchInput.filters?.find((constraint) => constraint.attribute === 'region')).toBeUndefined();
    expect(plan.searchInput.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', value: 2010 }),
      ]),
    );
  });

  it('preserves analyzer-authored callerInterpretation on search inputs', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        preservedSurface: '스테이크에 어울리는 와인',
        callerInterpretation: {
          authority: 'caller',
          intent: 'pairing_search',
          queryClass: 'semantic_preference',
        },
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'pairing_search',
      queryClass: 'semantic_preference',
    });
  });

  it('requestedResultLimit overrides adaptive retrieval k for explicit top-N queries', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'search',
        preservedSurface: '나파 카베르네 탑3',
        requestedResultLimit: 3,
        recommendedBudget: { maxSteps: 4, perToolCap: 3, retrievalK: 200 },
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBe(3);
  });

  it('emits filters and preferences from tiered constraints when legacy flat constraints are empty', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        preservedSurface: '프랑스 달달한 와인',
        constraints: {
          hard: [makeConstraint('country', 'France')],
          soft: [makeConstraint('sweetness_min', 0.5, '>=')],
          inferred: [],
        },
        normalizedConstraints: [],
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.filters).toEqual([makeConstraint('country', 'France')]);
    expect(plan.searchInput.preferences).toEqual([makeConstraint('sweetness_min', 0.5, '>=')]);
  });
});

describe('DeterministicRouter — determinism', () => {
  it('same analysis → same plan (reference equality of structure)', () => {
    const router = makeRouter();
    const analysis = baseAnalysis({
      intent: 'search',
      preservedSurface: 'pinot noir',
      normalizedConstraints: [makeConstraint('grape_primary', 'Pinot Noir')],
    });
    const p1 = router.route(analysis);
    const p2 = router.route(analysis);
    expect(p1).toEqual(p2);
  });

  it('emitted plan validates against ExecutionPlanSchema for all rule paths', () => {
    const router = makeRouter();
    const samples: WineSearchAnalysis[] = [
      baseAnalysis({ intent: 'unknown' }),
      baseAnalysis({
        intent: 'search',
        decomposition: {
          kind: 'parallel-slot',
          slots: [{ wineType: 'red' }, { wineType: 'white' }],
        },
      }),
      baseAnalysis({ intent: 'search', expectedMultiStep: true }),
      baseAnalysis({ intent: 'search', preservedSurface: 'fallback' }),
    ];
    for (const a of samples) {
      const plan = router.route(a);
      // Throws if invalid — that's the assertion.
      ExecutionPlanSchema.parse(plan);
    }
  });
});
