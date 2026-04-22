/**
 * Regression: Geography substring annotation — fixed in wave 1 (2026-04-10).
 *
 * Root cause: annotation layer used exact `=` comparison for geography attributes
 * (country, region, appellation) while Vespa uses `contains` (substring) semantics.
 * This caused false `unmetHardConstraints` for any candidate whose field contained
 * extra text (e.g. "Bordeaux AOC" ≠ "Bordeaux"), evicting valid results before ranking.
 *
 * Fix: `satisfiesConstraint()` in candidate-constraint-evidence.ts now mirrors Vespa
 * substring semantics for positive operators ('=', 'in') on geography attributes.
 * Negative operators ('exclude', 'not_in') retain exact matching.
 *
 * Also covers NFD accent normalization (Fix P0-A):
 * "Côtes du Rhône" must match "Cotes du Rhone" — consistent with Vespa's
 * `accent-removal: true` index setting.
 *
 * DO NOT DELETE — append-only regression file.
 */

import { describe, it, expect } from 'vitest';
import {
  annotateCandidateConstraintEvidence,
} from '../../src/domain/retrieval/service/candidate-constraint-evidence.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import {
  createEntityId,
  type ConstraintBundle,
  type NormalizedConstraint,
} from '../../src/domain/shared/types/index.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return makeHybridCandidate({
    entityId: createEntityId('regression-001'),
    fusionRrfTotal: 0.5,
    ...overrides,
  });
}

function hardBundle(attribute: string, operator: NormalizedConstraint['operator'], value: NormalizedConstraint['value']): ConstraintBundle {
  return {
    hard: [{ attribute, operator, value, source_phrase: attribute, confidence: 0.9 }],
    soft: [],
    inferred: [],
  };
}

describe('Regression: geography substring annotation (Fix 2026-04-10)', () => {
  // ── Exact match still works ──────────────────────────────────────────────

  it('region "Bordeaux" satisfies constraint "Bordeaux" (exact, no regression)', () => {
    const c = makeCandidate({ region: 'Bordeaux' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('region', '=', 'Bordeaux'));
    expect(r.unmetHardConstraints ?? []).not.toContain('region');
  });

  // ── Substring match that was broken before fix ───────────────────────────

  it('[REGRESSION] region "Bordeaux AOC" was falsely rejected for constraint "Bordeaux"', () => {
    const c = makeCandidate({ region: 'Bordeaux AOC' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('region', '=', 'Bordeaux'));
    // Before fix: this returned unmetHardConstraints: ['region'] — candidate evicted
    expect(r.unmetHardConstraints ?? []).not.toContain('region');
    expect(r.matchedConstraints).toContain('region');
  });

  it('[REGRESSION] country "South France" was falsely rejected for constraint "France"', () => {
    const c = makeCandidate({ country: 'South France' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('country', '=', 'France'));
    expect(r.unmetHardConstraints ?? []).not.toContain('country');
  });

  it('[REGRESSION] appellation "Margaux AOC" was falsely rejected for constraint "Margaux"', () => {
    const c = makeCandidate({ appellation: 'Margaux AOC' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('appellation', '=', 'Margaux'));
    expect(r.unmetHardConstraints ?? []).not.toContain('appellation');
  });

  it('[REGRESSION] region "Napa Valley AVA" satisfies in:["Napa","Sonoma"]', () => {
    const c = makeCandidate({ region: 'Napa Valley AVA' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('region', 'in', ['Napa', 'Sonoma']));
    expect(r.unmetHardConstraints ?? []).not.toContain('region');
  });

  // ── Negative operators must remain strict ───────────────────────────────

  it('geography exclude: "South France" correctly excluded by exclude:"France"', () => {
    const c = makeCandidate({ country: 'South France' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('country', 'exclude', 'France'));
    // Negative operator: "South France" contains "france" → excluded = unmet
    expect(r.unmetHardConstraints ?? []).toContain('country');
  });

  it('geography not_in: "Italy" NOT excluded by not_in:["France"]', () => {
    const c = makeCandidate({ country: 'Italy' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('country', 'not_in', ['France']));
    expect(r.unmetHardConstraints ?? []).not.toContain('country');
  });

  // ── NFD accent normalization ─────────────────────────────────────────────

  it('[REGRESSION] "Côtes du Rhône" was falsely rejected for constraint "Cotes du Rhone"', () => {
    const c = makeCandidate({ region: 'Côtes du Rhône' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('region', '=', 'Cotes du Rhone'));
    // Before Fix P0-A: NFD folding was missing; accented ≠ unaccented → false rejection
    expect(r.unmetHardConstraints ?? []).not.toContain('region');
    expect(r.matchedConstraints).toContain('region');
  });

  it('[REGRESSION] "Alsàce AOC" satisfies constraint "Alsace" (substring + NFD)', () => {
    const c = makeCandidate({ region: 'Alsàce AOC' });
    const r = annotateCandidateConstraintEvidence(c, hardBundle('region', '=', 'Alsace'));
    expect(r.unmetHardConstraints ?? []).not.toContain('region');
  });
});
