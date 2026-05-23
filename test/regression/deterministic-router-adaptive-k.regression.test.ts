/**
 * DeterministicRouter — adaptive retrieval `k` propagation.
 *
 * Locks the contract that `analysis.recommendedBudget.retrievalK` flows
 * into the emitted `searchInput.limit` for the single-search routing
 * lane (the 80% happy path). When the analysis carries an exact-metadata
 * signal, the router instead pins `limit` to `EXACT_METADATA_SEARCH_LIMIT`
 * (= 1) — adaptive k is a candidate-pool sizing lever, not a metadata
 * lookup widener.
 *
 * Mini-loop tool-input adapters are covered separately by
 * `adaptSearchInput` in `mini-loop.ts`; this file focuses on the planner
 * → executor handoff.
 *
 * Append-only (CLAUDE.md test discipline).
 */

import { describe, expect, it } from 'vitest';
import { DeterministicRouter } from '../../src/application/wine-search/deterministic-router.js';
import { ExecutionPlanSchema } from '../../src/application/wine-search/execution-plan-schemas.js';
import { adaptSearchInput } from '../../src/application/wine-search/mini-loop.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';
import { EXACT_METADATA_SEARCH_LIMIT } from '../../src/domain/shared/constants/constraint-attributes.js';

const FIXED_NOW = new Date('2026-05-24T00:00:00Z');

function makeRouter(): DeterministicRouter {
  return new DeterministicRouter({ now: () => FIXED_NOW });
}

function baseAnalysis(
  overrides: Partial<WineSearchAnalysis> = {},
): WineSearchAnalysis {
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

describe('DeterministicRouter — adaptive retrieval k flows into searchInput.limit', () => {
  it('analysis carries retrievalK=200 → plan.searchInput.limit === 200 (single-search)', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        recommendedBudget: { maxSteps: 4, perToolCap: 3, retrievalK: 200 },
        preservedSurface: '카베르네 강한 와인',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBe(200);
    // Plan still validates against the schema (limit max raised to 500).
    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan);
  });

  it('analysis carries retrievalK=500 (exploratory) → plan.searchInput.limit === 500', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        recommendedBudget: { maxSteps: 4, perToolCap: 3, retrievalK: 500 },
        preservedSurface: '뭐 마실까',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBe(500);
  });

  it('analysis carries retrievalK=20 (entity_lookup) → plan.searchInput.limit === 20', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        recommendedBudget: { maxSteps: 3, perToolCap: 2, retrievalK: 20 },
        preservedSurface: '오푸스원',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBe(20);
  });

  it('analysis missing retrievalK (legacy fixture) → plan.searchInput.limit omitted', () => {
    // Backwards-compat: when `retrievalK` is absent the router does NOT
    // synthesise one — the downstream use case applies its own default.
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        recommendedBudget: { maxSteps: 4, perToolCap: 3 },
        preservedSurface: '레드 와인 추천',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBeUndefined();
  });
});

describe('DeterministicRouter — exact-metadata signal overrides adaptive k', () => {
  it('hasEntityMetadataSignal=true → limit=EXACT_METADATA_SEARCH_LIMIT (1), ignoring retrievalK', () => {
    // Exact-metadata lookups (vintage + entity) want the single canonical
    // match, not the adaptive-k candidate pool. The lever must be
    // overridden by the entity-metadata signal.
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        recommendedBudget: { maxSteps: 3, perToolCap: 2, retrievalK: 500 },
        contract: {
          requiresDrinkabilityCheck: false,
          requiresGroundedWineSearch: false,
          hasEntityMetadataSignal: true,
          exactMetadataTargetVintage: 2018,
        },
        preservedSurface: 'Opus One 2018',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBe(EXACT_METADATA_SEARCH_LIMIT);
    expect(plan.searchInput.mode).toBe('entity');
  });
});

describe('DeterministicRouter — schema bounds + adaptive k', () => {
  it('router never emits a limit beyond the schema max (500)', () => {
    const router = makeRouter();
    const plan = router.route(
      baseAnalysis({
        // Use the maximum valid retrievalK from the SSoT (exploratory=500).
        recommendedBudget: { maxSteps: 4, perToolCap: 3, retrievalK: 500 },
        preservedSurface: '와인 추천',
      }),
    );
    expect(plan.kind).toBe('single-search');
    if (plan.kind !== 'single-search') return;
    expect(plan.searchInput.limit).toBeLessThanOrEqual(500);
    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan);
  });
});

describe('mini-loop adaptSearchInput — LLM-vs-adaptive limit precedence', () => {
  // The mini-loop runner threads `analysis.recommendedBudget.retrievalK`
  // into `adaptSearchInput(raw, adaptiveDefault)`. The contract:
  //   1. If the LLM emits a numeric `limit`, use it as-is.
  //   2. Otherwise fall back to `adaptiveDefault`.
  //   3. If both are absent, omit `limit` (downstream applies its own default).

  it('LLM specifies limit=5 → adapter preserves it, adaptive default ignored', () => {
    const out = adaptSearchInput({ query: '카베르네', limit: 5 }, 200);
    expect(out.limit).toBe(5);
  });

  it('LLM omits limit, adaptive default=200 → adapter emits limit=200', () => {
    const out = adaptSearchInput({ query: '카베르네' }, 200);
    expect(out.limit).toBe(200);
  });

  it('LLM omits limit, no adaptive default → adapter omits limit', () => {
    const out = adaptSearchInput({ query: '카베르네' }, undefined);
    expect(out.limit).toBeUndefined();
  });

  it('LLM specifies non-numeric limit → adapter falls back to adaptive default', () => {
    // LLMs occasionally emit "limit": "10" instead of 10. The adapter must
    // not treat that as a valid LLM-specified value (it would short-circuit
    // the adaptive default with garbage).
    const out = adaptSearchInput({ query: '카베르네', limit: '10' as unknown as number }, 200);
    expect(out.limit).toBe(200);
  });

  it('LLM specifies non-finite limit (NaN) → adapter falls back to adaptive default', () => {
    const out = adaptSearchInput({ query: '카베르네', limit: Number.NaN }, 200);
    expect(out.limit).toBe(200);
  });
});
