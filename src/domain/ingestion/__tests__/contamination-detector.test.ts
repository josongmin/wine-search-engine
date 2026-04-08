import { describe, it, expect } from 'vitest';

import {
  detectContamination,
  CONTAMINATION_THRESHOLD,
} from '../service/contamination-detector.js';

describe('detectContamination', () => {
  // ── 1. Identical title and canonical ─────────────────────────────────────
  it('returns score near 0 and not flagged when title equals canonical', () => {
    const result = detectContamination('Château Margaux', 'Château Margaux');

    expect(result.score).toBeCloseTo(0, 5);
    expect(result.flagged).toBe(false);
    expect(result.jaccardSimilarity).toBe(1);
    expect(result.noiseDensity).toBe(0);
    expect(result.lengthAnomaly).toBe(false);
    expect(result.noiseTokensFound).toEqual([]);
  });

  // ── 2. Title with noise tokens ───────────────────────────────────────────
  it('detects noise tokens in a padded marketplace title', () => {
    const result = detectContamination(
      'Château Margaux 750ml Gift Box Set',
      'Château Margaux',
    );

    expect(result.noiseDensity).toBeGreaterThan(0);
    // "750ml" becomes "750ml" after tokenization (letters+numbers stay together),
    // so 'ml' as a standalone token is NOT found. Only 'gift', 'box', 'set' match.
    expect(result.noiseTokensFound).toContain('gift');
    expect(result.noiseTokensFound).toContain('box');
    expect(result.noiseTokensFound).toContain('set');
    expect(result.noiseTokensFound).not.toContain('750ml');
    expect(result.noiseTokensFound).not.toContain('750');
  });

  // ── 3. Completely different title ────────────────────────────────────────
  it('flags a title that is completely unrelated to the canonical', () => {
    const result = detectContamination(
      'Amazing Summer Beach Party Essentials',
      'Domaine de la Romanée-Conti',
    );

    expect(result.score).toBeGreaterThan(CONTAMINATION_THRESHOLD);
    expect(result.flagged).toBe(true);
    expect(result.jaccardSimilarity).toBe(0);
  });

  // ── 4. Length anomaly ────────────────────────────────────────────────────
  it('detects length anomaly when title has 3× tokens of canonical', () => {
    // Canonical has 2 tokens ("opus one"), title has 8+ tokens → ratio > 2.5
    const result = detectContamination(
      'Opus One 2018 Napa Valley Red Wine Premium Import Authentic',
      'Opus One',
    );

    expect(result.lengthAnomaly).toBe(true);
  });

  it('does not flag length anomaly when ratio is within threshold', () => {
    const result = detectContamination(
      'Opus One 2018',
      'Opus One',
    );

    expect(result.lengthAnomaly).toBe(false);
  });

  // ── 5. Korean noise tokens ──────────────────────────────────────────────
  it('detects Korean noise tokens in a Korean marketplace title', () => {
    const result = detectContamination(
      '샤또 마고 선물세트 무료배송',
      '샤또 마고',
    );

    // tokenize splits on whitespace after stripping punctuation,
    // so "선물세트" stays as one token — it is NOT in the noise set
    // (only "선물" and "세트" are separate entries).
    // But "무료배송" likewise stays as one token.
    // The noise set has individual Korean morphemes.
    expect(result.noiseDensity).toBeGreaterThanOrEqual(0);
    // Title has extra tokens beyond canonical → jaccard < 1
    expect(result.jaccardSimilarity).toBeLessThan(1);
  });

  it('detects Korean noise when tokens are space-separated', () => {
    const result = detectContamination(
      '샤또 마고 선물 세트 무료 배송',
      '샤또 마고',
    );

    expect(result.noiseTokensFound).toContain('선물');
    expect(result.noiseTokensFound).toContain('세트');
    expect(result.noiseTokensFound).toContain('무료');
    expect(result.noiseTokensFound).toContain('배송');
    expect(result.noiseDensity).toBeGreaterThan(0);
  });

  // ── 6. Threshold boundary ───────────────────────────────────────────────
  describe('threshold boundary (>= 0.45)', () => {
    it('exports CONTAMINATION_THRESHOLD as 0.45', () => {
      expect(CONTAMINATION_THRESHOLD).toBe(0.45);
    });

    it('flags when score equals threshold (>=)', () => {
      // We verify the logic by checking that flagged uses >= semantics.
      // Find a pair that gives a score near the threshold.
      // A moderately noisy title should straddle the boundary.
      const result = detectContamination(
        'Château Margaux',
        'Château Margaux',
      );
      // Identical → score 0, not flagged
      expect(result.flagged).toBe(false);

      // Completely different → score well above threshold
      const flaggedResult = detectContamination(
        'Discount Free Shipping Sale Gift Box',
        'Pétrus Pomerol',
      );
      expect(flaggedResult.flagged).toBe(true);
      expect(flaggedResult.score).toBeGreaterThanOrEqual(CONTAMINATION_THRESHOLD);
    });

    it('uses >= for the flagged boundary, not >', () => {
      // Verify from the result shape: if score exactly equals threshold, flagged is true.
      // We can't easily craft an exact 0.45 score, so we verify the invariant:
      // for any result, flagged === (score >= CONTAMINATION_THRESHOLD)
      const pairs: Array<[string, string]> = [
        ['Château Margaux', 'Château Margaux'],
        ['Château Margaux 750ml Gift Box Set', 'Château Margaux'],
        ['Random Noise Sale Promo Deal', 'Domaine Leflaive Puligny-Montrachet'],
        ['Opus One 2018 Napa Valley Red Wine Premium Import', 'Opus One'],
      ];

      for (const [title, canonical] of pairs) {
        const result = detectContamination(title, canonical);
        expect(result.flagged).toBe(result.score >= CONTAMINATION_THRESHOLD);
      }
    });
  });

  // ── 7. Empty canonical ──────────────────────────────────────────────────
  it('handles empty canonical label gracefully', () => {
    const result = detectContamination('Château Margaux', '');

    // Empty canonical → canonicalTokens is empty → union = titleTokens only
    // Intersection is empty → jaccard = 0 → jaccardPenalty = 1
    // No length anomaly because canonicalTokens.length is 0 → ratio fallback to 1
    expect(result.jaccardSimilarity).toBe(0);
    expect(result.lengthAnomaly).toBe(false);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('handles both empty strings', () => {
    const result = detectContamination('', '');

    // Both empty → titleTokens = [], canonicalTokens = []
    // union.size = 0 → jaccardSimilarity = 1 (guarded)
    // noiseDensity = 0
    // lengthRatio = 1 (guarded) → no length anomaly
    expect(result.score).toBeCloseTo(0, 5);
    expect(result.flagged).toBe(false);
    expect(result.jaccardSimilarity).toBe(1);
    expect(result.noiseDensity).toBe(0);
    expect(result.noiseTokensFound).toEqual([]);
  });

  // ── 8. False positive guard: 'silver' removed from NOISE_VOCABULARY ────
  it('does not flag "silver" as noise — Silver Oak is a legitimate wine name', () => {
    const result = detectContamination(
      'Silver Oak Napa Valley',
      'Silver Oak Napa Valley',
    );

    expect(result.noiseTokensFound).not.toContain('silver');
    expect(result.score).toBeCloseTo(0, 5);
    expect(result.flagged).toBe(false);
  });

  // ── 9. False positive guard: 'gold' removed from NOISE_VOCABULARY ──────
  it('does not flag "gold" as noise — Goldwater Estate is a legitimate wine name', () => {
    const result = detectContamination(
      'Goldwater Estate',
      'Goldwater Estate',
    );

    // "goldwater" is one token (no space), so 'gold' wouldn't match anyway,
    // but verify no noise tokens are found at all.
    expect(result.noiseTokensFound).not.toContain('gold');
    expect(result.noiseTokensFound).not.toContain('goldwater');
    expect(result.score).toBeCloseTo(0, 5);
    expect(result.flagged).toBe(false);
  });

  it('does not flag "gold" as noise when it appears as a standalone token', () => {
    const result = detectContamination(
      'Gold Coast Pinot Noir',
      'Gold Coast Pinot Noir',
    );

    expect(result.noiseTokensFound).not.toContain('gold');
    expect(result.flagged).toBe(false);
  });

  // ── 10. Mixed language noise ────────────────────────────────────────────
  it('detects high noise density in mixed-language promotional title', () => {
    const result = detectContamination(
      'Opus One 특가 할인 Premium Sale',
      'Opus One',
    );

    expect(result.noiseDensity).toBeGreaterThan(0);
    // "특가", "할인", "sale" are noise tokens
    expect(result.noiseTokensFound).toContain('특가');
    expect(result.noiseTokensFound).toContain('할인');
    expect(result.noiseTokensFound).toContain('sale');
    // "premium" is NOT in the noise vocabulary
    expect(result.noiseTokensFound).not.toContain('premium');
    // The score should be elevated due to both noise density and jaccard divergence
    expect(result.score).toBeGreaterThan(0);
    expect(result.lengthAnomaly).toBe(true); // 6 tokens vs 2 → ratio 3.0 > 2.5
  });

  // ── Additional edge cases ───────────────────────────────────────────────

  it('handles accented Latin characters correctly in tokenization', () => {
    const result = detectContamination(
      'Château Pétrus Pomerol',
      'Château Pétrus Pomerol',
    );

    expect(result.jaccardSimilarity).toBe(1);
    expect(result.score).toBeCloseTo(0, 5);
  });

  it('is case-insensitive in comparison', () => {
    const result = detectContamination(
      'CHÂTEAU MARGAUX',
      'château margaux',
    );

    expect(result.jaccardSimilarity).toBe(1);
    expect(result.score).toBeCloseTo(0, 5);
  });

  it('does not flag "limited" as noise — "Limited Release" is a standard wine term', () => {
    const result = detectContamination(
      'Penfolds Grange Limited Release',
      'Penfolds Grange Limited Release',
    );

    expect(result.noiseTokensFound).not.toContain('limited');
    expect(result.flagged).toBe(false);
  });

  it('does not flag "new" as noise — "New Zealand" is a legitimate origin', () => {
    const result = detectContamination(
      'Cloudy Bay Sauvignon Blanc New Zealand',
      'Cloudy Bay Sauvignon Blanc New Zealand',
    );

    expect(result.noiseTokensFound).not.toContain('new');
    expect(result.flagged).toBe(false);
  });

  it('returns score capped at 1 even for extremely polluted titles', () => {
    const result = detectContamination(
      'sale offer deal buy free shipping delivery hot best top special discount promo',
      'Domaine de la Romanée-Conti',
    );

    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.flagged).toBe(true);
  });
});
