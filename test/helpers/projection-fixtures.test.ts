/**
 * Projection parity tests (T7.4).
 *
 * Verify that:
 *   1. makeRetrievalDocument() satisfies RetrievalHitProjection (structural)
 *   2. makeRetrievalDocument() satisfies RetrievalFeatureProjection (structural)
 *   3. makeHitProjection() does NOT carry feature-only fields (isolation)
 */

import { describe, it, expect } from 'vitest';
import {
  makeHitProjection,
  makeFeatureProjection,
  makeRetrievalDocument,
} from './projection-fixtures.js';
import type {
  RetrievalHitProjection,
  RetrievalFeatureProjection,
  RetrievalDocument,
} from '../../src/domain/retrieval/model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Type-level parity assertions (checked at compile time by tsc)
// ---------------------------------------------------------------------------

// RetrievalDocument must be assignable to both projections
const _assertDocSatisfiesHit: RetrievalHitProjection = makeRetrievalDocument();
const _assertDocSatisfiesFeature: RetrievalFeatureProjection = makeRetrievalDocument();
const _assertDocIsDocument: RetrievalDocument = makeRetrievalDocument();

// ---------------------------------------------------------------------------
// Runtime assertions
// ---------------------------------------------------------------------------

describe('projection-fixtures parity (T7.4)', () => {
  describe('makeRetrievalDocument()', () => {
    it('has entityId and canonicalLabel (required hit-projection fields)', () => {
      const doc = makeRetrievalDocument();
      expect(doc.entityId).toBeTruthy();
      expect(doc.canonicalLabel).toBeTruthy();
    });

    it('has entityId (required feature-projection field)', () => {
      const doc = makeRetrievalDocument();
      expect(doc.entityId).toBeTruthy();
    });

    it('has required RetrievalDocument payload fields', () => {
      const doc = makeRetrievalDocument();
      expect(doc.entityType).toBeTruthy();
      expect(doc.aliasesIdentitySafe).toBeInstanceOf(Array);
      expect(doc.aliasesNoisyRecall).toBeInstanceOf(Array);
      expect(doc.grapes).toBeInstanceOf(Array);
      expect(typeof doc.availability).toBe('boolean');
      expect(typeof doc.popularityScore).toBe('number');
    });

    it('overrides are applied', () => {
      const doc = makeRetrievalDocument({ canonicalLabel: 'Custom Label' });
      expect(doc.canonicalLabel).toBe('Custom Label');
    });

    it('carries both hit fields (producer, region) and feature fields (body, sweetness)', () => {
      const doc = makeRetrievalDocument();
      // Hit-projection fields
      expect(doc.producer).toBeTruthy();
      expect(doc.region).toBeTruthy();
      // Feature-projection fields
      expect(typeof doc.body).toBe('number');
      expect(typeof doc.sweetness).toBe('number');
    });
  });

  describe('makeHitProjection()', () => {
    it('has entityId and canonicalLabel', () => {
      const hit = makeHitProjection();
      expect(hit.entityId).toBeTruthy();
      expect(hit.canonicalLabel).toBeTruthy();
    });

    it('does NOT carry feature-only fields (body, tannin, acidity, criticScoreNormalized)', () => {
      const hit = makeHitProjection() as Record<string, unknown>;
      expect(hit['body']).toBeUndefined();
      expect(hit['tannin']).toBeUndefined();
      expect(hit['acidity']).toBeUndefined();
      expect(hit['criticScoreNormalized']).toBeUndefined();
      expect(hit['drinkingWindowStart']).toBeUndefined();
      expect(hit['drinkingWindowEnd']).toBeUndefined();
    });

    it('overrides are applied', () => {
      const hit = makeHitProjection({ region: 'Burgundy' });
      expect(hit.region).toBe('Burgundy');
    });
  });

  describe('makeFeatureProjection()', () => {
    it('has entityId', () => {
      const feat = makeFeatureProjection();
      expect(feat.entityId).toBeTruthy();
    });

    it('has numeric feature fields (body, sweetness)', () => {
      const feat = makeFeatureProjection();
      expect(typeof feat.body).toBe('number');
      expect(typeof feat.sweetness).toBe('number');
    });

    it('does NOT carry hit-only display fields (canonicalLabel, producer, region)', () => {
      const feat = makeFeatureProjection() as Record<string, unknown>;
      expect(feat['canonicalLabel']).toBeUndefined();
      expect(feat['producer']).toBeUndefined();
      expect(feat['region']).toBeUndefined();
    });

    it('overrides are applied', () => {
      const feat = makeFeatureProjection({ body: 0.99 });
      expect(feat.body).toBe(0.99);
    });
  });
});
