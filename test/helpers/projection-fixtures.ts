/**
 * Standardized factory helpers for RetrievalHitProjection, RetrievalFeatureProjection,
 * and RetrievalDocument.  Use these across the test suite instead of ad-hoc object
 * literals so that shape drift is caught at compile time in one place.
 *
 * T7.4 — test fixture / adapter migration to projection family vocabulary.
 */

import { createEntityId } from '../../src/domain/shared/types/entity-id.js';
import type {
  RetrievalHitProjection,
  RetrievalFeatureProjection,
  RetrievalDocument,
} from '../../src/domain/retrieval/model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Hit-projection factory
// ---------------------------------------------------------------------------

/**
 * Returns a minimal {@link RetrievalHitProjection} with stable defaults.
 * Only fields belonging to the hit-projection family are present — feature
 * fields (body, tannin, acidity, …) are intentionally absent.
 */
export function makeHitProjection(
  overrides?: Partial<RetrievalHitProjection>,
): RetrievalHitProjection {
  const base: RetrievalHitProjection = {
    entityId: createEntityId('test-wine-hit'),
    canonicalLabel: 'Test Wine',
    producer: 'Test Producer',
    region: 'Test Region',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Feature-projection factory
// ---------------------------------------------------------------------------

/**
 * Returns a minimal {@link RetrievalFeatureProjection} with stable defaults.
 * Only fields belonging to the feature-projection family are present — display
 * fields (canonicalLabel, producer, region, …) are intentionally absent.
 */
export function makeFeatureProjection(
  overrides?: Partial<RetrievalFeatureProjection>,
): RetrievalFeatureProjection {
  const base: RetrievalFeatureProjection = {
    entityId: createEntityId('test-wine-feature'),
    body: 0.5,
    sweetness: 0.2,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Full RetrievalDocument factory
// ---------------------------------------------------------------------------

/**
 * Returns a fully populated {@link RetrievalDocument} with stable defaults.
 *
 * The returned object satisfies both {@link RetrievalHitProjection} and
 * {@link RetrievalFeatureProjection} because {@link RetrievalDocument} extends
 * both interfaces.
 */
export function makeRetrievalDocument(
  overrides?: Partial<RetrievalDocument>,
): RetrievalDocument {
  const base: RetrievalDocument = {
    // Required fields from RetrievalDocument (overrides both projections)
    entityId: createEntityId('test-wine-doc'),
    entityType: 'wine',
    canonicalLabel: 'Test Wine 2020',
    aliasesIdentitySafe: ['Test Wine 2020'],
    aliasesNoisyRecall: ['test wine'],
    producer: 'Test Producer',
    region: 'Test Region',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '테스트 와인',
    searchTextEn: 'Test Wine 2020 Test Region Cabernet Sauvignon',
    semanticSummary: 'A test wine used in automated test suites.',
    body: 0.7,
    sweetness: 0.2,
    style: 'bold red',
    priceBand: 'mid',
    pairing: ['steak'],
    occasion: ['dinner'],
    availability: true,
    popularityScore: 0.6,
  };
  return { ...base, ...overrides };
}
