import { describe, it, expect } from 'vitest';

import type { RawSourceRecord } from '../model/raw-source-record.js';
import { AbuseDetector } from '../service/abuse-detector.js';

function makeRecord(rawTitle: string): RawSourceRecord {
  return {
    sourceRecordId: 'test',
    sourceSystem: 'test',
    sourceType: 'marketplace' as const,
    rawTitle,
    ingestionTimestamp: new Date(),
  };
}

describe('AbuseDetector', () => {
  const detector = new AbuseDetector();

  // ── detectSeoSpam ─────────────────────────────────────────────────

  describe('detectSeoSpam', () => {
    it('1. empty entity set → not flagged', () => {
      const result = detector.detectSeoSpam(
        makeRecord('Château Margaux 2015'),
        new Set<string>(),
      );
      expect(result.flagged).toBe(false);
    });

    it('2. single entity match → not flagged', () => {
      const result = detector.detectSeoSpam(
        makeRecord('Château Margaux 2015 Grand Vin'),
        new Set(['margaux']),
      );
      expect(result.flagged).toBe(false);
    });

    it('3. two entities matched → flagged, severity medium', () => {
      const result = detector.detectSeoSpam(
        makeRecord('Château Margaux Pauillac 2015'),
        new Set(['margaux', 'pauillac']),
      );
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
      expect(result.reason).toContain('2 known entities');
    });

    it('4. 4+ entities matched → severity high', () => {
      const result = detector.detectSeoSpam(
        makeRecord('Margaux Pauillac Pomerol Saint-Emilion blend'),
        new Set(['margaux', 'pauillac', 'pomerol', 'saint-emilion']),
      );
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('5. short entity (< 3 chars) is skipped', () => {
      // "la" has length 2, so it is skipped; only "margaux" matches → single match → not flagged
      const result = detector.detectSeoSpam(
        makeRecord('La Margaux du domaine'),
        new Set(['la', 'margaux']),
      );
      expect(result.flagged).toBe(false);
    });

    it('6. word boundary matching: "margaux" matches title', () => {
      const result = detector.detectSeoSpam(
        makeRecord('château margaux vintage'),
        new Set(['margaux', 'château']),
      );
      expect(result.flagged).toBe(true);
    });

    it('7. false positive guard: "other" (5 chars) is counted as entity', () => {
      const result = detector.detectSeoSpam(
        makeRecord('other wines from margaux region'),
        new Set(['margaux', 'other']),
      );
      // Both "other" (5 chars) and "margaux" (7 chars) pass the min-length filter
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('8. long title (>200 chars) with only 1 entity → flagged, severity low', () => {
      const longTitle = 'A'.repeat(180) + ' margaux ' + 'B'.repeat(30);
      expect(longTitle.length).toBeGreaterThan(200);
      const result = detector.detectSeoSpam(
        makeRecord(longTitle),
        new Set(['margaux']),
      );
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('low');
      expect(result.reason).toContain('unusually long');
    });

    it('9. Korean entities matched correctly', () => {
      const result = detector.detectSeoSpam(
        makeRecord('보르도 지역의 와이너리 메독 포므롤'),
        new Set(['보르도', '메독', '포므롤']),
      );
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('10. Unicode word boundary: "château" matches standalone but NOT as prefix of "châteaux"', () => {
      // "château" should match as a standalone word
      const matchResult = detector.detectSeoSpam(
        makeRecord('grand château margaux'),
        new Set(['château', 'margaux']),
      );
      expect(matchResult.flagged).toBe(true);

      // "château" should NOT match inside "châteaux" (letter follows)
      const noMatchResult = detector.detectSeoSpam(
        makeRecord('les châteaux du médoc'),
        new Set(['château', 'médoc']),
      );
      // "château" should not match "châteaux" because 'x' is \p{L}
      // Only "médoc" matches → single entity → not flagged
      expect(noMatchResult.flagged).toBe(false);
    });
  });

  // ── detectMassRegistration ────────────────────────────────────────

  describe('detectMassRegistration', () => {
    it('11. under limit → not flagged', () => {
      const result = detector.detectMassRegistration('vivino', 500, 1);
      expect(result.flagged).toBe(false);
    });

    it('12. over count limit (1001) → flagged, severity medium', () => {
      const result = detector.detectMassRegistration('vivino', 1001, 1);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('13. over rate limit per hour → flagged', () => {
      // 2000 records in 1h → rate 2000/h > 1000/h limit
      const result = detector.detectMassRegistration('scraperX', 2000, 1);
      expect(result.flagged).toBe(true);
    });

    it('14. burst multiplier (5001+) → severity high', () => {
      // 5001 > 1000 * 5 → high severity
      const result = detector.detectMassRegistration('scraperX', 5001, 1);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('15. zero window hours → not flagged (guard)', () => {
      const result = detector.detectMassRegistration('scraperX', 9999, 0);
      expect(result.flagged).toBe(false);
    });
  });

  // ── detectTitleAnomaly ────────────────────────────────────────────

  describe('detectTitleAnomaly', () => {
    it('16. similar titles → not flagged', () => {
      const result = detector.detectTitleAnomaly(
        'Château Margaux 2015',
        'Château Margaux 2015 Bordeaux',
      );
      expect(result.flagged).toBe(false);
    });

    it('17. very different titles → flagged', () => {
      const result = detector.detectTitleAnomaly(
        'Buy Cheap Wine Online Free Shipping',
        'Château Margaux 2015',
      );
      expect(result.flagged).toBe(true);
      expect(result.reason).toContain('similarity');
    });

    it('18. extremely divergent (below threshold/2) → severity high', () => {
      const result = detector.detectTitleAnomaly(
        'completely unrelated spam keywords here',
        'Château Margaux 2015 Premier Grand Cru',
      );
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('19. empty title → not flagged', () => {
      const resultEmptyRaw = detector.detectTitleAnomaly('', 'Château Margaux');
      expect(resultEmptyRaw.flagged).toBe(false);

      const resultEmptyCanonical = detector.detectTitleAnomaly('Château Margaux', '');
      expect(resultEmptyCanonical.flagged).toBe(false);
    });

    it('20. custom threshold 0.5 → flags at lower divergence', () => {
      // These titles share some tokens but not 50%
      const result = detector.detectTitleAnomaly(
        'Margaux Grand Vin Rouge 2015',
        'Château Margaux Premier Grand Cru Classé 2015',
        0.5,
      );
      // Jaccard will be moderate — with 0.5 threshold it should flag
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });
  });
});
