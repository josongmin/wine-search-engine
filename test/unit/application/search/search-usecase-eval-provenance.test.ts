import { describe, expect, it } from 'vitest';
import {
  rankedResultsToEvalProvenanceSlices,
  searchResponseToEvalProvenanceSlices,
} from '../../../../src/application/search/search-usecase-eval-provenance.js';

describe('search-usecase-eval-provenance', () => {
  it('converts ranked-result provenance directly without response reconstruction', () => {
    const slices = rankedResultsToEvalProvenanceSlices('req-1', [{
      entityId: 'wine-1',
      canonicalLabel: 'Wine 1',
      finalScore: 0.91,
      rank: 1,
      componentScores: {
        entityIntegrity: 0.9,
        semantic: 0.8,
        hardConstraintPass: true,
        softConstraint: 0.6,
        attributeAlignment: 0.5,
        preferenceAlignment: 0.4,
        popularity: 0.2,
        availability: 1,
        uncertaintyPenalty: 0.1,
      },
      evidenceItems: [],
      matchedConstraints: [],
      unmetConstraints: [],
      inferredConstraints: [],
      retrievalProvenance: {
        channels: ['dense_semantic', 'anchor_similarity'],
        channelScores: [
          { channel: 'dense_semantic', rawScore: 0.8, rank: 2, rrfContribution: 0.01 },
          { channel: 'anchor_similarity', rawScore: 0.95, rank: 1, rrfContribution: 0.02 },
        ],
        queryViewMatches: [],
        anchorConditioned: true,
        matchedFilterConstraints: [],
        protectedInclusionReason: 'known_item_lookup',
        fusionProfile: 'default',
        fusionScore: 0.91,
      },
    }]);

    expect(slices).toEqual([expect.objectContaining({
      candidateEntityId: 'wine-1',
      topChannel: 'anchor_similarity',
      protectedReason: 'known_item_lookup',
    })]);
  });

  it('reads eval provenance slices from early-return search response meta', () => {
    const slices = searchResponseToEvalProvenanceSlices({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.9,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace-1',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
      },
      results: [],
      clarification: null,
      meta: {
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        retrievalProvenanceSlices: [{
          queryId: 'req-2',
          candidateEntityId: 'wine-2',
          channels: ['dense_semantic', 'anchor_similarity'],
          topChannel: 'anchor_similarity',
          anchorConditioned: true,
          protected: false,
          fusionScore: 0.78,
          rank: 1,
        }],
      },
    });

    expect(slices).toEqual([expect.objectContaining({
      candidateEntityId: 'wine-2',
      topChannel: 'anchor_similarity',
      channels: expect.arrayContaining(['dense_semantic', 'anchor_similarity']),
      anchorConditioned: true,
    })]);
  });

  it('deduplicates repeated anchor_similarity values in response meta provenance slices', () => {
    const slices = searchResponseToEvalProvenanceSlices({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'return_result',
        route: 'hybrid',
        decisionConfidence: 0.9,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'trace-2',
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
      },
      results: [],
      clarification: null,
      meta: {
        queryTimeMs: 1,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        retrievalProvenanceSlices: [{
          queryId: 'req-3',
          candidateEntityId: 'wine-3',
          channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
          topChannel: 'anchor_similarity',
          anchorConditioned: true,
          protected: false,
          fusionScore: 0.84,
          rank: 1,
        }],
      },
    });

    expect(slices).toEqual([expect.objectContaining({
      candidateEntityId: 'wine-3',
      topChannel: 'anchor_similarity',
      channels: ['anchor_similarity', 'dense_semantic'],
      anchorConditioned: true,
    })]);
  });
});
