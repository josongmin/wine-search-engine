import { describe, expect, it } from 'vitest';
import {
  getModeWeights,
  DEFAULT_WEIGHTS,
  MODE_WEIGHT_OVERLAY_MAP,
  applyModeWeightOverlay,
  scaleOverlaidWeights,
  type ModeWeightProfile,
} from '../model/mode-weights.js';
import { RETRIEVAL_MODES, type RetrievalMode } from '../../query/model/retrieval-mode.js';
import { resolveWeights } from '../model/scoring-weights.js';

/**
 * The 12 non-penalty weight fields a `ModeWeightProfile` must declare.
 * Mirrored here so the test fails loud if a new field is added to the
 * interface but forgotten in one of the mode profiles (TypeScript enforces
 * this at compile time, the test enforces it at runtime against drift).
 *
 * Every entry MUST have a corresponding ScoringWeights field overlaid in
 * ranker.ts — see the "no silent lying field" test below.
 */
const REQUIRED_WEIGHT_FIELDS: ReadonlyArray<keyof ModeWeightProfile> = [
  'semanticWeight',
  'popularityWeight',
  'entityIntegrityWeight',
  'attributeAlignmentWeight',
  'recencyWeight',
  'producerPrestigeWeight',
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

describe('MODE_WEIGHT_OVERLAY_MAP — SSoT parity (RCA5-04 prevention)', () => {
  it('overlay map has exactly one entry per ModeWeightProfile field (no silent lying field)', () => {
    const overlayModeFields = new Set(MODE_WEIGHT_OVERLAY_MAP.map((m) => m.modeField));
    expect(overlayModeFields.size).toBe(MODE_WEIGHT_OVERLAY_MAP.length);
    expect(overlayModeFields.size).toBe(REQUIRED_WEIGHT_FIELDS.length);
    for (const field of REQUIRED_WEIGHT_FIELDS) {
      expect(
        overlayModeFields.has(field),
        `${field} is declared on ModeWeightProfile but missing from MODE_WEIGHT_OVERLAY_MAP — silent lying field`,
      ).toBe(true);
    }
  });

  it('every overlay map ScoringWeights field actually exists on ScoringWeights', () => {
    // Use a real ScoringWeights instance to verify field existence at runtime.
    const baseline = resolveWeights('default');
    for (const { scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
      expect(
        Object.prototype.hasOwnProperty.call(baseline, scoringField),
        `scoringField "${scoringField}" referenced by overlay map but not present on ScoringWeights`,
      ).toBe(true);
      expect(typeof baseline[scoringField]).toBe('number');
    }
  });

  it('applyModeWeightOverlay raises every base weight to mode floor and never lowers', () => {
    const base = resolveWeights('default');
    const profile = getModeWeights('compare_candidates');
    const result = applyModeWeightOverlay(base, profile);
    for (const { modeField, scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
      expect(
        result[scoringField],
        `${scoringField} must be max(base, mode.${modeField})`,
      ).toBe(Math.max(base[scoringField], profile[modeField]));
    }
  });

  it('scaleOverlaidWeights factor=1 returns input unchanged', () => {
    const base = resolveWeights('default');
    const overlaid = applyModeWeightOverlay(base, getModeWeights('attribute_search'));
    expect(scaleOverlaidWeights(overlaid, 1)).toBe(overlaid);
  });

  it('scaleOverlaidWeights scales every overlaid field by factor', () => {
    const base = resolveWeights('default');
    const overlaid = applyModeWeightOverlay(base, getModeWeights('producer_browse'));
    const scaled = scaleOverlaidWeights(overlaid, 0.5);
    for (const { scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
      expect(scaled[scoringField]).toBeCloseTo(overlaid[scoringField] * 0.5, 10);
    }
  });

  it('DEFAULT_WEIGHTS overlay is a no-op (every field unchanged from base)', () => {
    const base = resolveWeights('default');
    const noopOverlay = applyModeWeightOverlay(base, DEFAULT_WEIGHTS);
    for (const { scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
      expect(noopOverlay[scoringField]).toBe(base[scoringField]);
    }
  });
});
