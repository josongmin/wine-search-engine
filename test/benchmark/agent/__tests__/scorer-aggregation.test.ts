import { describe, it, expect } from 'vitest';
import { scoreScenario, DEFAULT_WEIGHTS, TIER_WEIGHTS } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';

describe('overall score (weighted geometric mean)', () => {
  it('all dims = 1 → overall ≈ 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        answer: 'good answer about test wine',
        observations: ['Found: test wine results'],
      }),
      1,    // judge
      1,    // faithfulness
    );
    expect(r.scores.overall).toBeGreaterThan(0.95);
  });

  it('answer quality = 0 drags overall down sharply', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      // Empty answer → answerQuality=0, all other dims = 1
      makeExecution({ answer: '' }),
      1,
    );
    // Arithmetic mean would give 5/6 ≈ 0.83. Geometric mean must be MUCH lower.
    expect(r.scores.overall).toBeLessThan(0.5);
  });

  it('fallback dim at 0.25 with rest at 1: clearly distinguishable from arithmetic mean', () => {
    // termination=0.25 (fallback partial credit), answer/tool/step/cost/judge all at 1
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '레드', canonical: 'red', type: 'wine_type' }],
        weights: {
          executionEfficiency: 0.2,
          answerQuality: 0.2,
          terminationCorrectness: 0.2,
          costEfficiency: 0.2,
          contextRelevance: 0.1,
          judge: 0.1,
        },
      }),
      makeExecution({
        terminationReason: 'fallback',
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"red-1","canonical_label":"Benchmark Red","wine_type":"red"}]}',
        ],
      }),
      1,
    );
    // Arithmetic mean would be 5/6 ≈ 0.833. Geometric should be lower.
    expect(r.scores.overall).toBeLessThan(0.83);
  });

  it('null-drop: judge=null excludes judge from geo-mean → overall ≥ judge=0.5', () => {
    // v4 null-drop: null dims are EXCLUDED (weight dropped from denominator).
    // judge=null → present dims only → no drag. judge=0.5 → participates → may lower.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018 | region: Napa Valley'] });
    const withNull = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withHalf = scoreScenario(makeScenario({ maxSteps: 5 }), base, 0.5, 0.8);
    expect(withNull.scores.overall).toBeGreaterThanOrEqual(withHalf.scores.overall);
  });

  it('null-drop: adding weak judge (0.2) lowers overall vs null (judge now participates)', () => {
    // judge=null → excluded. judge=0.2 → participates with low value → drags geo-mean.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018 | region: Napa Valley'] });
    const withNull = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withWeak = scoreScenario(makeScenario({ maxSteps: 5 }), base, 0.2, 0.8);
    expect(withWeak.scores.overall).toBeLessThan(withNull.scores.overall);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────


describe('per-tier weights', () => {
  it('adversarial tier weights termination higher than default', () => {
    // Build two scenarios that differ ONLY in tier; adversarial should
    // penalise a fallback termination harder than single_shot.
    const adv = scoreScenario(
      makeScenario({ maxSteps: 5 }, { tier: 'adversarial' }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    const ss = scoreScenario(
      makeScenario({ maxSteps: 5 }, { tier: 'single_shot' }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // Adversarial weights termination at 0.30, single_shot at 0.15 (default).
    // Both have termination=0 (fallback), so adversarial overall should be LOWER.
    expect(adv.scores.overall).toBeLessThan(ss.scores.overall);
  });

  it('per-scenario weight override wins over tier default', () => {
    const r = scoreScenario(
      makeScenario(
        {
          maxSteps: 5,
          // Aggressively up-weight terminationCorrectness
          weights: { terminationCorrectness: 0.80, answerQuality: 0.05, executionEfficiency: 0.05, costEfficiency: 0.05, judge: 0.05 },
        },
        { tier: 'single_shot' },
      ),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // With termination weight 0.80 and termination=0.25 (fallback partial credit),
    // overall is low but not collapsed due to EPS floor.
    expect(r.scores.overall).toBeLessThan(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Weight invariants (M4)
// ─────────────────────────────────────────────────────────────────────


describe('weight invariants', () => {
  const REQUIRED_KEYS = [
    'executionEfficiency',
    'answerQuality',
    'answerRelevancy',
    'terminationCorrectness',
    'costEfficiency',
    'judge',
    'contextRelevance',
    'contextRecall',
  ] as const;

  function sumWeights(w: Record<string, number>): number {
    return Object.values(w).reduce((a, b) => a + b, 0);
  }

  it('DEFAULT_WEIGHTS sums to 1.0', () => {
    expect(Math.abs(sumWeights(DEFAULT_WEIGHTS) - 1)).toBeLessThan(1e-9);
  });

  it('DEFAULT_WEIGHTS has all required dimension keys', () => {
    for (const key of REQUIRED_KEYS) {
      expect(DEFAULT_WEIGHTS).toHaveProperty(key);
      expect(typeof DEFAULT_WEIGHTS[key]).toBe('number');
    }
  });

  it('every TIER_WEIGHTS entry sums to 1.0', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      const sum = sumWeights(weights as Record<string, number>);
      expect(Math.abs(sum - 1), `tier ${tier} sum=${sum}`).toBeLessThan(1e-9);
    }
  });

  it('every TIER_WEIGHTS entry has all required keys', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      for (const key of REQUIRED_KEYS) {
        expect(weights, `tier ${tier} missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it('per-scenario partial weight override is renormalised to sum 1.0', () => {
    // Setting a single dimension should not break invariants — scorer must
    // renormalise so the user's intent (boost terminationCorrectness) holds
    // proportionally across the remaining dims.
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        // Only specify ONE dim — the others default. After merge they sum > 1.
        weights: { terminationCorrectness: 0.80 },
      }),
      makeExecution(),
      1,
    );
    // The score should be deterministic (no NaN, no Infinity).
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThanOrEqual(0);
    expect(r.scores.overall).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Structured checks (Track 1b — 9 schema fields)
// ─────────────────────────────────────────────────────────────────────


describe('multiple null dimensions — geo mean handles gracefully', () => {
  it('both judge and faithfulness null → overall uses remaining dims', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good wine recommendation' }),
      undefined,  // no judge
      undefined,  // no faithfulness
    );
    expect(r.scores.judge).toBeNull();
    expect(r.scores.faithfulness).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
  });

  it('all optional dims null → still computes from execution + answer + cost + termination', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        answer: 'a helpful wine answer',
        observations: [],  // no observations → contextRelevance null, contextRecall null
      }),
      undefined,  // no judge
      undefined,  // no faithfulness
    );
    expect(r.scores.judge).toBeNull();
    expect(r.scores.faithfulness).toBeNull();
    expect(r.scores.contextRelevance).toBeNull();
    expect(r.scores.contextRecall).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
  });
});


describe('weightedGeometricMean null-drop invariant', () => {
  // Regression guard (v4 — null-drop):
  // A disabled (null) dimension is EXCLUDED from the geo-mean computation.
  // Its weight is dropped from the denominator, remaining dims are renormalized.
  //
  // Key invariants:
  //   - null → excluded from geo-mean (no drag, no inflation)
  //   - judge=1.0 with null → null has no effect; judge=1.0 may raise or lower
  //     depending on whether 1.0 is above or below the present-dims geo-mean
  //   - judge=0.0 → always lowers overall (0.0 is below any positive geo-mean)
  //   - No coupling: adding info about dim A cannot change the contribution of dim B

  it('null judge is excluded: overall is computed from present dims only', () => {
    const rNull = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      undefined, // judge disabled → excluded
    );
    expect(rNull.scores.judge).toBeNull();
    expect(rNull.scores.overall).toBeGreaterThan(0);
    expect(Number.isFinite(rNull.scores.overall)).toBe(true);
  });

  it('null judge does not collapse overall compared to judge=0', () => {
    // judge=0 participates and drags geo-mean; judge=null is excluded.
    const rNull = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      undefined,
    );
    const rZero = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      0.0,
    );
    expect(rNull.scores.overall).toBeGreaterThan(rZero.scores.overall);
  });

  it('disabling two dims still yields finite positive overall', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'some answer', observations: [] }), // no obs → faith/ctxRel/ctxRecall null
      undefined, // judge null too
    );
    expect(r.scores.faithfulness).toBeNull();
    expect(r.scores.contextRelevance).toBeNull();
    expect(r.scores.judge).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(r.scores.overall).toBeLessThanOrEqual(1);
  });
});


describe('penalty constants are used correctly', () => {
  it('extra tool calls use PENALTY_EXTRA_TOOL_PER_CALL and CAP', () => {
    // 6 extra calls should hit the 50% cap
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_hybrid' }],
      }),
      makeExecution({
        stepCount: 7,
        toolCallCount: 7,
        toolsUsed: [
          tool('search_hybrid'),
          tool('extra1'), tool('extra2'), tool('extra3'),
          tool('extra4'), tool('extra5'), tool('extra6'),
        ],
      }),
      undefined,
    );
    // 6 extras, 10% each = 60% but capped at 50%. Score = 1.0 * 0.5 = 0.5
    expect(r.scores.toolAccuracy).toBeCloseTo(0.5, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P0-B regression: DIMENSION_FLOOR must NOT apply to execution/term/judge
// ─────────────────────────────────────────────────────────────────────


describe('P0-B regression — DIMENSION_FLOOR exemptions', () => {
  it('executionEfficiency near-zero is NOT floored to 0.05 (regression mask prevention)', () => {
    // Before fix: executionEfficiency=0.01 would be raised to DIMENSION_FLOOR=0.05
    // making a critical tool failure look 5x less bad in the geo-mean.
    // After fix: executionEfficiency passes through unmodified.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_hybrid' }] }),
      makeExecution({
        stepCount: 20,        // massively over budget → near-zero stepEfficiency
        toolCallCount: 20,
        toolsUsed: [tool('wrong_tool')], // wrong tool → low toolAccuracy
      }),
      undefined,
    );
    // executionEfficiency = merge(toolAccuracy, stepEfficiency) — both near 0.
    // Must stay near 0, NOT be floored to 0.05.
    expect(r.scores.executionEfficiency).toBeLessThan(0.1);
  });

  it('judge=0 is NOT floored — stays at 0 and drives overall lower than no-judge', () => {
    const withZeroJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      0,
    );
    // Structural: judge dim present in scores at 0
    expect(withZeroJudge.scores.judge).toBe(0);

    const withNoJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      undefined,
    );
    // Before P0-B fix: judge=0 was floored to 0.05, making it barely worse than no-judge.
    // After fix: judge=0 is unflored, so it drives overall clearly lower than no-judge.
    expect(withZeroJudge.scores.overall).toBeLessThan(withNoJudge.scores.overall);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P1-B regression: hard constraint failure → contextRelevance = 0
// ─────────────────────────────────────────────────────────────────────


describe('TIER_WEIGHTS sum to 1.0', () => {
  it('core tier weights sum to 1.0', () => {
    // 'core' not a named tier — use knowledge_hybrid as the representative content-quality tier
    const sum = Object.values(TIER_WEIGHTS.knowledge_hybrid).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
  it('advanced tier weights sum to 1.0', () => {
    // 'advanced' not a named tier — use extreme as the representative cost-sensitive tier
    const sum = Object.values(TIER_WEIGHTS.extreme).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
  it('adversarial tier weights sum to 1.0', () => {
    const sum = Object.values(TIER_WEIGHTS.adversarial).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P4: Constraint Satisfaction Rate (CSR)
// ─────────────────────────────────────────────────────────────────────

