import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import {
  assertEmbeddingSensitiveGovernance,
  assertEmbeddingSensitiveLiveAlignment,
  assertEmbeddingSensitiveRuntime,
  buildEmbeddingSensitiveRuntimeDescriptor,
  filterEmbeddingSensitiveGoldenQueries,
  summarizeEmbeddingSensitiveLiveAlignment,
} from '../../../scripts/eval/embedding-sensitive-offline-eval.js';
import {
  assertEmbeddingAblationTargets,
  buildEmbeddingAblationReport,
} from '../../../scripts/eval/run-offline-eval-embedding-sensitive.js';

let queryCounter = 0;

function makeGoldenQuery(
  queryClass: GoldenQuery['query_class'],
  overrides: Partial<GoldenQuery> = {},
): GoldenQuery {
  queryCounter += 1;
  return {
    qid: `${queryClass}-${queryCounter}`,
    query: `${queryClass} query`,
    query_class: queryClass,
    scenario: 'D',
    language: 'ko',
    retrieval_labels: { relevant: [{ entity_id: `wine-${queryCounter}`, grade: 1 }] },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: 'wine-1',
      query_template_id: 'template-1',
      generation_run_id: 'run-1',
      alias_cluster_id: 'cluster-1',
    },
    annotation_tier: 'bronze',
    annotated_by: ['test'],
    release_gate_eligible: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('embedding-sensitive offline eval helpers', () => {
  it('filters the canonical embedding-sensitive query classes only', () => {
    const filtered = filterEmbeddingSensitiveGoldenQueries([
      makeGoldenQuery('semantic_preference'),
      makeGoldenQuery('similar_compare'),
      makeGoldenQuery('exploration'),
      makeGoldenQuery('exact_entity'),
      makeGoldenQuery('no_match'),
    ]);

    expect(filtered.map((query) => query.query_class)).toEqual([
      'semantic_preference',
      'similar_compare',
      'exploration',
    ]);
  });

  it('enforces corpus governance floors for embedding-sensitive benchmarks', () => {
    const queries: GoldenQuery[] = [
      ...Array.from({ length: 11 }, () => makeGoldenQuery('semantic_preference', {
        retrieval_labels: {
          relevant: [
            { entity_id: `semantic-a-${queryCounter}`, grade: 1 },
            { entity_id: `semantic-b-${queryCounter}`, grade: 0.7 },
            { entity_id: `semantic-c-${queryCounter}`, grade: 0.5 },
          ],
        },
      })),
      ...Array.from({ length: 5 }, () => makeGoldenQuery('exploration', {
        retrieval_labels: {
          relevant: [
            { entity_id: `exploration-a-${queryCounter}`, grade: 1 },
            { entity_id: `exploration-b-${queryCounter}`, grade: 0.7 },
            { entity_id: `exploration-c-${queryCounter}`, grade: 0.5 },
          ],
        },
      })),
      ...Array.from({ length: 8 }, () => makeGoldenQuery('similar_compare', {
        retrieval_labels: {
          relevant: [
            { entity_id: `similar-a-${queryCounter}`, grade: 1 },
            { entity_id: `similar-b-${queryCounter}`, grade: 0.7 },
            { entity_id: `similar-c-${queryCounter}`, grade: 0.5 },
          ],
        },
      })),
    ];

    const summary = assertEmbeddingSensitiveGovernance(queries);
    expect(summary.queryCount).toBe(24);
    expect(summary.distinctQueryClasses).toBe(3);
    expect(summary.queryClassMix['semantic_preference']).toBe(11);
    expect(summary.weakListwiseGoldCount).toBe(0);
  });

  it('fails closed on thin embedding-sensitive corpora', () => {
    expect(() =>
      assertEmbeddingSensitiveGovernance([
        ...Array.from({ length: 3 }, () => makeGoldenQuery('semantic_preference')),
        ...Array.from({ length: 2 }, () => makeGoldenQuery('similar_compare')),
      ]),
    ).toThrow(/embedding-sensitive offline eval corpus governance failed/);
  });

  it('fails closed when listwise embedding-sensitive rows carry only single-point gold judgments', () => {
    expect(() =>
      assertEmbeddingSensitiveGovernance([
        ...Array.from({ length: 11 }, () => makeGoldenQuery('semantic_preference')),
        ...Array.from({ length: 5 }, () => makeGoldenQuery('exploration')),
        ...Array.from({ length: 8 }, () => makeGoldenQuery('similar_compare', {
          retrieval_labels: {
            relevant: [
              { entity_id: `similar-a-${queryCounter}`, grade: 1 },
              { entity_id: `similar-b-${queryCounter}`, grade: 0.7 },
              { entity_id: `similar-c-${queryCounter}`, grade: 0.5 },
            ],
          },
        })),
      ]),
    ).toThrow(/weak_listwise_gold_count=/);
  });

  it('fails closed when live embedding-sensitive canonical gold never overlaps runtime results', () => {
    const summary = summarizeEmbeddingSensitiveLiveAlignment([
      {
        qid: 'q-f-0000',
        query: 'wines similar to 2013 Villa Poggio Salvi Brunello di Montalcino',
        rankedEntityIds: ['wine-a', 'wine-b', 'wine-c'],
        relevantEntityIds: ['wine-x', 'wine-y'],
      },
      {
        qid: 'q-f-0001',
        query: 'wines similar to 2009 Cos d\'Estournel Cos d\'Estournel',
        rankedEntityIds: ['wine-d', 'wine-e'],
        relevantEntityIds: ['wine-z'],
      },
    ]);

    expect(summary.queryCount).toBe(2);
    expect(summary.overlapQueryCount).toBe(0);
    expect(summary.zeroOverlapQueryCount).toBe(2);
    expect(() => assertEmbeddingSensitiveLiveAlignment(summary)).toThrow(/canonical gold overlap collapsed to zero/);
  });

  it('allows live embedding-sensitive alignment when at least one query overlaps', () => {
    const summary = summarizeEmbeddingSensitiveLiveAlignment([
      {
        qid: 'q-f-0000',
        query: 'wines similar to 2013 Villa Poggio Salvi Brunello di Montalcino',
        rankedEntityIds: ['wine-a', 'wine-b', 'wine-c'],
        relevantEntityIds: ['wine-x', 'wine-b'],
      },
      {
        qid: 'q-f-0001',
        query: 'wines similar to 2009 Cos d\'Estournel Cos d\'Estournel',
        rankedEntityIds: ['wine-d', 'wine-e'],
        relevantEntityIds: ['wine-z'],
      },
    ]);

    expect(summary.overlapQueryCount).toBe(1);
    expect(summary.zeroOverlapQueryCount).toBe(1);
    expect(() => assertEmbeddingSensitiveLiveAlignment(summary)).not.toThrow();
  });

  it('fails closed for in-memory or dense-disabled runtime descriptors', () => {
    expect(() =>
      assertEmbeddingSensitiveRuntime({
        runtimeTarget: 'in_memory_test_server',
        usesLiveApi: false,
        denseRetrievalEnabled: true,
        phase: 'dense_on',
        queryEmbeddingModel: 'text-embedding-3-small',
        queryEmbeddingModelVersion: 'text-embedding-3-small@v1',
      }),
    ).toThrow(/live search runtime/);

    expect(() =>
      assertEmbeddingSensitiveRuntime({
        runtimeTarget: 'search_api_http_embedding_sensitive',
        usesLiveApi: true,
        denseRetrievalEnabled: false,
        phase: 'dense_on',
        queryEmbeddingModel: 'text-embedding-3-small',
        queryEmbeddingModelVersion: 'text-embedding-3-small@v1',
      }),
    ).toThrow(/dense retrieval enabled/);
  });

  it('fails closed when a live runtime does not declare its dense expectation explicitly', () => {
    const descriptor = buildEmbeddingSensitiveRuntimeDescriptor({
      EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive',
    });

    expect(descriptor.runtimeTarget).toBe('search_api_http_embedding_sensitive');
    expect(descriptor.usesLiveApi).toBe(true);
    expect(descriptor.denseRetrievalEnabled).toBeUndefined();
    expect(() => assertEmbeddingSensitiveRuntime(descriptor)).toThrow(/explicit dense retrieval expectation/);
  });

  it('derives the runtime descriptor from env using the actual query embedding model', () => {
    const descriptor = buildEmbeddingSensitiveRuntimeDescriptor({
      EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive',
      EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED: 'true',
      EVAL_EMBEDDING_SENSITIVE_PHASE: 'dense_on',
    });

    expect(descriptor.runtimeTarget).toBe('search_api_http_embedding_sensitive');
    expect(descriptor.usesLiveApi).toBe(true);
    expect(descriptor.denseRetrievalEnabled).toBe(true);
    expect(descriptor.phase).toBe('dense_on');
    expect(descriptor.queryEmbeddingModel).toBe('text-embedding-3-small');
    expect(descriptor.queryEmbeddingModelVersion).toMatch(/^text-embedding-3-small@v\d+$/u);
  });

  it('fails closed when the query embedding model drifts away from the versioned vector namespace', () => {
    const descriptor = buildEmbeddingSensitiveRuntimeDescriptor({
      EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive',
      EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED: 'true',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });

    expect(() => assertEmbeddingSensitiveRuntime(descriptor)).toThrow(/vector namespace to match/);
  });

  it('allows dense-off live runtime descriptors only in the dense-off phase', () => {
    const descriptor = buildEmbeddingSensitiveRuntimeDescriptor({
      EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive_dense_off',
      EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED: 'false',
      EVAL_EMBEDDING_SENSITIVE_PHASE: 'dense_off',
    });

    expect(() => assertEmbeddingSensitiveRuntime(descriptor)).not.toThrow();
    expect(descriptor.denseRetrievalEnabled).toBe(false);
    expect(descriptor.phase).toBe('dense_off');
  });

  it('fails closed when dense ablation targets reuse the same live runtime url', () => {
    expect(() =>
      assertEmbeddingAblationTargets({
        apiUrl: 'http://127.0.0.1:3000',
        compareDenseOff: true,
      }),
    ).toThrow(/dense-off-api-url/);

    expect(() =>
      assertEmbeddingAblationTargets({
        apiUrl: 'http://127.0.0.1:3000',
        denseOffApiUrl: 'http://127.0.0.1:3000/',
        compareDenseOff: true,
      }),
    ).toThrow(/different live runtime URLs/);
  });

  it('computes dense-on minus dense-off ablation deltas', () => {
    const report = buildEmbeddingAblationReport({
      denseOnPath: '/tmp/dense-on.json',
      denseOffPath: '/tmp/dense-off.json',
      denseOn: {
        query_count: 24,
        ndcg_at_10: 0.5,
        mrr_at_10: 0.4,
        recall_at_3: 0.3,
        recall_at_100: 0.7,
        decision_utility: 0.2,
        wrong_top1_rate: 0.1,
      },
      denseOff: {
        query_count: 24,
        ndcg_at_10: 0.4,
        mrr_at_10: 0.35,
        recall_at_3: 0.2,
        recall_at_100: 0.65,
        decision_utility: 0.1,
        wrong_top1_rate: 0.15,
      },
    });

    expect(report.deltas_dense_on_minus_dense_off.ndcg_at_10).toBeCloseTo(0.1);
    expect(report.deltas_dense_on_minus_dense_off.mrr_at_10).toBeCloseTo(0.05);
    expect(report.deltas_dense_on_minus_dense_off.recall_at_3).toBeCloseTo(0.1);
    expect(report.deltas_dense_on_minus_dense_off.recall_at_100).toBeCloseTo(0.05);
    expect(report.deltas_dense_on_minus_dense_off.decision_utility).toBeCloseTo(0.1);
    expect(report.deltas_dense_on_minus_dense_off.wrong_top1_rate).toBeCloseTo(-0.05);
  });
});
