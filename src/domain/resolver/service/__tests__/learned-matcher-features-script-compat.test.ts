/**
 * Script-compatibility feature semantics for the learned matcher.
 *
 * Guards the `scriptCompatibility` gradient:
 *   - same script           → full compatibility (1.0)
 *   - one side mixed-script  → partial (some script overlap exists)
 *   - fully disjoint scripts → partial (e.g. pure Hangul query ↔ pure Latin
 *     canonical label — a legitimate transliteration match in the Korean wine
 *     domain, so it must remain > 0).
 *
 * Train/serve skew: `scriptCompatibility` is emitted verbatim to the external
 * learned-matcher inference model. The deployed model was trained on the
 * distribution where the mixed and disjoint branches BOTH emit 0.5. The
 * disjoint constant is kept semantically distinct (separate named const) but
 * intentionally holds the same value as the mixed case until the model is
 * retrained — feeding a lowered disjoint value without retraining would risk
 * suppressing the core Korean→Latin transliteration recall (사시카이아→Sassicaia).
 * Hence the invariant here is disjoint == mixed (both > 0, both < 1), NOT
 * disjoint < mixed.
 */

import { describe, expect, it } from 'vitest';

import { computeMatcherFeatures } from '../learned-matcher-features.js';

describe('computeMatcherFeatures — scriptCompatibility gradient', () => {
  it('same script (Latin vs Latin) → full compatibility 1.0', () => {
    const f = computeMatcherFeatures('Sassicaia 2018', 'Sassicaia');
    expect(f.scriptCompatibility).toBe(1.0);
  });

  it('same script (Hangul vs Hangul) → full compatibility 1.0', () => {
    const f = computeMatcherFeatures('사시카이아', '사시카이아 와인');
    expect(f.scriptCompatibility).toBe(1.0);
  });

  it('mixed-script query vs single-script candidate → partial (mixed level)', () => {
    // Query carries both Latin and Hangul; candidate is pure Latin.
    const mixed = computeMatcherFeatures('Sassicaia 사시카이아', 'Sassicaia');
    expect(mixed.scriptCompatibility).toBeGreaterThan(0);
    expect(mixed.scriptCompatibility).toBeLessThan(1.0);
  });

  it('fully disjoint scripts (Hangul query vs Latin label) → partial, still > 0', () => {
    // The core Korean→Latin transliteration match path must not score 0.
    const disjoint = computeMatcherFeatures('사시카이아', 'Sassicaia');
    expect(disjoint.scriptCompatibility).toBeGreaterThan(0);
    expect(disjoint.scriptCompatibility).toBeLessThan(1.0);
  });

  it('disjoint cross-script equals the mixed-script case (train/serve-skew safe value)', () => {
    // Train/serve skew: scriptCompatibility is fed verbatim to the external
    // learned-matcher model, trained on the distribution where mixed and
    // disjoint emit the SAME value. Until the model is retrained, the disjoint
    // branch must NOT diverge below the mixed value — doing so would suppress
    // Korean→Latin transliteration recall. The named constant stays distinct so
    // it can diverge post-retrain, but the value invariant is equality.
    const mixed = computeMatcherFeatures('Sassicaia 사시카이아', 'Sassicaia');
    const disjoint = computeMatcherFeatures('사시카이아', 'Sassicaia');
    expect(disjoint.scriptCompatibility).toBe(mixed.scriptCompatibility);
  });

  it('empty query is handled without throwing and stays in [0,1]', () => {
    const f = computeMatcherFeatures('', 'Sassicaia');
    expect(f.scriptCompatibility).toBeGreaterThanOrEqual(0);
    expect(f.scriptCompatibility).toBeLessThanOrEqual(1.0);
  });
});
