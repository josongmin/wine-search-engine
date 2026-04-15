/**
 * Tests for constraint-relaxation.ts — progressive constraint relaxation ladder.
 *
 * Covers:
 *   - Empty ladder when no relaxable constraints
 *   - Appellation removed before region before country (specificity order)
 *   - wine_type / classification never relaxed (hard floor)
 *   - relaxedAttributes accumulates correctly across steps
 *   - relaxOneStep returns first rung
 *   - Multiple constraints of same tier handled correctly
 *   - Soft/inferred constraints preserved unchanged through all steps
 */

import { describe, it, expect } from 'vitest';
import { buildRelaxationLadder, relaxOneStep } from '../constraint-relaxation.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../../shared/types/index.js';

function makeConstraint(attribute: string, value = 'val'): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: attribute,
    confidence: 0.9,
  };
}

function makeBundle(
  hardAttrs: string[],
  softAttrs: string[] = [],
): ConstraintBundle {
  return {
    hard: hardAttrs.map((a) => makeConstraint(a)),
    soft: softAttrs.map((a) => makeConstraint(a)),
    inferred: [],
  };
}

describe('buildRelaxationLadder', () => {
  it('returns empty ladder when no hard constraints', () => {
    const ladder = buildRelaxationLadder(makeBundle([]));
    expect(ladder).toHaveLength(0);
  });

  it('returns empty ladder when only floor attributes (wine_type, classification)', () => {
    const ladder = buildRelaxationLadder(makeBundle(['wine_type', 'classification']));
    expect(ladder).toHaveLength(0);
  });

  it('color is a floor attribute — never relaxed', () => {
    // color should be in HARD_FLOOR_ATTRIBUTES like wine_type and classification
    const ladder = buildRelaxationLadder(makeBundle(['color', 'region']));
    expect(ladder).toHaveLength(1);
    // Only region is relaxed; color stays in hard list for every step
    for (const step of ladder) {
      expect(step.constraints.hard.map((c) => c.attribute)).toContain('color');
    }
  });

  it('returns empty ladder when only color floor attribute', () => {
    const ladder = buildRelaxationLadder(makeBundle(['color']));
    expect(ladder).toHaveLength(0);
  });

  it('single relaxable constraint — ladder has 1 step, removes that constraint', () => {
    const ladder = buildRelaxationLadder(makeBundle(['wine_type', 'region']));
    expect(ladder).toHaveLength(1);
    expect(ladder[0]?.relaxedAttributes).toEqual(['region']);
    // wine_type preserved in relaxed hard list
    expect(ladder[0]?.constraints.hard.map((c) => c.attribute)).toContain('wine_type');
    expect(ladder[0]?.constraints.hard.map((c) => c.attribute)).not.toContain('region');
  });

  it('removes appellation before region before country (specificity order)', () => {
    const ladder = buildRelaxationLadder(makeBundle(['wine_type', 'country', 'region', 'appellation']));
    // Step 1: removes appellation only
    expect(ladder[0]?.relaxedAttributes).toEqual(['appellation']);
    // Step 2: removes appellation + region
    expect(ladder[1]?.relaxedAttributes).toEqual(['appellation', 'region']);
    // Step 3: removes appellation + region + country
    expect(ladder[2]?.relaxedAttributes).toEqual(['appellation', 'region', 'country']);
    // wine_type always preserved
    for (const step of ladder) {
      expect(step.constraints.hard.map((c) => c.attribute)).toContain('wine_type');
    }
  });

  it('vintage_year removed after geography', () => {
    const ladder = buildRelaxationLadder(makeBundle(['region', 'vintage_year']));
    expect(ladder[0]?.relaxedAttributes).toEqual(['region']);
    expect(ladder[1]?.relaxedAttributes).toEqual(['region', 'vintage_year']);
  });

  it('grape_primary removed last among relaxable attributes', () => {
    const ladder = buildRelaxationLadder(makeBundle(['appellation', 'grape_primary']));
    expect(ladder[0]?.relaxedAttributes).toEqual(['appellation']);
    expect(ladder[1]?.relaxedAttributes).toEqual(['appellation', 'grape_primary']);
  });

  it('preserves Bordeaux region before Cabernet grape relaxation', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('region', 'Bordeaux'),
        makeConstraint('grape_primary', 'Cabernet Sauvignon'),
      ],
      soft: [],
      inferred: [],
    };

    const ladder = buildRelaxationLadder(bundle);

    expect(ladder).toHaveLength(2);
    expect(ladder[0]?.relaxedAttributes).toEqual(['grape_primary']);
    expect(ladder[0]?.constraints.hard).toEqual([
      expect.objectContaining({ attribute: 'region', value: 'Bordeaux' }),
    ]);
    expect(ladder[1]?.relaxedAttributes).toEqual(['grape_primary', 'region']);
  });

  it('soft and inferred constraints preserved unchanged across all steps', () => {
    const bundle = makeBundle(['region', 'vintage_year'], ['body', 'price_band']);
    const ladder = buildRelaxationLadder(bundle);
    for (const step of ladder) {
      expect(step.constraints.soft).toEqual(bundle.soft);
      expect(step.constraints.inferred).toEqual(bundle.inferred);
    }
  });

  it('ladder length equals number of relaxable constraints', () => {
    // 2 relaxable (region, grape_primary) + 1 floor (wine_type)
    const ladder = buildRelaxationLadder(makeBundle(['wine_type', 'region', 'grape_primary']));
    expect(ladder).toHaveLength(2);
  });

  it('fully relaxed final step has only floor attributes in hard list', () => {
    const ladder = buildRelaxationLadder(makeBundle(['wine_type', 'region', 'vintage_year']));
    const lastStep = ladder.at(-1);
    const remainingAttrs = lastStep?.constraints.hard.map((c) => c.attribute) ?? [];
    expect(remainingAttrs).toEqual(['wine_type']);
  });

  // Regression: boundary cases for N=1,2,3,4 relaxable constraints
  it('N=1 relaxable: ladder has 1 step', () => {
    expect(buildRelaxationLadder(makeBundle(['region']))).toHaveLength(1);
  });
  it('N=2 relaxable: ladder has 2 steps', () => {
    expect(buildRelaxationLadder(makeBundle(['region', 'vintage_year']))).toHaveLength(2);
  });
  it('N=3 relaxable: ladder has 3 steps', () => {
    expect(buildRelaxationLadder(makeBundle(['appellation', 'region', 'country']))).toHaveLength(3);
  });
  it('N=4 relaxable: ladder has 4 steps', () => {
    expect(buildRelaxationLadder(makeBundle(['appellation', 'region', 'country', 'grape_primary']))).toHaveLength(4);
  });
});

describe('same-attribute duplicate constraint deduplication (Fix P1-B)', () => {
  it('two constraints on vintage_year (>= and <=) count as one relaxation step', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'vintage_year', operator: '>=', value: 2018, source_phrase: 'from 2018', confidence: 0.9 },
        { attribute: 'vintage_year', operator: '<=', value: 2022, source_phrase: 'to 2022', confidence: 0.9 },
        makeConstraint('region'),
      ],
      soft: [],
      inferred: [],
    };
    const ladder = buildRelaxationLadder(bundle);
    // vintage_year has 2 constraints but is 1 relaxation unit; region is another
    // So ladder has 2 steps (region first in priority, then vintage_year)
    expect(ladder).toHaveLength(2);
    // Both vintage_year constraints removed in step 2
    expect(ladder[1]?.constraints.hard.map((c) => c.attribute)).not.toContain('vintage_year');
    // relaxedAttributes should not have 'vintage_year' twice
    const finalRelaxed = ladder[1]?.relaxedAttributes ?? [];
    const vintageEntries = finalRelaxed.filter((a) => a === 'vintage_year');
    expect(vintageEntries).toHaveLength(1);
  });
});

describe('relaxOneStep', () => {
  it('returns undefined when no relaxable constraints', () => {
    expect(relaxOneStep(makeBundle(['wine_type']))).toBeUndefined();
  });

  it('returns first rung of ladder (most specific constraint removed)', () => {
    const step = relaxOneStep(makeBundle(['wine_type', 'appellation', 'region']));
    expect(step?.relaxedAttributes).toEqual(['appellation']);
  });

  it('returns grape_primary first for Bordeaux Cabernet queries', () => {
    const bundle: ConstraintBundle = {
      hard: [
        makeConstraint('region', 'Bordeaux'),
        makeConstraint('grape_primary', 'Cabernet Sauvignon'),
      ],
      soft: [],
      inferred: [],
    };

    const step = relaxOneStep(bundle);

    expect(step?.relaxedAttributes).toEqual(['grape_primary']);
    expect(step?.constraints.hard).toEqual([
      expect.objectContaining({ attribute: 'region', value: 'Bordeaux' }),
    ]);
  });

  it('returned plan constraints have correct hard count', () => {
    // wine_type (floor) + appellation + region → remove appellation → 2 remain
    const step = relaxOneStep(makeBundle(['wine_type', 'appellation', 'region']));
    expect(step?.constraints.hard).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Round 4: inferred constraints on relaxed attributes must also be dropped
// ──────────────────────────────────────────────────────────────────────────────

describe('buildRelaxationLadder — inferred constraint filtering', () => {
  it('inferred constraint with the EXACT SAME attribute as a relaxed hard constraint is dropped', () => {
    // When an attribute appears in BOTH hard and inferred, relaxing the hard constraint
    // should also remove it from inferred — otherwise the inferred version would still
    // produce scoring boosts and region-browse seeds for the supposedly-relaxed attribute.
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('region', 'Burgundy')],
      soft: [],
      inferred: [makeConstraint('region', 'Burgundy')], // same attribute in both
    };
    const ladder = buildRelaxationLadder(bundle);
    expect(ladder).toHaveLength(1);
    // region relaxed → inferred[region] must also be gone
    expect(ladder[0]?.constraints.inferred).toHaveLength(0);
  });

  it('inferred constraint on an attribute NOT relaxed in this step is preserved', () => {
    // Query: hard=[appellation, region]. Step 1 removes appellation.
    // inferred[country=France] is a different attribute than the relaxed appellation,
    // so it must be preserved.
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('appellation', 'Gevrey-Chambertin'), makeConstraint('region', 'Burgundy')],
      soft: [],
      inferred: [makeConstraint('country', 'France')],
    };
    const ladder = buildRelaxationLadder(bundle);
    // Step 1: appellation relaxed → inferred[country] unaffected
    expect(ladder[0]?.constraints.inferred.some((c) => c.attribute === 'country')).toBe(true);
    // Step 2: appellation + region relaxed → inferred[country] still unaffected
    expect(ladder[1]?.constraints.inferred.some((c) => c.attribute === 'country')).toBe(true);
  });

  it('soft constraints are preserved unchanged through relaxation', () => {
    const bundle: ConstraintBundle = {
      hard: [makeConstraint('appellation', 'Gevrey-Chambertin')],
      soft: [makeConstraint('price_band', 'premium')],
      inferred: [],
    };
    const ladder = buildRelaxationLadder(bundle);
    expect(ladder[0]?.constraints.soft).toHaveLength(1);
    expect(ladder[0]?.constraints.soft[0]?.attribute).toBe('price_band');
  });
});
