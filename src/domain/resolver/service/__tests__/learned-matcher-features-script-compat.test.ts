/**
 * Script-compatibility feature semantics for the learned matcher.
 *
 * Guards the three-level gradient of `scriptCompatibility`:
 *   - same script           → full compatibility (1.0)
 *   - one side mixed-script  → partial (some script overlap exists)
 *   - fully disjoint scripts → weak partial (e.g. pure Hangul query ↔ pure
 *     Latin canonical label — a legitimate transliteration match in the
 *     Korean wine domain, so it must remain > 0, but is a weaker signal than
 *     the mixed case which carries actual character-level script overlap).
 *
 * Regression: previously the `else-if` (mixed) and `else` (disjoint) branches
 * returned the identical value, collapsing two distinct semantic cases into a
 * dead branch.
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

  it('fully disjoint scripts (Hangul query vs Latin label) → weak partial, still > 0', () => {
    // The core Korean→Latin transliteration match path must not score 0.
    const disjoint = computeMatcherFeatures('사시카이아', 'Sassicaia');
    expect(disjoint.scriptCompatibility).toBeGreaterThan(0);
    expect(disjoint.scriptCompatibility).toBeLessThan(1.0);
  });

  it('disjoint cross-script is a WEAKER signal than the mixed-script case', () => {
    // This is the invariant the dead branch silently violated: mixed and
    // disjoint were equal. Mixed has real script overlap, so it must score
    // strictly higher than fully disjoint scripts.
    const mixed = computeMatcherFeatures('Sassicaia 사시카이아', 'Sassicaia');
    const disjoint = computeMatcherFeatures('사시카이아', 'Sassicaia');
    expect(mixed.scriptCompatibility).toBeGreaterThan(disjoint.scriptCompatibility);
  });

  it('empty query is handled without throwing and stays in [0,1]', () => {
    const f = computeMatcherFeatures('', 'Sassicaia');
    expect(f.scriptCompatibility).toBeGreaterThanOrEqual(0);
    expect(f.scriptCompatibility).toBeLessThanOrEqual(1.0);
  });
});
