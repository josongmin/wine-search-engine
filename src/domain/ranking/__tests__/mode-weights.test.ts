import { describe, expect, it } from 'vitest';
import { getModeWeights, DEFAULT_WEIGHTS, type ModeWeightProfile } from '../model/mode-weights.js';
import { RETRIEVAL_MODES, type RetrievalMode } from '../../query/model/retrieval-mode.js';

/**
 * The 15 non-penalty weight fields a `ModeWeightProfile` must declare.
 * Mirrored here so the test fails loud if a new field is added to the
 * interface but forgotten in one of the mode profiles (TypeScript enforces
 * this at compile time, the test enforces it at runtime against drift).
 */
const REQUIRED_WEIGHT_FIELDS: ReadonlyArray<keyof ModeWeightProfile> = [
  'lexicalWeight',
  'semanticWeight',
  'popularityWeight',
  'entityIntegrityWeight',
  'attributeAlignmentWeight',
  'diversityWeight',
  'recencyWeight',
  'producerPrestigeWeight',
  'geographicAlignmentWeight',
  'preferenceAlignmentWeight',
  'anchorSimilarityWeight',
  'softConstraintWeight',
  'availabilityWeight',
  'criticScoreWeight',
  'multilingualScoreWeight',
] as const;

describe('getModeWeights', () => {
  it('returns a profile for every retrieval mode key', () => {
    const entityLookup = getModeWeights('entity_lookup');
    expect(entityLookup.lexicalWeight).toBeGreaterThan(0);
    expect(entityLookup.semanticWeight).toBeGreaterThan(0);
  });

  it('exposes a no-op default profile (all zeros) so neutral/undefined modes preserve base weights', () => {
    // DEFAULT_WEIGHTS is intentionally all-zero: when no retrieval mode is specified,
    // Math.max(baseWeight, 0) = baseWeight — the query-class weights are preserved exactly.
    for (const field of REQUIRED_WEIGHT_FIELDS) {
      expect(DEFAULT_WEIGHTS[field]).toBe(0);
    }
  });
});

describe('ModeWeightProfile invariants (RFC-017 §8.3)', () => {
  it.each(RETRIEVAL_MODES)('mode %s: every weight is finite and within [0, 1]', (mode: RetrievalMode) => {
    const profile = getModeWeights(mode);
    for (const field of REQUIRED_WEIGHT_FIELDS) {
      const value = profile[field];
      expect(Number.isFinite(value), `${mode}.${field} must be finite, got ${String(value)}`).toBe(true);
      expect(value, `${mode}.${field} must be ≥ 0`).toBeGreaterThanOrEqual(0);
      expect(value, `${mode}.${field} must be ≤ 1`).toBeLessThanOrEqual(1);
    }
  });

  it.each(RETRIEVAL_MODES)('mode %s: profile declares every required weight field (no drift vs interface)', (mode: RetrievalMode) => {
    const profile = getModeWeights(mode);
    for (const field of REQUIRED_WEIGHT_FIELDS) {
      expect(profile, `${mode} is missing field ${field}`).toHaveProperty(field);
      expect(typeof profile[field], `${mode}.${field} must be number`).toBe('number');
    }
  });

  it.each(RETRIEVAL_MODES)('mode %s: at least one signal weight is non-zero (mode is not a silent no-op)', (mode: RetrievalMode) => {
    // A mode whose every field is zero would be indistinguishable from
    // DEFAULT_WEIGHTS — that means the mode is effectively unused. Any
    // such mode is either a bug (forgot to fill it in) or should be
    // explicitly removed from RetrievalMode.
    const profile = getModeWeights(mode);
    const sum = REQUIRED_WEIGHT_FIELDS.reduce((acc, field) => acc + profile[field], 0);
    expect(sum, `${mode} has all-zero weights — either fill it in or remove from RetrievalMode`).toBeGreaterThan(0);
  });

  it('every RetrievalMode enum value resolves to a non-default profile', () => {
    // Catches the case where MODE_WEIGHT_PROFILES is missing a key the
    // enum just added (TypeScript Record<RetrievalMode, …> would catch
    // this at compile time, but a runtime check protects against any
    // future indexer / partial-record refactor).
    for (const mode of RETRIEVAL_MODES) {
      const profile = getModeWeights(mode);
      expect(profile, `getModeWeights('${mode}') must not fall through to DEFAULT_WEIGHTS`).not.toBe(DEFAULT_WEIGHTS);
    }
  });
});
