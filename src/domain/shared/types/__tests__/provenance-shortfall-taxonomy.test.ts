import { describe, expect, it } from 'vitest';
import {
  classifyShortfallLayer,
  type ProvenanceShortfallCode,
  type ShortfallLayer,
} from '../provenance-shortfall-taxonomy.js';

describe('ProvenanceShortfallTaxonomy', () => {
  describe('classifyShortfallLayer', () => {
    const cases: readonly [string, ShortfallLayer][] = [
      // Retrieval layer
      ['retrieval_provenance_shortfall:identity_evidence', 'retrieval'],
      ['retrieval_provenance_shortfall:constraint_evidence', 'retrieval'],
      ['retrieval_provenance_shortfall:anchor_evidence', 'retrieval'],
      ['dense_retrieval_disabled', 'retrieval'],

      // Provenance closure layer
      ['provenance_shortfall:identity_evidence', 'provenance_closure'],
      ['provenance_shortfall:constraint_evidence', 'provenance_closure'],
      ['provenance_shortfall:anchor_evidence', 'provenance_closure'],

      // Ranking layer
      ['reranker_timeout', 'ranking'],
      ['reranker_http_error', 'ranking'],
      ['reranker_parse_error', 'ranking'],
      ['reranker_unknown', 'ranking'],
      ['reranker_score_normalization_failed', 'ranking'],
      ['reranker_blend_weight_invalid', 'ranking'],
      ['ltr_dimension_mismatch', 'ranking'],

      // Constraint layer
      ['constraint_relaxed:grape_primary,region', 'constraint'],
      ['constraint_relaxation_exhausted:3_steps', 'constraint'],

      // Resolver layer
      ['learned_matcher_timeout', 'resolver'],
      ['learned_matcher_failed', 'resolver'],
      ['entity_resolver_unavailable', 'resolver'],

      // Specialized route layer
      ['producer_browse_unavailable', 'specialized_route'],
      ['producer_browse_fallback', 'specialized_route'],
      ['region_browse_unavailable', 'specialized_route'],
      ['region_browse_fallback', 'specialized_route'],
      ['compare_retriever_unavailable', 'specialized_route'],
      ['compare_anchor_resolution_failed', 'specialized_route'],
      ['compare_candidates_fallback', 'specialized_route'],

      // Mixed route layer
      ['mixed_anchor_resolution_failed', 'mixed_route'],
      ['mixed_similar_retrieval_unavailable', 'mixed_route'],
      ['mixed_similar_retrieval_fallback', 'mixed_route'],
      ['mixed_ranker_unavailable', 'mixed_route'],
      ['mixed_constraint_overlay_failed', 'mixed_route'],

      // Unknown
      ['some_future_reason_code', 'unknown'],
      ['', 'unknown'],
    ];

    it.each(cases)('classifies "%s" as %s', (code, expectedLayer) => {
      expect(classifyShortfallLayer(code)).toBe(expectedLayer);
    });
  });

  it('ProvenanceShortfallCode type accepts known fixed codes', () => {
    // Compile-time assertion: these must be assignable to ProvenanceShortfallCode.
    const codes: ProvenanceShortfallCode[] = [
      'retrieval_provenance_shortfall:identity_evidence',
      'dense_retrieval_disabled',
      'entity_resolver_unavailable',
      'provenance_shortfall:anchor_evidence',
      'reranker_timeout',
      'reranker_score_normalization_failed',
      'ltr_dimension_mismatch',
      'constraint_relaxed:grape_primary',
      'learned_matcher_timeout',
      'producer_browse_unavailable',
      'mixed_anchor_resolution_failed',
    ];
    // Runtime: just confirm the array is non-empty.
    expect(codes.length).toBeGreaterThan(0);
  });
});
