/**
 * Retrieval Plan Builder — property-based regression suite.
 *
 * Locks the SOTA++ invariants of `buildRetrievalPlan`
 * (`src/domain/retrieval/service/retrieval-plan-builder.ts`), which maps a
 * ConstraintBundle into a structured retrieval plan (hard filter tokens +
 * soft/inferred boost tiers + sensory priors).
 *
 * Invariants under test (all fast-check, numRuns = 100):
 *   1. DETERMINISM      — same bundle → byte-identical plan, repeated calls.
 *   2. ORDER-INDEPENDENCE — permuting input constraint arrays yields an
 *                          identical plan (boosts sorted by content, not position).
 *   3. IDEMPOTENCE       — feeding a plan's surviving constraints back produces
 *                          a stable, re-derivable plan (no drift across rebuilds).
 *   4. CONSTRAINT CONSERVATION — every soft/inferred constraint maps to exactly
 *                          one boost (no silent drop) up to the bounded cap.
 *   5. BOUNDED FAN-OUT   — each tier ≤ MAX_BOOSTS_PER_TIER (named source const),
 *                          dropping the WEAKEST signals first.
 *   6. WEIGHT INVARIANT  — every boost weight ∈ [BOOST_WEIGHT_MIN, BOOST_WEIGHT_MAX]
 *                          and finite, even for NaN/∞/out-of-range confidences.
 *   7. NFC PRESERVATION  — Korean (한글) / accented-Latin string values are
 *                          NFC-normalized; NFD and NFC inputs collapse to one plan.
 *   8. EMPTY → MINIMAL   — empty bundle yields a typed minimal plan (all tiers
 *                          empty, version present).
 *   9. RRF SSoT          — plan version is stable and the multiplier comes from
 *                          the exported source constant (rule 13 — bounds from
 *                          SOURCE not test).
 *
 * Append-only regression file — never delete. See CLAUDE.md "Test discipline".
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildRetrievalPlan,
  retrievalPlanVersion,
  INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER,
  MAX_BOOSTS_PER_TIER,
  BOOST_WEIGHT_MIN,
  BOOST_WEIGHT_MAX,
  type BoostSignal,
  type SensoryPrior,
} from '../../src/domain/retrieval/service/retrieval-plan-builder.js';
import { SENSORY_PRIOR_ATTRIBUTES } from '../../src/domain/shared/constants/constraint-attributes.js';
import type {
  ConstraintBundle,
  NormalizedConstraint,
  ConstraintOperator,
} from '../../src/domain/shared/types/index.js';

const NUM_RUNS = 100;

// --- Arbitraries ---------------------------------------------------------

const OPERATORS: readonly ConstraintOperator[] = [
  '=', '<=', '>=', 'range', 'in', 'exclude', 'not_in',
];

// Mix of ASCII, Korean (한글), accented Latin, emoji — exercise NFC + Unicode.
const STRING_VALUES = [
  'cabernet sauvignon',
  '까베르네 소비뇽', // Korean
  'rhône', // accented Latin
  'Côtes du Rhône',
  'médoc',
  '보르도', // Korean
  '🍷 reserve', // emoji
  'nero d\'avola',
];

const ATTRIBUTES = [
  'body', 'tannin', 'acidity', 'sweetness', // sensory-prior attributes
  'style', 'price_band', 'grape_primary', 'region', 'critic_score',
];

const constraintValueArb: fc.Arbitrary<NormalizedConstraint['value']> = fc.oneof(
  fc.constantFrom(...STRING_VALUES),
  // include non-finite / out-of-range to exercise weight clamping downstream
  fc.double({ noDefaultInfinity: false, noNaN: false }),
  fc.record({ min: fc.double({ min: -50, max: 50, noNaN: true }), max: fc.double({ min: -50, max: 50, noNaN: true }) }),
  fc.array(fc.constantFrom(...STRING_VALUES), { minLength: 1, maxLength: 4 }),
);

const constraintArb: fc.Arbitrary<NormalizedConstraint> = fc.record({
  attribute: fc.constantFrom(...ATTRIBUTES),
  operator: fc.constantFrom(...OPERATORS),
  value: constraintValueArb,
  source_phrase: fc.string({ maxLength: 20 }),
  // confidence intentionally allows out-of-[0,1] and non-finite to test clamping
  confidence: fc.oneof(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.double({ noDefaultInfinity: false, noNaN: false }),
  ),
  mapping_version: fc.option(
    fc.constantFrom('rule-based-v1.0', 'entity-resolver-v1.0', 'llm-v1.0'),
    { nil: undefined },
  ),
}) as fc.Arbitrary<NormalizedConstraint>;

const bundleArb: fc.Arbitrary<ConstraintBundle> = fc.record({
  hard: fc.array(constraintArb, { maxLength: 6 }),
  soft: fc.array(constraintArb, { maxLength: 8 }),
  inferred: fc.array(constraintArb, { maxLength: 8 }),
});

// --- Helpers -------------------------------------------------------------

function shuffleBundle(bundle: ConstraintBundle, rotateBy: number): ConstraintBundle {
  const rotate = <T>(arr: readonly T[]): T[] => {
    if (arr.length === 0) return [];
    const n = ((rotateBy % arr.length) + arr.length) % arr.length;
    return [...arr.slice(n), ...arr.slice(0, n)];
  };
  return { hard: rotate(bundle.hard), soft: rotate(bundle.soft), inferred: rotate(bundle.inferred) };
}

// --- Tests ---------------------------------------------------------------

describe('retrieval-plan-builder properties', () => {
  it('1. DETERMINISM: same bundle → identical plan across repeated calls', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const a = buildRetrievalPlan(bundle);
        const b = buildRetrievalPlan(bundle);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('2. ORDER-INDEPENDENCE: permuting input arrays yields identical plan', () => {
    fc.assert(
      fc.property(bundleArb, fc.integer({ min: 1, max: 7 }), (bundle, rot) => {
        const original = buildRetrievalPlan(bundle);
        const permuted = buildRetrievalPlan(shuffleBundle(bundle, rot));
        // softBoosts + inferredBoosts + sensoryPriors are content-sorted, so a
        // permutation of the inputs must not change them.
        expect(permuted.softBoosts).toEqual(original.softBoosts);
        expect(permuted.inferredBoosts).toEqual(original.inferredBoosts);
        expect(permuted.sensoryPriors).toEqual(original.sensoryPriors);
        // hardFilterTokens follow input order by design (filter semantics are
        // an ordered token stream); they are NOT asserted order-independent.
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('3. IDEMPOTENCE: rebuilding from surviving soft/inferred is stable', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const plan = buildRetrievalPlan(bundle);
        // Reconstruct a bundle from the plan's surviving boosts and rebuild.
        const toConstraint = (b: BoostSignal): NormalizedConstraint => ({
          attribute: b.attribute,
          operator: b.operator,
          value: b.value,
          source_phrase: '',
          confidence: b.weight,
          ...(b.source !== 'unknown' ? { mapping_version: b.source } : {}),
        });
        const rebuilt = buildRetrievalPlan({
          hard: bundle.hard,
          soft: plan.softBoosts.map(toConstraint),
          inferred: [],
        });
        // The soft tier, sorted by content, must be a stable fixed point.
        expect(rebuilt.softBoosts).toEqual(plan.softBoosts);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('4. CONSERVATION: every soft/inferred constraint maps to a boost (up to cap)', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const plan = buildRetrievalPlan(bundle);
        expect(plan.softBoosts.length).toBe(Math.min(bundle.soft.length, MAX_BOOSTS_PER_TIER));
        expect(plan.inferredBoosts.length).toBe(Math.min(bundle.inferred.length, MAX_BOOSTS_PER_TIER));
        // No fabricated attributes: every boost attribute came from the input.
        const softAttrs = new Set(bundle.soft.map((c) => c.attribute));
        for (const b of plan.softBoosts) expect(softAttrs.has(b.attribute)).toBe(true);
        const infAttrs = new Set(bundle.inferred.map((c) => c.attribute));
        for (const b of plan.inferredBoosts) expect(infAttrs.has(b.attribute)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('5. BOUNDED FAN-OUT: each tier ≤ MAX_BOOSTS_PER_TIER, weakest dropped first', () => {
    // Construct an over-cap bundle with distinct confidences to test the drop policy.
    const over = MAX_BOOSTS_PER_TIER + 10;
    const soft: NormalizedConstraint[] = Array.from({ length: over }, (_, i) => ({
      attribute: ATTRIBUTES[i % ATTRIBUTES.length] as string,
      operator: '=' as const,
      value: `v${i}`,
      source_phrase: '',
      // strictly increasing confidence so the LOWEST should be the ones dropped
      confidence: (i + 1) / (over + 1),
    }));
    const plan = buildRetrievalPlan({ hard: [], soft, inferred: [] });
    expect(plan.softBoosts.length).toBe(MAX_BOOSTS_PER_TIER);
    // The minimum surviving weight must be >= the max dropped weight.
    // (loop, not Math.min(...spread) — rule 9: spread overflows on large arrays)
    let minSurviving = Number.POSITIVE_INFINITY;
    for (const b of plan.softBoosts) {
      if (b.weight < minSurviving) minSurviving = b.weight;
    }
    const droppedCount = over - MAX_BOOSTS_PER_TIER;
    const maxDroppedWeight = droppedCount / (over + 1); // weakest dropped
    expect(minSurviving).toBeGreaterThanOrEqual(maxDroppedWeight);
  });

  it('6. WEIGHT INVARIANT: every boost weight is finite and in [MIN, MAX]', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const plan = buildRetrievalPlan(bundle);
        const all: BoostSignal[] = [...plan.softBoosts, ...plan.inferredBoosts];
        for (const b of all) {
          expect(Number.isFinite(b.weight)).toBe(true);
          expect(b.weight).toBeGreaterThanOrEqual(BOOST_WEIGHT_MIN);
          expect(b.weight).toBeLessThanOrEqual(BOOST_WEIGHT_MAX);
        }
        // Sensory prior confidences are also clamped.
        for (const p of plan.sensoryPriors) {
          expect(Number.isFinite(p.confidence)).toBe(true);
          expect(p.confidence).toBeGreaterThanOrEqual(BOOST_WEIGHT_MIN);
          expect(p.confidence).toBeLessThanOrEqual(BOOST_WEIGHT_MAX);
          expect(Number.isFinite(p.value)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('6b. INFERRED weight uses the exported SOURCE multiplier (rule 13)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ATTRIBUTES),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attribute, confidence) => {
          const plan = buildRetrievalPlan({
            hard: [],
            soft: [],
            inferred: [{
              attribute, operator: '=', value: 'x', source_phrase: '', confidence,
            }],
          });
          const boost = plan.inferredBoosts[0];
          expect(boost).toBeDefined();
          // weight === clamp(confidence × multiplier) — multiplier from SOURCE.
          const expected = Math.max(0, Math.min(1, confidence * INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER));
          expect(boost?.weight).toBeCloseTo(expected, 10);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('7. NFC PRESERVATION: NFD and NFC Korean/Latin inputs collapse to one plan', () => {
    fc.assert(
      fc.property(fc.constantFrom('까베르네', 'rhône', 'médoc', '보르도'), (raw) => {
        const nfc = raw.normalize('NFC');
        const nfd = raw.normalize('NFD');
        const planNfc = buildRetrievalPlan({
          hard: [], soft: [{ attribute: 'region', operator: '=', value: nfc, source_phrase: '', confidence: 0.9 }], inferred: [],
        });
        const planNfd = buildRetrievalPlan({
          hard: [], soft: [{ attribute: 'region', operator: '=', value: nfd, source_phrase: '', confidence: 0.9 }], inferred: [],
        });
        // Both forms must yield the SAME (NFC) value in the boost.
        expect(planNfc.softBoosts[0]?.value).toBe(nfc);
        expect(planNfd.softBoosts[0]?.value).toBe(nfc);
        expect(JSON.stringify(planNfc)).toBe(JSON.stringify(planNfd));
        // The stored value must itself be NFC-normalized.
        const v = planNfd.softBoosts[0]?.value;
        expect(typeof v === 'string' ? v.normalize('NFC') : v).toBe(v);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('7b. NFC PRESERVATION: array values are normalized element-wise', () => {
    const plan = buildRetrievalPlan({
      hard: [],
      soft: [{
        attribute: 'grape_primary',
        operator: 'in',
        value: ['까베르네'.normalize('NFD'), 'médoc'.normalize('NFD')],
        source_phrase: '',
        confidence: 0.8,
      }],
      inferred: [],
    });
    const value = plan.softBoosts[0]?.value;
    expect(Array.isArray(value)).toBe(true);
    expect(value).toEqual(['까베르네'.normalize('NFC'), 'médoc'.normalize('NFC')]);
  });

  it('8. EMPTY → MINIMAL typed plan', () => {
    const plan = buildRetrievalPlan({ hard: [], soft: [], inferred: [] });
    expect(plan.hardFilterTokens).toEqual([]);
    expect(plan.softBoosts).toEqual([]);
    expect(plan.inferredBoosts).toEqual([]);
    expect(plan.sensoryPriors).toEqual([]);
    expect(plan.planVersion).toBe(retrievalPlanVersion());
    expect(typeof plan.planVersion).toBe('string');
    expect(plan.planVersion.length).toBeGreaterThan(0);
  });

  it('9. SENSORY PRIORS only for numeric-finite sensory attributes', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const plan = buildRetrievalPlan(bundle);
        for (const p of plan.sensoryPriors) {
          expect(SENSORY_PRIOR_ATTRIBUTES.has(p.attribute)).toBe(true);
        }
        // Every inferred constraint that IS a finite-numeric sensory attribute
        // must appear as a prior (conservation for the prior tier).
        const expectedPriorCount = bundle.inferred.filter(
          (c) => SENSORY_PRIOR_ATTRIBUTES.has(c.attribute)
            && typeof c.value === 'number'
            && Number.isFinite(c.value),
        ).length;
        expect(plan.sensoryPriors.length).toBe(expectedPriorCount);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('9b. plan version is stable and matches the trace accessor', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        expect(buildRetrievalPlan(bundle).planVersion).toBe(retrievalPlanVersion());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// Type-only assertion: SensoryPrior attribute is a closed sensory union.
const _typecheck: SensoryPrior['attribute'] = 'body';
void _typecheck;
