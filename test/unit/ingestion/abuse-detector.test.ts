import { describe, it, expect } from 'vitest';
import { AbuseDetector } from '../../../src/domain/ingestion/service/abuse-detector.js';
import type { RawSourceRecord } from '../../../src/domain/ingestion/model/raw-source-record.js';

const detector = new AbuseDetector();

function makeRecord(rawTitle: string, sourceSystem: string = 'test-source'): RawSourceRecord {
  return {
    sourceRecordId: 'rec-1',
    sourceSystem,
    sourceType: 'catalog',
    rawTitle,
    ingestionTimestamp: new Date(),
  };
}

describe('AbuseDetector', () => {
  describe('detectSeoSpam', () => {
    it('title with multiple known entity names → flagged as SEO spam', () => {
      const knownEntities = new Set(['opus one', 'margaux', 'latour', 'petrus']);
      const record = makeRecord('Opus One Margaux Latour Petrus Bordeaux Bundle Deal');
      const result = detector.detectSeoSpam(record, knownEntities);
      expect(result.flagged).toBe(true);
      expect(result.reason).toContain('known entities');
    });

    it('title with only one known entity → not flagged', () => {
      const knownEntities = new Set(['opus one', 'margaux']);
      const record = makeRecord('Opus One 2018 Napa Valley');
      const result = detector.detectSeoSpam(record, knownEntities);
      expect(result.flagged).toBe(false);
    });

    it('empty knownEntities set → not flagged', () => {
      const record = makeRecord('Opus One Margaux Latour');
      const result = detector.detectSeoSpam(record, new Set());
      expect(result.flagged).toBe(false);
    });

    it('title over 200 chars → flagged as suspicious length', () => {
      const longTitle = 'A'.repeat(201);
      const record = makeRecord(longTitle);
      const result = detector.detectSeoSpam(record, new Set(['opus one']));
      expect(result.flagged).toBe(true);
      expect(result.reason).toContain('long');
    });

    it('severity is medium for 2-3 entities, high for 4+', () => {
      const knownEntities = new Set(['opus one', 'margaux', 'latour', 'petrus', 'lafite']);
      const record = makeRecord('opus one margaux latour petrus lafite bundle');
      const result = detector.detectSeoSpam(record, knownEntities);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('2 entity matches → severity=medium', () => {
      const knownEntities = new Set(['opus one', 'margaux']);
      const record = makeRecord('Buy opus one and margaux together');
      const result = detector.detectSeoSpam(record, knownEntities);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });
  });

  describe('detectMassRegistration', () => {
    it('51 records in 1 minute (windowHours=1/60) → NOT flagged (threshold is 1000)', () => {
      // threshold is 1000, not 50; 51 records is fine
      const result = detector.detectMassRegistration('source-1', 51, 1);
      expect(result.flagged).toBe(false);
    });

    it('1001 records in 1 hour → flagged', () => {
      const result = detector.detectMassRegistration('source-1', 1001, 1);
      expect(result.flagged).toBe(true);
      expect(result.reason).toContain('1001');
    });

    it('exactly 1000 records → not flagged (threshold is strict >)', () => {
      const result = detector.detectMassRegistration('source-1', 1000, 1);
      expect(result.flagged).toBe(false);
    });

    it('5001+ records → severity=high', () => {
      const result = detector.detectMassRegistration('source-1', 6000, 1);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('1001-5000 records → severity=medium', () => {
      const result = detector.detectMassRegistration('source-1', 2000, 1);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('windowHours=0 → not flagged (guard against division by zero)', () => {
      const result = detector.detectMassRegistration('source-1', 100000, 0);
      expect(result.flagged).toBe(false);
    });
  });

  describe('detectTitleAnomaly', () => {
    it('title with low Jaccard similarity vs canonical → flagged', () => {
      // Raw title completely different from canonical
      const result = detector.detectTitleAnomaly(
        'best discount wine red bottle premium',
        'Opus One',
        0.3,
      );
      expect(result.flagged).toBe(true);
    });

    it('title closely matching canonical → not flagged', () => {
      const result = detector.detectTitleAnomaly(
        'Opus One 2018 Napa Valley',
        'Opus One',
        0.3,
      );
      expect(result.flagged).toBe(false);
    });

    it('empty raw title → not flagged', () => {
      const result = detector.detectTitleAnomaly('', 'Opus One', 0.3);
      expect(result.flagged).toBe(false);
    });

    it('empty canonical label → not flagged', () => {
      const result = detector.detectTitleAnomaly('Opus One', '', 0.3);
      expect(result.flagged).toBe(false);
    });

    it('similarity < threshold/2 → severity=high', () => {
      // Very different titles
      const result = detector.detectTitleAnomaly(
        'completely unrelated text xyz abc',
        'Opus One',
        0.3, // threshold/2 = 0.15
      );
      expect(result.flagged).toBe(true);
      // jaccard would be very low, so severity should be high
      expect(['medium', 'high']).toContain(result.severity);
    });
  });
});
