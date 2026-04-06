import { describe, expect, it, vi } from 'vitest';
import { SearchPipelineEvaluator } from '../search-pipeline-evaluator.js';

describe('SearchPipelineEvaluator', () => {
  it('prefers direct eval provenance slices when the search executor exposes them', async () => {
    const searchUseCase = {
      execute: vi.fn(async () => {
        throw new Error('fallback execute should not be used');
      }),
      executeForEvaluation: vi.fn(async () => ({
        response: {
          queryType: 'search' as const,
          engineDecision: {
            decisionStatus: 'resolved',
            decisionConfidence: 0.91,
            executionMode: 'degraded',
            blockingEligible: false,
            degradationReasons: ['reranker_timeout'],
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
          meta: {
            queryTimeMs: 1,
            route: 'hybrid',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
          },
        },
        retrievalProvenanceSlices: [{
          queryId: 'eval-fixed',
          candidateEntityId: 'wine-direct',
          channels: ['dense_semantic'],
          topChannel: 'dense_semantic',
          anchorConditioned: false,
          protected: true,
          protectedReason: 'known_item_lookup',
          fusionScore: 0.77,
          rank: 1,
        }],
        funnelMetrics: {
          coarsePrunePassRate: 0.6,
          rerankChangedTopK: true,
          meanFinalScore: 0.77,
          scoreGapRank1Rank2: 0.12,
          producerDiversity: 1,
        },
      })),
    };

    const evaluator = new SearchPipelineEvaluator(searchUseCase as never);
    const output = await evaluator.execute('Opus One', 'known_item_lookup');

    expect(searchUseCase.executeForEvaluation).toHaveBeenCalledOnce();
    expect(output.retrievalProvenanceSlices).toEqual([
      expect.objectContaining({
        candidateEntityId: 'wine-direct',
        topChannel: 'dense_semantic',
        protectedReason: 'known_item_lookup',
      }),
    ]);
    expect(output.funnelMetrics).toEqual(
      expect.objectContaining({
        coarsePrunePassRate: 0.6,
        rerankChangedTopK: true,
      }),
    );
    expect(output.executionMode).toBe('degraded');
    expect(output.blockingEligible).toBe(false);
    expect(output.degradationReasons).toEqual(['reranker_timeout']);
  });

  it('reuses runtime-produced response meta provenance slices when direct slices are absent', async () => {
    const searchUseCase = {
      execute: vi.fn(async () => ({
        queryType: 'search' as const,
        engineDecision: {
          decisionStatus: 'resolved',
          decisionConfidence: 0.91,
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1',
            threshold_profile_id: 'default',
            planner_version: '1',
            feature_flags: {},
          },
        },
        meta: {
          queryTimeMs: 1,
          route: 'hybrid',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
          retrievalProvenanceSlices: [{
            queryId: 'eval-derived',
            candidateEntityId: 'wine-1',
            channels: ['anchor_similarity', 'dense_semantic'],
            topChannel: 'anchor_similarity',
            anchorConditioned: true,
            protected: false,
            fusionScore: 0.88,
            rank: 1,
          }],
        },
        results: [
          {
            entity: {
              entityId: 'wine-1',
              canonicalLabel: 'Wine 1',
              type: 'wine',
            },
            relevanceScore: 0.88,
            match: {
              matchType: 'hybrid',
              anchorUsed: true,
              scoreComponents: {
                lexical: 0.3,
                semantic: 0.5,
                attribute: 0.1,
                popularity: 0.0,
                preferenceAlignment: 0.0,
              },
            },
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: {
              uncertaintyConfidence: 0.9,
              missingInfo: [],
              approximationUsed: false,
            },
            evidenceItems: [
              {
                type: 'semantic_relevance',
                source: 'ranking_signal_computer',
                contribution: '+0.55',
                strength: 'high',
                provenance: 'semantic',
              },
              {
                type: 'anchor_similarity',
                source: 'ranking_signal_computer',
                contribution: '+0.35',
                strength: 'medium',
                provenance: 'anchor',
              },
            ],
          },
        ],
      })),
    };

    const evaluator = new SearchPipelineEvaluator(searchUseCase as never);
    const output = await evaluator.execute('Opus One like wine', 'anchored_similarity');

    expect(output.retrievalProvenanceSlices).toEqual([
      expect.objectContaining({
        candidateEntityId: 'wine-1',
        topChannel: 'anchor_similarity',
      }),
    ]);
  });

  it('deduplicates repeated anchor_similarity entries in runtime response meta provenance fallback slices', async () => {
    const searchUseCase = {
      execute: vi.fn(async () => ({
        queryType: 'search' as const,
        engineDecision: {
          decisionStatus: 'resolved',
          decisionConfidence: 0.91,
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1',
            threshold_profile_id: 'default',
            planner_version: '1',
            feature_flags: {},
          },
        },
        meta: {
          queryTimeMs: 1,
          route: 'hybrid',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
          retrievalProvenanceSlices: [{
            queryId: 'eval-derived-dedupe',
            candidateEntityId: 'wine-fallback-dedupe',
            channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
            topChannel: 'anchor_similarity',
            anchorConditioned: true,
            protected: false,
            fusionScore: 0.88,
            rank: 1,
          }],
        },
        results: [],
      })),
    };

    const evaluator = new SearchPipelineEvaluator(searchUseCase as never);
    const output = await evaluator.execute('Opus One like wine', 'anchored_similarity');

    expect(output.retrievalProvenanceSlices).toEqual([
      expect.objectContaining({
        candidateEntityId: 'wine-fallback-dedupe',
        channels: ['anchor_similarity', 'dense_semantic'],
        topChannel: 'anchor_similarity',
      }),
    ]);
  });

  it('deduplicates repeated anchor_similarity entries in direct eval slices', async () => {
    const searchUseCase = {
      execute: vi.fn(async () => {
        throw new Error('fallback execute should not be used');
      }),
      executeForEvaluation: vi.fn(async () => ({
        response: {
          queryType: 'search' as const,
          engineDecision: {
            decisionStatus: 'resolved',
            decisionConfidence: 0.91,
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
          meta: {
            queryTimeMs: 1,
            route: 'hybrid',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
          },
        },
        retrievalProvenanceSlices: [{
          queryId: 'eval-dedupe',
          candidateEntityId: 'wine-anchor-dedupe',
          channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
          topChannel: 'anchor_similarity',
          anchorConditioned: true,
          protected: false,
          fusionScore: 0.81,
          rank: 1,
        }],
      })),
    };

    const evaluator = new SearchPipelineEvaluator(searchUseCase as never);
    const output = await evaluator.execute('anchor alias query', 'anchored_similarity');

    expect(output.retrievalProvenanceSlices).toEqual([
      expect.objectContaining({
        candidateEntityId: 'wine-anchor-dedupe',
        channels: ['anchor_similarity', 'dense_semantic'],
        topChannel: 'anchor_similarity',
      }),
    ]);
  });

  it('deduplicates repeated anchor_similarity when direct eval slices already contain duplicates', async () => {
    const searchUseCase = {
      execute: vi.fn(async () => {
        throw new Error('fallback execute should not be used');
      }),
      executeForEvaluation: vi.fn(async () => ({
        response: {
          queryType: 'search' as const,
          engineDecision: {
            decisionStatus: 'resolved',
            decisionConfidence: 0.91,
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
          meta: {
            queryTimeMs: 1,
            route: 'hybrid',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
          },
        },
        retrievalProvenanceSlices: [{
          queryId: 'eval-duplicate-anchor',
          candidateEntityId: 'wine-anchor-both',
          channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
          topChannel: 'anchor_similarity',
          anchorConditioned: true,
          protected: false,
          fusionScore: 0.81,
          rank: 1,
        }],
      })),
    };

    const evaluator = new SearchPipelineEvaluator(searchUseCase as never);
    const output = await evaluator.execute('anchor alias dedupe query', 'anchored_similarity');

    expect(output.retrievalProvenanceSlices).toEqual([
      expect.objectContaining({
        candidateEntityId: 'wine-anchor-both',
        channels: ['anchor_similarity', 'dense_semantic'],
        topChannel: 'anchor_similarity',
      }),
    ]);
  });
});
