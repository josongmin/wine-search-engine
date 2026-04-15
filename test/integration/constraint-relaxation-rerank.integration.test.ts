/**
 * Integration test: Constraint relaxation + rerank pipeline.
 *
 * Tests the pure-function layer of constraint relaxation:
 *   - buildRelaxationLadder()  — correct relaxation order and floor attributes
 *   - buildRelaxedCompiledQuery() (module-private, tested indirectly)
 *   - Edge cases: empty constraints, only floor attributes, duplicate attributes
 *
 * executeHybridRouteRankingPipeline() depends on candidatePool, ranker, etc.
 * so we focus on the deterministic, I/O-free functions exported from
 * constraint-relaxation.ts and the module-private buildRelaxedCompiledQuery()
 * tested indirectly via buildRelaxationLadder() output shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRelaxationLadder,
  relaxOneStep,
  type RelaxedConstraintPlan,
} from '../../src/domain/query/service/constraint-relaxation.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../src/domain/shared/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConstraint(attribute: string, value: string = 'test-value'): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: `${attribute} constraint`,
    confidence: 0.95,
  };
}

function makeBundle(
  hard: NormalizedConstraint[],
  soft: NormalizedConstraint[] = [],
  inferred: NormalizedConstraint[] = [],
): ConstraintBundle {
  return { hard, soft, inferred };
}

function relaxedAttributeSequence(ladder: ReadonlyArray<RelaxedConstraintPlan>): string[][] {
  return ladder.map((step) => [...step.relaxedAttributes]);
}

// ─── buildRelaxationLadder ──────────────────────────────────────────────────────

describe('buildRelaxationLadder', () => {
  describe('relaxation order', () => {
    it('follows priority: appellation → region → country → vintage_year → grape_primary', () => {
      const bundle = makeBundle([
        makeConstraint('grape_primary', 'Cabernet Sauvignon'),
        makeConstraint('country', 'France'),
        makeConstraint('appellation', 'Saint-Emilion'),
        makeConstraint('region', 'Bordeaux'),
        makeConstraint('vintage_year', '2018'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(5);
      // Each step cumulatively removes more attributes
      const sequence = relaxedAttributeSequence(ladder);
      expect(sequence[0]).toEqual(['appellation']);
      expect(sequence[1]).toEqual(['appellation', 'region']);
      expect(sequence[2]).toEqual(['appellation', 'region', 'country']);
      expect(sequence[3]).toEqual(['appellation', 'region', 'country', 'vintage_year']);
      expect(sequence[4]).toEqual(['appellation', 'region', 'country', 'vintage_year', 'grape_primary']);
    });

    it('handles vintage alias "vintage" alongside "vintage_year"', () => {
      const bundle = makeBundle([
        makeConstraint('vintage', '2020'),
        makeConstraint('region', 'Napa Valley'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(2);
      const sequence = relaxedAttributeSequence(ladder);
      // region comes before vintage in the priority order
      expect(sequence[0]).toEqual(['region']);
      expect(sequence[1]).toEqual(['region', 'vintage']);
    });

    it('handles alcohol_pct in the priority chain', () => {
      const bundle = makeBundle([
        makeConstraint('alcohol_pct'),
        makeConstraint('grape_primary', 'Pinot Noir'),
        makeConstraint('appellation', 'Willamette Valley'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(3);
      const sequence = relaxedAttributeSequence(ladder);
      expect(sequence[0]).toEqual(['appellation']);
      expect(sequence[1]).toEqual(['appellation', 'alcohol_pct']);
      expect(sequence[2]).toEqual(['appellation', 'alcohol_pct', 'grape_primary']);
    });

    it('places alcohol alias after vintage in priority', () => {
      const bundle = makeBundle([
        makeConstraint('alcohol'),
        makeConstraint('vintage_year', '2019'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(2);
      const sequence = relaxedAttributeSequence(ladder);
      expect(sequence[0]).toEqual(['vintage_year']);
      expect(sequence[1]).toEqual(['vintage_year', 'alcohol']);
    });
  });

  describe('floor attributes (never relaxed)', () => {
    it('never relaxes wine_type', () => {
      const bundle = makeBundle([
        makeConstraint('wine_type', 'red'),
        makeConstraint('region', 'Burgundy'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(1);
      // wine_type stays in hard constraints at every step
      expect(ladder[0]!.constraints.hard).toHaveLength(1);
      expect(ladder[0]!.constraints.hard[0]!.attribute).toBe('wine_type');
      expect(ladder[0]!.relaxedAttributes).toEqual(['region']);
    });

    it('never relaxes color', () => {
      const bundle = makeBundle([
        makeConstraint('color', 'white'),
        makeConstraint('country', 'Italy'),
        makeConstraint('grape_primary', 'Trebbiano'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      // color stays, country and grape_primary are relaxed
      for (const step of ladder) {
        const hardAttributes = step.constraints.hard.map((c) => c.attribute);
        expect(hardAttributes).toContain('color');
        expect(step.relaxedAttributes).not.toContain('color');
      }
    });

    it('never relaxes classification', () => {
      const bundle = makeBundle([
        makeConstraint('classification', 'Grand Cru'),
        makeConstraint('appellation', 'Gevrey-Chambertin'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.constraints.hard).toHaveLength(1);
      expect(ladder[0]!.constraints.hard[0]!.attribute).toBe('classification');
      expect(ladder[0]!.relaxedAttributes).toEqual(['appellation']);
    });

    it('returns empty ladder when all hard constraints are floor attributes', () => {
      const bundle = makeBundle([
        makeConstraint('wine_type', 'sparkling'),
        makeConstraint('color', 'rosé'),
        makeConstraint('classification', 'Brut'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty ladder when hard constraints are empty', () => {
      const bundle = makeBundle([]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(0);
    });

    it('returns empty ladder when hard constraints contain only floor attributes', () => {
      const bundle = makeBundle([
        makeConstraint('wine_type', 'red'),
        makeConstraint('classification', 'DOC'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(0);
    });

    it('deduplicates multiple constraints on the same attribute', () => {
      // vintage_year >= 2018 AND vintage_year <= 2022
      const bundle = makeBundle([
        { attribute: 'vintage_year', operator: '>=', value: 2018, source_phrase: 'after 2018', confidence: 0.9 },
        { attribute: 'vintage_year', operator: '<=', value: 2022, source_phrase: 'before 2022', confidence: 0.9 },
        makeConstraint('region', 'Tuscany'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      // Should have 2 steps: remove region first, then vintage_year (both constraints)
      expect(ladder).toHaveLength(2);
      const sequence = relaxedAttributeSequence(ladder);
      expect(sequence[0]).toEqual(['region']);
      expect(sequence[1]).toEqual(['region', 'vintage_year']);

      // After removing vintage_year, both >= and <= constraints should be gone
      const finalStep = ladder[1]!;
      const vintageConstraints = finalStep.constraints.hard.filter((c) => c.attribute === 'vintage_year');
      expect(vintageConstraints).toHaveLength(0);
    });

    it('preserves soft constraints across all relaxation steps', () => {
      const softConstraint = makeConstraint('price', '50');
      const bundle = makeBundle(
        [makeConstraint('region', 'Rioja'), makeConstraint('grape_primary', 'Tempranillo')],
        [softConstraint],
      );

      const ladder = buildRelaxationLadder(bundle);

      for (const step of ladder) {
        expect(step.constraints.soft).toHaveLength(1);
        expect(step.constraints.soft[0]!.attribute).toBe('price');
      }
    });

    it('filters inferred constraints when their attribute is relaxed from hard', () => {
      const bundle = makeBundle(
        [makeConstraint('appellation', 'Margaux')],
        [],
        [makeConstraint('appellation', 'inferred-Margaux')],
      );

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(1);
      // Inferred appellation should also be removed when appellation is relaxed
      expect(ladder[0]!.constraints.inferred).toHaveLength(0);
    });

    it('handles attributes not in the priority list (appended last)', () => {
      const bundle = makeBundle([
        makeConstraint('producer_name', 'Chateau Margaux'),
        makeConstraint('region', 'Bordeaux'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(2);
      const sequence = relaxedAttributeSequence(ladder);
      // region is in the priority list, producer_name is not — region first
      expect(sequence[0]).toEqual(['region']);
      expect(sequence[1]).toEqual(['region', 'producer_name']);
    });

    it('single relaxable constraint produces a single-step ladder', () => {
      const bundle = makeBundle([
        makeConstraint('wine_type', 'red'),
        makeConstraint('region', 'Barossa Valley'),
      ]);

      const ladder = buildRelaxationLadder(bundle);

      expect(ladder).toHaveLength(1);
      expect(ladder[0]!.relaxedAttributes).toEqual(['region']);
      // wine_type (floor) remains
      expect(ladder[0]!.constraints.hard).toHaveLength(1);
      expect(ladder[0]!.constraints.hard[0]!.attribute).toBe('wine_type');
    });
  });
});

// ─── relaxOneStep ───────────────────────────────────────────────────────────────

describe('relaxOneStep', () => {
  it('returns the first step of the ladder', () => {
    const bundle = makeBundle([
      makeConstraint('appellation', 'Pauillac'),
      makeConstraint('region', 'Bordeaux'),
      makeConstraint('grape_primary', 'Cabernet Sauvignon'),
    ]);

    const step = relaxOneStep(bundle);

    expect(step).toBeDefined();
    expect(step!.relaxedAttributes).toEqual(['appellation']);
  });

  it('returns undefined when no relaxation is possible', () => {
    const bundle = makeBundle([
      makeConstraint('wine_type', 'white'),
    ]);

    const step = relaxOneStep(bundle);

    expect(step).toBeUndefined();
  });

  it('returns undefined for empty hard constraints', () => {
    const bundle = makeBundle([]);

    const step = relaxOneStep(bundle);

    expect(step).toBeUndefined();
  });
});

// ─── Relaxed constraint plan shape ──────────────────────────────────────────────

describe('RelaxedConstraintPlan shape', () => {
  it('each step has valid constraint bundle structure', () => {
    const bundle = makeBundle([
      makeConstraint('appellation', 'Pommard'),
      makeConstraint('region', 'Burgundy'),
      makeConstraint('vintage_year', '2019'),
      makeConstraint('wine_type', 'red'),
    ]);

    const ladder = buildRelaxationLadder(bundle);

    for (const step of ladder) {
      expect(step.constraints).toHaveProperty('hard');
      expect(step.constraints).toHaveProperty('soft');
      expect(step.constraints).toHaveProperty('inferred');
      expect(Array.isArray(step.constraints.hard)).toBe(true);
      expect(Array.isArray(step.constraints.soft)).toBe(true);
      expect(Array.isArray(step.constraints.inferred)).toBe(true);
      expect(step.relaxedAttributes.length).toBeGreaterThan(0);
    }
  });

  it('ladder steps are cumulative — each step includes all previously relaxed attributes', () => {
    const bundle = makeBundle([
      makeConstraint('appellation', 'Saint-Julien'),
      makeConstraint('region', 'Bordeaux'),
      makeConstraint('country', 'France'),
    ]);

    const ladder = buildRelaxationLadder(bundle);

    expect(ladder).toHaveLength(3);
    // Each step includes all previous relaxed attributes
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1]!.relaxedAttributes;
      const curr = ladder[i]!.relaxedAttributes;
      // Current step should include all attributes from the previous step
      for (const attr of prev) {
        expect(curr).toContain(attr);
      }
      // Current step should have one more relaxed attribute than previous
      expect(curr.length).toBe(prev.length + 1);
    }
  });

  it('last ladder step has only floor attributes remaining in hard', () => {
    const bundle = makeBundle([
      makeConstraint('wine_type', 'red'),
      makeConstraint('appellation', 'Pauillac'),
      makeConstraint('region', 'Bordeaux'),
      makeConstraint('grape_primary', 'Merlot'),
    ]);

    const ladder = buildRelaxationLadder(bundle);

    const lastStep = ladder[ladder.length - 1]!;
    // Only floor attributes should remain
    for (const c of lastStep.constraints.hard) {
      expect(['wine_type', 'color', 'classification']).toContain(c.attribute);
    }
    expect(lastStep.constraints.hard).toHaveLength(1);
    expect(lastStep.constraints.hard[0]!.attribute).toBe('wine_type');
  });

  it('hard constraint count decreases at each step', () => {
    const bundle = makeBundle([
      makeConstraint('appellation', 'Barolo'),
      makeConstraint('region', 'Piedmont'),
      makeConstraint('country', 'Italy'),
      makeConstraint('vintage_year', '2017'),
    ]);

    const ladder = buildRelaxationLadder(bundle);

    let prevHardCount = bundle.hard.length;
    for (const step of ladder) {
      expect(step.constraints.hard.length).toBeLessThan(prevHardCount);
      prevHardCount = step.constraints.hard.length;
    }
  });
});

// ─── Full geography chain relaxation ────────────────────────────────────────────

describe('full geography chain relaxation', () => {
  it('relaxes appellation → region → country in correct geographic narrowing order', () => {
    const bundle = makeBundle([
      makeConstraint('country', 'France'),
      makeConstraint('region', 'Burgundy'),
      makeConstraint('appellation', 'Chambolle-Musigny'),
    ]);

    const ladder = buildRelaxationLadder(bundle);

    expect(ladder).toHaveLength(3);
    // Step 1: remove most specific — appellation
    expect(ladder[0]!.relaxedAttributes).toEqual(['appellation']);
    expect(ladder[0]!.constraints.hard.map((c) => c.attribute).sort()).toEqual(['country', 'region']);

    // Step 2: remove region
    expect(ladder[1]!.relaxedAttributes).toEqual(['appellation', 'region']);
    expect(ladder[1]!.constraints.hard.map((c) => c.attribute)).toEqual(['country']);

    // Step 3: remove country
    expect(ladder[2]!.relaxedAttributes).toEqual(['appellation', 'region', 'country']);
    expect(ladder[2]!.constraints.hard).toHaveLength(0);
  });
});
