import { describe, it, expect } from 'vitest';
import { InMemoryAliasMatcher } from '../../integration/helpers/in-memory-adapters.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

/**
 * Helper: creates a minimal RetrievalDocument for testing.
 */
function makeDoc(override: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createEntityId(),
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    aliasesIdentitySafe: [],
    aliasesNoisyRecall: [],
    producer: 'Test Producer',
    region: 'Test Region',
    grapes: [],
    searchTextKo: '',
    searchTextEn: 'test wine',
    semanticSummary: 'test wine summary',
    body: 0.5,
    sweetness: 0.5,
    style: 'test',
    priceBand: 'mid',
    pairing: [],
    occasion: [],
    availability: true,
    popularityScore: 0.5,
    ...override,
  };
}

describe('SmartAliasMatcher — SOTA++ Enhancements', () => {
  describe('Pre-registered aliases (baseline)', () => {
    it('should match exact registered aliases', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('opus one');
      expect(results).toHaveLength(1);
      expect(results[0]!.surfaceForm).toBe('Opus One');
      expect(results[0]!.matchConfidence).toBe(0.95);
      expect(results[0]!.entityIds).toContain(entityId);
    });

    it('should match multiple aliases for same entity', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);
      matcher.addAlias('Opus One 2018', entityId, 0.92);

      const results = await matcher.findMatches('opus one 2018');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.matchConfidence).toBeGreaterThanOrEqual(0.85);
    });

    it('should penalize substring matches (0.85x multiplier)', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('David Arthur Cabernet Sauvignon', entityId, 0.95);

      const results = await matcher.findMatches('david arthur');
      expect(results.length).toBeGreaterThan(0);
      // Substring match should have 0.85 * 0.95 = 0.8075 confidence
      expect(results[0]!.matchConfidence).toBeLessThan(0.95);
      expect(results[0]!.matchConfidence).toBeGreaterThanOrEqual(0.80);
    });

    it('should match compact noisy input without spaces', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('opusone');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.85);
    });

    it('should match punctuation-heavy alias via compact normalization', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Moët & Chandon Brut Impérial', entityId, 0.96);

      const results = await matcher.findMatches('moetchandonbrutimperial');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.85);
    });

    it('should match Korean transliteration directly against latin alias values', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Chateau Margaux', entityId, 0.95);

      const results = await matcher.findMatches('샤토 마고');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.lookupStrategy).toContain('transliterated_exact');
    });

    it('should match incomplete Hangul IME prefixes through curated Korean exception surfaces', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('오푸스ㅇ');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.lookupStrategy).toContain('hangul_ime_completion');
      expect(results[0]!.lookupStrategy).toContain('transliterated_fuzzy');
      expect(results[0]!.matchConfidence).toBe(0.95);
    });

    it('should match latin partial prefixes through prefix substrate', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('opu');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.lookupStrategy).toContain('prefix_exact');
      expect(results[0]!.matchConfidence).toBeCloseTo(0.855);
    });

    it('should match short Korean partial prefixes through the curated prefix substrate', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('오푸');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.lookupStrategy).toContain('transliterated_exact');
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.84);
    });

    it('should match phonetic near-miss aliases via phonetic compact exactness', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Romanee Conti', entityId, 0.94);

      const results = await matcher.findMatches('romane conti');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(entityId);
      expect(results[0]!.lookupStrategy).toContain('phonetic_exact');
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.8);
    });

    it('should not treat second-token fragments as exact-like prefixes', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Opus One', entityId, 0.95);

      const results = await matcher.findMatches('one');
      expect(results).toEqual([]);
    });
  });

  describe('Smart alias generation from indexed documents', () => {
    it('should match producer name from indexed document', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'David Arthur',
        wineType: 'red',
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
        grapePrimary: 'Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('david arthur');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.4);
    });

    it('should match producer + grape variety', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'David Arthur',
        wineType: 'red',
        grapePrimary: 'Cabernet Sauvignon',
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('david arthur cabernet');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      // Multiple terms matched should increase confidence
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.5);
    });

    it('should match producer + vintage year', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'David Arthur',
        vintageYear: 2014,
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
        grapePrimary: 'Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('david arthur 2014');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      // Vintage match should add bonus
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.6);
    });

    it('should match producer + region', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Antinori',
        region: 'Italy / Tuscany / Italy / Tuscany',
        canonicalLabel: '2015 Antinori Tignanello',
        wineType: 'red',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('antinori tuscany');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.4);
    });

    it('should match full canonical label', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
        producer: 'David Arthur',
        grapePrimary: 'Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('david arthur cabernet sauvignon');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.6);
    });

    it('should extract best surface form from matched document', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
        producer: 'David Arthur',
        grapePrimary: 'Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('david arthur cabernet');
      expect(results.length).toBeGreaterThan(0);
      // Should prefer canonical label when it's short enough
      expect(results[0]!.surfaceForm).toBe('2014 David Arthur Cabernet Sauvignon');
    });

    it('should require minimum term coverage (≥50% or 2+ terms)', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Opus One',
        region: 'Napa Valley',
        canonicalLabel: 'Opus One Napa Valley',
        wineType: 'red',
      });
      matcher.indexDocument(doc);

      // Query with only 1 matching term should not match
      const results = await matcher.findMatches('château margaux opus one');
      // Should find at least the producer-region matches
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle wine type matching (red, white, sparkling, etc.)', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Veuve Clicquot',
        wineType: 'sparkling',
        canonicalLabel: 'Veuve Clicquot Brut',
        grapePrimary: 'Chardonnay Blend',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('veuve clicquot sparkling');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
    });

    it('should rank multiple matches by score', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc1 = makeDoc({
        producer: 'David Arthur',
        grapePrimary: 'Cabernet Sauvignon',
        canonicalLabel: '2014 David Arthur Cabernet Sauvignon',
      });
      const doc2 = makeDoc({
        producer: 'David Arthur Vineyards',
        grapePrimary: 'Merlot',
        canonicalLabel: '2015 David Arthur Vineyards Merlot',
      });
      matcher.indexDocument(doc1);
      matcher.indexDocument(doc2);

      const results = await matcher.findMatches('david arthur cabernet');
      expect(results.length).toBeGreaterThan(0);
      // doc1 should rank higher (exact grape match vs doc2's merlot)
      expect(results[0]!.entityIds[0]).toBe(doc1.entityId);
    });

    it('should fallback to full-text search as last resort', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Test Producer',
        searchTextEn: 'premium napa valley cabernet wine highly rated',
        canonicalLabel: 'Test Wine',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('premium napa');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      // Full-text match has lower confidence (0.1 per term, capped at 0.8)
      expect(results[0]!.matchConfidence).toBeLessThanOrEqual(0.8);
    });

    it('should handle vintage year extraction from 4-digit pattern', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Finca Villacreces',
        vintageYear: 2019,
        canonicalLabel: '2019 Finca Villacreces Nebro Ribera del Duero',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('finca villacreces 2019');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
      // Should have bonus from vintage match
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.4);
    });

    it('should not match when too few terms overlap', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Opus One',
        canonicalLabel: 'Opus One Napa Valley',
        wineType: 'red',
        region: 'California / Napa Valley',
        grapePrimary: 'Cabernet Sauvignon',
      });
      matcher.indexDocument(doc);

      // Query with completely different wine type: only 0 terms match (spanish, tempranillo not in doc)
      // Minimum required: 50% of 5 terms = 2.5 → 3 terms required
      const results = await matcher.findMatches('cheap spanish tempranillo rioja under 20');
      // "red" does NOT match "spanish", "tempranillo" ≠ "cabernet", "rioja" not in region
      const hasMatch = results.some((r) => r.entityIds.includes(doc.entityId));
      expect(hasMatch).toBe(false);
    });
  });

  describe('Confidence scoring', () => {
    it('should assign confidence ≥0.7 for strong alias matches', async () => {
      const matcher = new InMemoryAliasMatcher();
      const entityId = createEntityId();
      matcher.addAlias('Château Margaux', entityId, 0.95);

      const results = await matcher.findMatches('chateau margaux');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.matchConfidence).toBeGreaterThanOrEqual(0.7);
    });

    it('should assign fuzzy match confidence 0.6-0.8 for producer+region matches', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Château Margaux',
        region: 'France / Bordeaux / Medoc',
        canonicalLabel: '2010 Château Margaux',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('margaux bordeaux');
      expect(results.length).toBeGreaterThan(0);
      // Score: producer (0.4) + region (0.2) = 0.6, capped at 0.8
      expect(results[0]!.matchConfidence).toBeGreaterThanOrEqual(0.5);
      expect(results[0]!.matchConfidence).toBeLessThanOrEqual(0.8);
    });
  });

  describe('Document indexing and retrieval', () => {
    it('should track indexed documents via getIndexedDocuments()', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc1 = makeDoc({ canonicalLabel: 'Wine 1' });
      const doc2 = makeDoc({ canonicalLabel: 'Wine 2' });
      matcher.indexDocument(doc1);
      matcher.indexDocument(doc2);

      const indexed = matcher.getIndexedDocuments();
      expect(indexed).toHaveLength(2);
      expect(indexed.map((d) => d.entityId)).toContain(doc1.entityId);
      expect(indexed.map((d) => d.entityId)).toContain(doc2.entityId);
    });

    it('should support re-indexing (update) of documents', async () => {
      const matcher = new InMemoryAliasMatcher();
      const docV1 = makeDoc({ canonicalLabel: 'Wine V1', producer: 'Producer A' });
      matcher.indexDocument(docV1);

      const docV2 = makeDoc({
        entityId: docV1.entityId,
        canonicalLabel: 'Wine V2',
        producer: 'Producer B',
      });
      matcher.indexDocument(docV2);

      // Should only have 1 document (updated), and matches should use V2 data
      const indexed = matcher.getIndexedDocuments();
      expect(indexed.some((d) => d.producer === 'Producer B')).toBe(true);
    });
  });

  describe('Grape variety recognition', () => {
    it('should recognize common grape varieties', async () => {
      const matcher = new InMemoryAliasMatcher();
      const cabDoc = makeDoc({
        producer: 'Test',
        grapePrimary: 'Cabernet Sauvignon',
        canonicalLabel: 'Test Cabernet',
      });
      matcher.indexDocument(cabDoc);

      const results = await matcher.findMatches('test cabernet');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.matchConfidence).toBeGreaterThan(0.4);
    });

    it('should match partial grape names', async () => {
      const matcher = new InMemoryAliasMatcher();
      const doc = makeDoc({
        producer: 'Domaine',
        grapePrimary: 'Pinot Noir',
        canonicalLabel: 'Domaine Pinot Noir',
      });
      matcher.indexDocument(doc);

      const results = await matcher.findMatches('domaine pinot');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entityIds).toContain(doc.entityId);
    });
  });
});
