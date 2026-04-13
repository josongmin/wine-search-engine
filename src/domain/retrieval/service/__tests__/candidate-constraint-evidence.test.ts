/**
 * Tests for candidate-constraint-evidence.ts
 *
 * Covers:
 *   - Geography substring matching (Fix 1): "Bordeaux AOC" satisfies constraint "Bordeaux"
 *   - Soft-gate annotation: unmetHardConstraints correctly populated
 *   - Unknown attribute: returns undefined → treated as unmet
 *   - Negative geography operators retain exact semantics
 *   - Drinking window special case
 */

import { describe, it, expect } from 'vitest';
import {
  annotateCandidateConstraintEvidence,
  annotateCandidateConstraintEvidenceBatch,
} from '../candidate-constraint-evidence.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../../shared/types/index.js';
import type { CanonicalEntityId } from '../../../shared/types/index.js';

// Minimal HybridCandidate factory — only sets the fields under test.
function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: 'wine-001' as CanonicalEntityId,
    matchedConstraints: [],
    retrievalFusionScore: 0.5,
    // geography
    country: undefined,
    region: undefined,
    appellation: undefined,
    // type
    wineType: undefined,
    style: undefined,
    // variety
    grapePrimary: undefined,
    grapes: undefined,
    // numeric
    vintageYear: undefined,
    priceUsd: undefined,
    alcoholPct: undefined,
    criticScoreNormalized: undefined,
    producerPrestige: undefined,
    body: undefined,
    sweetness: undefined,
    acidity: undefined,
    tannin: undefined,
    finishLength: undefined,
    // other
    priceBand: undefined,
    pairing: undefined,
    occasion: undefined,
    classification: undefined,
    certifications: undefined,
    soilType: undefined,
    producerType: undefined,
    drinkingWindowStart: undefined,
    drinkingWindowEnd: undefined,
    ...overrides,
  } as unknown as HybridCandidate;
}

function makeConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return { attribute, operator, value, source_phrase: attribute, confidence: 0.9 };
}

function makeBundle(
  hard: NormalizedConstraint[] = [],
  soft: NormalizedConstraint[] = [],
): ConstraintBundle {
  return { hard, soft, inferred: [] };
}

// ──────────────────────────────────────────────────────────────────────────────
// Fix 1: Geography substring matching
// ──────────────────────────────────────────────────────────────────────────────

describe('geography constraint — substring matching (Fix 1)', () => {
  it('region "Bordeaux AOC" satisfies constraint "Bordeaux" (= operator)', () => {
    const candidate = makeCandidate({ region: 'Bordeaux AOC' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Bordeaux')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
    expect(result.unmetHardConstraints ?? []).not.toContain('region');
  });

  it('country "South France" satisfies constraint "France" (= operator)', () => {
    const candidate = makeCandidate({ country: 'South France' });
    const bundle = makeBundle([makeConstraint('country', '=', 'France')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('country');
  });

  it('appellation "Pauillac AOC" satisfies constraint "Pauillac" (= operator)', () => {
    const candidate = makeCandidate({ appellation: 'Pauillac AOC' });
    const bundle = makeBundle([makeConstraint('appellation', '=', 'Pauillac')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('appellation');
  });

  it('exact match still works: "Bordeaux" satisfies constraint "Bordeaux"', () => {
    const candidate = makeCandidate({ region: 'Bordeaux' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Bordeaux')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
  });

  it('region "Tuscany" does NOT satisfy constraint "Bordeaux"', () => {
    const candidate = makeCandidate({ region: 'Tuscany' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Bordeaux')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).not.toContain('region');
    expect(result.unmetHardConstraints).toContain('region');
  });

  it('geography "in" operator: "Napa Valley AVA" satisfies in:["Napa"]', () => {
    const candidate = makeCandidate({ region: 'Napa Valley AVA' });
    const bundle = makeBundle([makeConstraint('region', 'in', ['Napa', 'Sonoma'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
  });

  // Negative operators must NOT relax — broad exclusions must be precise.
  it('geography exclude: "South France" is excluded by exclude:"France" (still excluded)', () => {
    const candidate = makeCandidate({ country: 'South France' });
    const bundle = makeBundle([makeConstraint('country', 'exclude', 'France')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    // "South France" contains "france" → exclude constraint is NOT satisfied
    // (user said "not France" → South France should be excluded)
    expect(result.matchedConstraints).not.toContain('country');
    expect(result.unmetHardConstraints).toContain('country');
  });

  it('geography not_in: "Italy" NOT excluded by not_in:["France"]', () => {
    const candidate = makeCandidate({ country: 'Italy' });
    const bundle = makeBundle([makeConstraint('country', 'not_in', ['France'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('country');
  });

  it('geography not_in: "France" IS excluded by not_in:["France"]', () => {
    const candidate = makeCandidate({ country: 'France' });
    const bundle = makeBundle([makeConstraint('country', 'not_in', ['France'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).not.toContain('country');
    expect(result.unmetHardConstraints).toContain('country');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// unmetHardConstraints annotation
// ──────────────────────────────────────────────────────────────────────────────

describe('unmetHardConstraints annotation', () => {
  it('sets unmetHardConstraints when hard constraint is not satisfied', () => {
    const candidate = makeCandidate({ wineType: 'white' });
    const bundle = makeBundle([makeConstraint('wine_type', '=', 'red')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('wine_type');
  });

  it('clears unmetHardConstraints when all hard constraints are satisfied', () => {
    const candidate = makeCandidate({ wineType: 'red', country: 'France' });
    const bundle = makeBundle([
      makeConstraint('wine_type', '=', 'red'),
      makeConstraint('country', '=', 'France'),
    ]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toBeUndefined();
    expect(result.matchedConstraints).toContain('wine_type');
    expect(result.matchedConstraints).toContain('country');
  });

  it('accumulates multiple unmet attributes', () => {
    const candidate = makeCandidate({ wineType: 'white', region: 'Tuscany' });
    const bundle = makeBundle([
      makeConstraint('wine_type', '=', 'red'),
      makeConstraint('region', '=', 'Bordeaux'),
    ]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('wine_type');
    expect(result.unmetHardConstraints).toContain('region');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unknown attribute silent-drop guard (Fix 4)
// ──────────────────────────────────────────────────────────────────────────────

describe('unknown attribute — silent-drop guard (Fix 4)', () => {
  it('unknown hard attribute throws instead of silently evicting every candidate', () => {
    const candidate = makeCandidate();
    const bundle = makeBundle([makeConstraint('nonexistent_future_attr', '=', 'foo')]);
    expect(() => annotateCandidateConstraintEvidence(candidate, bundle)).toThrow(
      /Unknown constraint attribute/,
    );
  });

  it('unknown soft attribute also throws so contract drift is surfaced immediately', () => {
    const candidate = makeCandidate();
    const bundle = makeBundle([], [makeConstraint('nonexistent_soft_attr', '=', 'bar')]);
    expect(() => annotateCandidateConstraintEvidence(candidate, bundle)).toThrow(
      /Unknown constraint attribute/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Drinking window special case
// ──────────────────────────────────────────────────────────────────────────────

describe('drinking_window special case', () => {
  it('satisfies when current year is within window', () => {
    const candidate = makeCandidate({ drinkingWindowStart: 2020, drinkingWindowEnd: 2030 });
    const bundle = makeBundle([makeConstraint('drinking_window', '=', 2025)]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('drinking_window');
  });

  it('does not satisfy when current year is outside window', () => {
    const candidate = makeCandidate({ drinkingWindowStart: 2025, drinkingWindowEnd: 2030 });
    const bundle = makeBundle([makeConstraint('drinking_window', '=', 2020)]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('drinking_window');
  });

  it('does not satisfy when drinking window is undefined', () => {
    const candidate = makeCandidate({ drinkingWindowStart: undefined, drinkingWindowEnd: undefined });
    const bundle = makeBundle([makeConstraint('drinking_window', '=', 2025)]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('drinking_window');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NFD accent normalization (Rule 5 — Fix P0-A)
// ──────────────────────────────────────────────────────────────────────────────

describe('NFD accent normalization (Fix P0-A)', () => {
  it('Côtes du Rhône satisfies constraint "Cotes du Rhone" (accent folding)', () => {
    const candidate = makeCandidate({ region: 'Côtes du Rhône' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Cotes du Rhone')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
    expect(result.unmetHardConstraints ?? []).not.toContain('region');
  });

  it('Côtes du Rhône satisfies constraint "Côtes du Rhône" (both accented)', () => {
    const candidate = makeCandidate({ region: 'Côtes du Rhône' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Côtes du Rhône')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
  });

  it('Alsace satisfies accented constraint "Alsàce" (accent folding, substring)', () => {
    const candidate = makeCandidate({ region: 'Alsàce AOC' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Alsace')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('region');
  });

  it('non-geography accent: wineType "Rosé" satisfies constraint "rose" after folding', () => {
    const candidate = makeCandidate({ wineType: 'rosé' });
    const bundle = makeBundle([makeConstraint('wine_type', '=', 'rose')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('wine_type');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// exclude operator — array constraintValue (Fix P0-B)
// ──────────────────────────────────────────────────────────────────────────────

describe('exclude operator — array constraintValue (Fix P0-B)', () => {
  it('non-geography exclude with array: wine_type "red" excluded by exclude:["red","white"]', () => {
    const candidate = makeCandidate({ wineType: 'red' });
    const bundle = makeBundle([makeConstraint('wine_type', 'exclude', ['red', 'white'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).not.toContain('wine_type');
    expect(result.unmetHardConstraints).toContain('wine_type');
  });

  it('non-geography exclude with array: wine_type "sparkling" passes exclude:["red","white"]', () => {
    const candidate = makeCandidate({ wineType: 'sparkling' });
    const bundle = makeBundle([makeConstraint('wine_type', 'exclude', ['red', 'white'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('wine_type');
    expect(result.unmetHardConstraints ?? []).not.toContain('wine_type');
  });

  it('non-geography exclude with scalar: wine_type "red" excluded by exclude:"red"', () => {
    const candidate = makeCandidate({ wineType: 'red' });
    const bundle = makeBundle([makeConstraint('wine_type', 'exclude', 'red')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).not.toContain('wine_type');
    expect(result.unmetHardConstraints).toContain('wine_type');
  });

  it('certifications (array field) exclude: all elements must not match excluded value', () => {
    const candidate = makeCandidate({ certifications: ['organic', 'biodynamic'] });
    const bundle = makeBundle([makeConstraint('certification', 'exclude', 'organic')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    // candidate has "organic" → constraint unmet
    expect(result.unmetHardConstraints).toContain('certification');
  });

  it('certifications (array field) exclude: passes when no element matches', () => {
    const candidate = makeCandidate({ certifications: ['biodynamic'] });
    const bundle = makeBundle([makeConstraint('certification', 'exclude', 'organic')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('certification');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Batch annotation
// ──────────────────────────────────────────────────────────────────────────────

describe('grape_primary annotation — blend coverage (BUG-B regression)', () => {
  // BUG-B: retrieval uses grape_or filter (grape_primary OR grapes[]).
  // Annotation must check BOTH fields so blend wines are not falsely excluded.

  it('satisfies grape_primary constraint when value is in grapes[] even if grapePrimary differs', () => {
    // Blend wine: primary=Merlot but Cabernet is in grapes[]
    const candidate = makeCandidate({ grapePrimary: 'Merlot', grapes: ['Cabernet Sauvignon', 'Merlot'] });
    const bundle = makeBundle([makeConstraint('grape_primary', '=', 'Cabernet Sauvignon')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_primary');
    expect(result.unmetHardConstraints ?? []).not.toContain('grape_primary');
  });

  it('satisfies grape_primary constraint when value matches grapePrimary directly', () => {
    const candidate = makeCandidate({ grapePrimary: 'Pinot Noir', grapes: [] });
    const bundle = makeBundle([makeConstraint('grape_primary', '=', 'Pinot Noir')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_primary');
  });

  it('does NOT satisfy grape_primary constraint when value absent from both fields', () => {
    const candidate = makeCandidate({ grapePrimary: 'Merlot', grapes: ['Merlot'] });
    const bundle = makeBundle([makeConstraint('grape_primary', '=', 'Riesling')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('grape_primary');
  });

  it('satisfies grape_primary in operator when any grapes[] element matches', () => {
    const candidate = makeCandidate({ grapePrimary: 'Merlot', grapes: ['Cabernet Franc', 'Petit Verdot'] });
    const bundle = makeBundle([makeConstraint('grape_primary', 'in', ['Cabernet Franc', 'Syrah'])]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_primary');
  });

  it('handles undefined grapePrimary — falls back to grapes[] only', () => {
    const candidate = makeCandidate({ grapePrimary: undefined, grapes: ['Grenache', 'Syrah'] });
    const bundle = makeBundle([makeConstraint('grape_primary', '=', 'Grenache')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_primary');
  });

  it('handles undefined grapePrimary AND empty grapes[] — returns unmet', () => {
    const candidate = makeCandidate({ grapePrimary: undefined, grapes: [] });
    const bundle = makeBundle([makeConstraint('grape_primary', '=', 'Grenache')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('grape_primary');
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('annotateCandidateConstraintEvidenceBatch', () => {
  it('no-ops when all constraint lists are empty', () => {
    const candidates = [makeCandidate(), makeCandidate({ entityId: 'wine-002' as CanonicalEntityId })];
    const result = annotateCandidateConstraintEvidenceBatch(candidates, { hard: [], soft: [], inferred: [] });
    expect(result).toBe(candidates); // same reference — no work done
  });

  it('annotates all candidates in the batch', () => {
    const c1 = makeCandidate({ region: 'Bordeaux AOC' });
    const c2 = makeCandidate({ region: 'Tuscany' });
    const bundle = makeBundle([makeConstraint('region', '=', 'Bordeaux')]);
    const result = annotateCandidateConstraintEvidenceBatch([c1, c2], bundle);
    expect(result[0]?.matchedConstraints).toContain('region');
    expect(result[1]?.unmetHardConstraints).toContain('region');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Round 4: grape_family attribute support
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveCandidateValue — grape_family', () => {
  it('grape_family = value → matched when candidate grapeFamily matches', () => {
    const candidate = makeCandidate({ grapeFamily: 'Cabernet' } as Partial<HybridCandidate>);
    const bundle = makeBundle([makeConstraint('grape_family', '=', 'Cabernet')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_family');
    expect(result.unmetHardConstraints ?? []).not.toContain('grape_family');
  });

  it('grape_family = value → unmet when candidate grapeFamily does not match', () => {
    const candidate = makeCandidate({ grapeFamily: 'Merlot' } as Partial<HybridCandidate>);
    const bundle = makeBundle([makeConstraint('grape_family', '=', 'Cabernet')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('grape_family');
  });

  it('grape_family = value → unmet when candidate grapeFamily is undefined (regression: default case returned undefined)', () => {
    const candidate = makeCandidate();
    const bundle = makeBundle([makeConstraint('grape_family', '=', 'Cabernet')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints).toContain('grape_family');
  });

  it('grape_family soft inferred constraint → candidate with matching grapeFamily has it in matchedConstraints', () => {
    // Compositional inference (Bordeaux → grape_family: in ['Cabernet', 'Merlot']) produces
    // an inferred constraint. Verify the attribute resolves correctly.
    const candidate = makeCandidate({ grapeFamily: 'Merlot' } as Partial<HybridCandidate>);
    const bundle: ConstraintBundle = {
      hard: [],
      soft: [],
      inferred: [makeConstraint('grape_family', 'in', ['Cabernet', 'Merlot'])],
    };
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.matchedConstraints).toContain('grape_family');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bug 2 regression: fruit_intensity soft constraint must not penalise all results
//
// fruit_intensity has no backing field in HybridCandidate. Previously it was
// counted in totalWeight (ranker's computeSoftConstraint) but never in
// weightedSum — lowering the soft score for EVERY result even when they would
// otherwise be perfect matches. The fix: soft constraints with no backing field
// are treated as "not evaluable" and added to matchedConstraints so the ranker
// does not apply a weight deficit.
// ──────────────────────────────────────────────────────────────────────────────

describe('fruit_intensity soft constraint — no-backing-field exemption (Bug 2 regression)', () => {
  it('fruit_intensity soft constraint adds attribute to matchedConstraints (not-evaluable exemption)', () => {
    // No fruitIntensity field on HybridCandidate → resolveCandidateValue returns undefined.
    // The exemption should add it to matched so the ranker does not see it as unmet.
    const candidate = makeCandidate();
    const bundle = makeBundle([], [makeConstraint('fruit_intensity', '=', 'high')]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    // Must be in matchedConstraints (exempted), NOT absent (which causes weight deficit).
    expect(result.matchedConstraints).toContain('fruit_intensity');
    // Must NOT appear in unmetHardConstraints (it's a soft constraint).
    expect(result.unmetHardConstraints ?? []).not.toContain('fruit_intensity');
  });

  it('fruit_intensity soft constraint does not affect unmetHardConstraints', () => {
    // Hard constraints are intentionally NOT given the no-backing-field exemption.
    // fruit_intensity is always in SOFT — but confirm a soft constraint on it
    // never bleeds into unmetHardConstraints.
    const candidate = makeCandidate({ wineType: 'red' });
    const bundle = makeBundle(
      [makeConstraint('wine_type', '=', 'red')],
      [makeConstraint('fruit_intensity', '=', 'low')],
    );
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    expect(result.unmetHardConstraints ?? []).not.toContain('fruit_intensity');
    expect(result.matchedConstraints).toContain('wine_type');
    expect(result.matchedConstraints).toContain('fruit_intensity');
  });

  it('other soft constraints with backing fields still evaluate normally (regression guard)', () => {
    // The exemption must only apply to attributes with no backing field.
    // body/sweetness/acidity all have backing fields — they must still be evaluated correctly.
    const candidate = makeCandidate({ body: 3, sweetness: 1 });
    const bundle = makeBundle([], [
      makeConstraint('body', '=', 3),    // matches
      makeConstraint('sweetness', '=', 5), // does NOT match (1 ≠ 5)
    ]);
    const result = annotateCandidateConstraintEvidence(candidate, bundle);
    // body matches → in matchedConstraints
    expect(result.matchedConstraints).toContain('body');
    // sweetness does NOT match and IS resolvable → NOT in matchedConstraints
    expect(result.matchedConstraints).not.toContain('sweetness');
  });
});
