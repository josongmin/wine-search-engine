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
import { DeterministicRouter } from '../deterministic-router.js';
import { ExecutionPlanSchema } from '../execution-plan-schemas.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Builders — small, explicit, used per test. Keeping them inline (not
// shared with query-analyzer.test.ts) so router tests stay independent.
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-21T12:00:00Z');

function makeRouter() {
  return new DeterministicRouter({ now: () => FIXED_NOW });
}

function baseAnalysis(overrides: Partial<WineSearchAnalysis> = {}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
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

describe('DeterministicRouter — Rule 2: comparison decomposition', () => {
  it('Bordeaux 2015 vs Burgundy 2018 → comparison', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'compare',
        preservedSurface: 'Bordeaux 2015 vs Burgundy 2018',
        expectedMultiStep: true,
        decomposition: {
          kind: 'comparison',
          legs: [
            { surface: 'Bordeaux 2015', constraints: [makeConstraint('region', 'Bordeaux'), makeConstraint('vintage', 2015)] },
            { surface: 'Burgundy 2018', constraints: [makeConstraint('region', 'Burgundy'), makeConstraint('vintage', 2018)] },
          ],
        },
      }),
    );
    expect(plan.kind).toBe('comparison');
    if (plan.kind !== 'comparison') return;
    expect(plan.comparisonInput.legs).toHaveLength(2);
    expect(plan.comparisonInput.legs[0].surface).toBe('Bordeaux 2015');
    expect(plan.comparisonInput.intent).toBe('compare');
    expect(ExecutionPlanSchema.parse(plan)).toBeTruthy();
  });

  it('Korean comparison 보르도 2015 vs 부르고뉴 2018 → comparison', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'compare',
        preservedSurface: '보르도 2015 vs 부르고뉴 2018',
        hangulDominant: true,
        expectedMultiStep: true,
        decomposition: {
          kind: 'comparison',
          legs: [
            { surface: '보르도 2015', constraints: [makeConstraint('region', '보르도')] },
            { surface: '부르고뉴 2018', constraints: [makeConstraint('region', '부르고뉴')] },
          ],
        },
      }),
    );
    expect(plan.kind).toBe('comparison');
  });
});

describe('DeterministicRouter — Rule 3: parallel-slot decomposition', () => {
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
    const slot0BudgetFilter = plan.searches[0]?.filters?.find((c) => c.attribute === 'max_price_krw');
    expect(slot0BudgetFilter?.value).toBe(50_000);
  });
});

describe('DeterministicRouter — Rule 4: drinkability', () => {
  it('Opus One 2018 + drinkability + anchor → search-then-drinkability', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'drinkability',
        preservedSurface: 'Opus One 2018 지금 마실만한가',
        anchors: [{ surface: 'Opus One', canonicalValue: 'Opus One', entityType: 'wine', confidence: 0.95 }],
        contract: {
          requiresDrinkabilityCheck: true,
          requiresGroundedWineSearch: true,
          hasEntityMetadataSignal: true,
          requiredTool: 'check_drinking_window',
          exactMetadataTargetVintage: 2018,
        },
      }),
    );
    expect(plan.kind).toBe('search-then-drinkability');
    if (plan.kind !== 'search-then-drinkability') return;
    expect(plan.drinkabilityTemplate.targetYear).toBe(FIXED_NOW.getFullYear());
    expect(plan.drinkabilityTemplate.maxAnchors).toBeGreaterThanOrEqual(1);
    // hasEntityMetadataSignal → exact-metadata limit applied.
    expect(plan.searchInput.limit).toBeDefined();
    expect(plan.searchInput.mode).toBe('entity');
  });

  it('drinkability flag without any anchor → falls through to multi-step or single-search', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        intent: 'drinkability',
        preservedSurface: '지금 마시기 좋은 와인',
        hangulDominant: true,
        contract: {
          requiresDrinkabilityCheck: true,
          requiresGroundedWineSearch: true,
          hasEntityMetadataSignal: false,
        },
        expectedMultiStep: true,
      }),
    );
    // Rule 5 doesn't fire (anchors empty), Rule 6 kicks in.
    expect(plan.kind).toBe('multi-step');
  });
});

describe('DeterministicRouter — Rule 6: multi-step handoff', () => {
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
});

describe('DeterministicRouter — Rule 7: single-search (default)', () => {
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
        intent: 'compare',
        expectedMultiStep: true,
        decomposition: {
          kind: 'comparison',
          legs: [
            { surface: 'A', constraints: [] },
            { surface: 'B', constraints: [] },
          ],
        },
      }),
      baseAnalysis({
        intent: 'search',
        decomposition: {
          kind: 'parallel-slot',
          slots: [{ wineType: 'red' }, { wineType: 'white' }],
        },
      }),
      baseAnalysis({
        intent: 'drinkability',
        anchors: [{ surface: 'X', canonicalValue: 'X', entityType: 'wine', confidence: 0.9 }],
        contract: {
          requiresDrinkabilityCheck: true,
          requiresGroundedWineSearch: true,
          hasEntityMetadataSignal: true,
          requiredTool: 'check_drinking_window',
          exactMetadataTargetVintage: 2018,
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
