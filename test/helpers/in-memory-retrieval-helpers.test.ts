import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import {
  buildFilterPredicate,
  hybridCandidateToFilterableDoc,
} from '../integration/helpers/in-memory-retrieval-helpers.js';

describe('in-memory retrieval helpers', () => {
  it('supports promoted numeric sensory filters on normalized retrieval documents', () => {
    const predicate = buildFilterPredicate(['body_min:0.7', 'sweetness_min:0.5']);

    expect(predicate({ body: 0.85, sweetness: 0.95 })).toBe(true);
    expect(predicate({ body: 0.65, sweetness: 0.95 })).toBe(false);
    expect(predicate({ body: 0.85, sweetness: 0.2 })).toBe(false);
  });

  it('normalizes legacy 1-5 hybrid candidate sensory fields before evaluating numeric filters', () => {
    const predicate = buildFilterPredicate(['body_min:0.7']);
    const fullBodied = hybridCandidateToFilterableDoc({
      entityId: createEntityId('wine-a'),
      matchedConstraints: [],
      retrievalTrace: {
        retrievalProfile: 'test',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: [],
      },
      body: 4.5,
      identityExactnessTier: 'none',
      lanePresence: 'general_only',
    });
    const lightBodied = hybridCandidateToFilterableDoc({
      entityId: createEntityId('wine-b'),
      matchedConstraints: [],
      retrievalTrace: {
        retrievalProfile: 'test',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: [],
      },
      body: 2,
      identityExactnessTier: 'none',
      lanePresence: 'general_only',
    });

    expect(predicate(fullBodied)).toBe(true);
    expect(predicate(lightBodied)).toBe(false);
  });

  it('infers country from region when retrieval docs omit explicit country', () => {
    const predicate = buildFilterPredicate(['country:Australia', 'grape_or_in:Syrah|Shiraz']);

    expect(predicate({
      region: 'Barossa Valley',
      grapePrimary: 'Shiraz',
      grapes: ['Shiraz', 'Cabernet Sauvignon'],
    })).toBe(true);
  });

  it('prefers explicit wineType over style fallback for dessert fixtures', () => {
    const dessertPredicate = buildFilterPredicate(['wine_type:dessert']);
    const whitePredicate = buildFilterPredicate(['wine_type:white']);

    const doc = {
      wineType: 'dessert',
      style: 'sweet white',
    };

    expect(dessertPredicate(doc)).toBe(true);
    expect(whitePredicate(doc)).toBe(false);
  });
});
