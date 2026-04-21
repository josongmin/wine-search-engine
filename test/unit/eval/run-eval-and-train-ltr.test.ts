import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEvalTrainingReleaseMarkdownSummary,
  combineReleaseGateStatuses,
  evaluateNoisyEntityReleaseGate,
  runEvaluationAndTraining,
} from '../../../scripts/eval/run-eval-and-train-ltr.ts';
import type { ReleaseGateResult } from '../../../src/domain/evaluation/service/eval-runner.js';
import type { EvalCase } from '../../../src/domain/evaluation/model/eval-case.js';
import { createCanonicalEntityId } from '../../../src/domain/shared/types/index.js';

const hoisted = vi.hoisted(() => ({
  goldCases: [] as EvalCase[],
  savedEvalResults: [] as unknown[],
  registry: {
    saveModel: vi.fn(async () => {}),
    activateSnapshot: vi.fn(async () => 1),
  },
  benchmarkRunStore: {
    saveRun: vi.fn(async () => {}),
  },
  evaluateNoisyEntityBenchmarkWithSearchExecutorMock: vi.fn(),
  buildTrainingExamplesMock: vi.fn(),
  trainAllModelsMock: vi.fn(),
}));

vi.mock('../../../src/infrastructure/adapter/pg-gold-set-store.js', () => ({
  PgGoldSetStore: class {
    async getCases() {
      return hoisted.goldCases;
    }
  },
}));

vi.mock('../../../src/infrastructure/adapter/pg-eval-result-store.js', () => ({
  PgEvalResultStore: class {
    async saveResult(result: unknown) {
      hoisted.savedEvalResults.push(result);
    }

    async getResults() {
      return hoisted.savedEvalResults;
    }
  },
}));

vi.mock('../../../src/infrastructure/adapter/pg-ltr-model-registry.js', () => ({
  PgLtrModelRegistry: class {
    saveModel = hoisted.registry.saveModel;
    activateSnapshot = hoisted.registry.activateSnapshot;
  },
}));

vi.mock('../../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js', () => ({
  PgEvalBenchmarkRunStore: class {
    saveRun = hoisted.benchmarkRunStore.saveRun;
  },
}));

vi.mock('../../../src/domain/ranking/training.js', () => ({
  buildTrainingExamples: hoisted.buildTrainingExamplesMock,
  trainAllModels: hoisted.trainAllModelsMock,
}));

vi.mock('../../../scripts/eval/run-noisy-entity-eval.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scripts/eval/run-noisy-entity-eval.ts')>();
  return {
    ...actual,
    evaluateNoisyEntityBenchmarkWithSearchExecutor: hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock,
  };
});

function makeEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: 'case-1',
    query: 'opus one',
    queryClass: 'short_entity',
    expectedEntityId: createCanonicalEntityId('wine.opus-one-2018'),
    expectedStatus: 'resolved',
    labelTier: 'gold',
    timestamp: new Date('2026-04-17T00:00:00.000Z'),
    sliceTags: ['noisy_entity'],
    ...overrides,
  };
}

function passingSearchResponse() {
  return {
    queryType: 'search' as const,
    engineDecision: {
      decisionStatus: 'resolved' as const,
      decisionConfidence: 0.98,
      executionMode: 'authoritative' as const,
      blockingEligible: true,
      degradationReasons: [],
      decisionSnapshot: {
        snapshot_id: 'snapshot-test',
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
        response_contract_version: 'search_response_v1',
      },
    },
    results: [{
      entity: {
        entityId: createCanonicalEntityId('wine.opus-one-2018'),
        canonicalLabel: 'Opus One 2018',
        type: 'wine',
      },
      relevanceScore: 0.98,
      match: {
        matchType: 'hybrid',
        anchorUsed: false,
        scoreComponents: {
          lexical: 0.2,
          semantic: 0.65,
          attribute: 0.08,
          popularity: 0.03,
          preferenceAlignment: 0.02,
        },
      },
      constraints: { matched: [], unmet: [], inferred: [] },
      uncertainty: {
        uncertaintyConfidence: 0.98,
        missingInfo: [],
        approximationUsed: false,
      },
      evidenceItems: [{
        type: 'semantic_relevance',
        source: 'ranking_signal_computer',
        contribution: '+0.70',
        strength: 'high',
        provenance: 'semantic',
      }],
    }],
    meta: {
      queryTimeMs: 5,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function failingEvalSearchResponse() {
  return {
    ...passingSearchResponse(),
    engineDecision: {
      ...passingSearchResponse().engineDecision,
      decisionStatus: 'failed' as const,
      decisionConfidence: 0.1,
    },
    results: [],
  };
}

function passingNoisyReport() {
  return {
    benchmark: 'noisy-entity-benchmark' as const,
    query_count: 20,
    recall_at_1: 0.95,
    recall_at_3: 1,
    mrr: 0.98,
    by_category: {
      transliteration: { query_count: 2, recall_at_1: 1, recall_at_3: 1, mrr: 1 },
      phonetic: { query_count: 2, recall_at_1: 1, recall_at_3: 1, mrr: 1 },
    },
    by_language: {
      en: { query_count: 10, recall_at_1: 0.9, recall_at_3: 1, mrr: 0.95 },
      ko: { query_count: 10, recall_at_1: 1, recall_at_3: 1, mrr: 1 },
      mixed: { query_count: 10, recall_at_1: 0.95, recall_at_3: 1, mrr: 0.98 },
    },
    misses: [],
    provenance_checked_count: 2,
    provenance_match_rate: 1,
    provenance_misses: [],
    resolution_checked_count: 2,
    resolution_match_rate: 1,
    false_exact_rate: 0,
    resolution_misses: [],
    source: 'search-executor' as const,
    evaluated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  hoisted.goldCases.length = 0;
  hoisted.goldCases.push(makeEvalCase());
  hoisted.savedEvalResults.length = 0;
  hoisted.registry.saveModel.mockClear();
  hoisted.registry.activateSnapshot.mockClear();
  hoisted.benchmarkRunStore.saveRun.mockClear();
  hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockReset();
  hoisted.buildTrainingExamplesMock.mockReset();
  hoisted.trainAllModelsMock.mockReset();
  hoisted.buildTrainingExamplesMock.mockReturnValue([{ label: 1 }]);
  hoisted.trainAllModelsMock.mockReturnValue(new Map([
    ['short_entity', { ndcg5ValidationScore: 0.93 }],
  ]));
  vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
});

describe('run-eval-and-train-ltr release gating', () => {
  const passingEvalGate: ReleaseGateResult = {
    passed: true,
    gates: [
      { name: 'minUtility', passed: true, actual: 0.8, threshold: 0.6 },
    ],
  };

  it('passes noisy entity release gate when all thresholds are met', () => {
    const gate = evaluateNoisyEntityReleaseGate(
      {
        benchmark: 'noisy-entity-benchmark',
        query_count: 20,
        recall_at_1: 0.95,
        recall_at_3: 1,
        mrr: 0.98,
        by_category: {},
        by_language: {},
        misses: [],
        provenance_checked_count: 2,
        provenance_match_rate: 1,
        provenance_misses: [],
        resolution_checked_count: 2,
        resolution_match_rate: 1,
        false_exact_rate: 0,
        resolution_misses: [],
        source: 'search-executor',
        evaluated_at: new Date().toISOString(),
      },
      {
        minRecallAt3: 1,
        minResolutionMatchRate: 1,
        minProvenanceMatchRate: 1,
        maxFalseExactRate: 0,
      },
    );

    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('fails combined release status when noisy entity gate fails even if eval gate passes', () => {
    const noisyGate = evaluateNoisyEntityReleaseGate(
      {
        benchmark: 'noisy-entity-benchmark',
        query_count: 20,
        recall_at_1: 0.8,
        recall_at_3: 0.9,
        mrr: 0.85,
        by_category: {},
        by_language: {},
        misses: [],
        provenance_checked_count: 2,
        provenance_match_rate: 0.5,
        provenance_misses: [],
        resolution_checked_count: 2,
        resolution_match_rate: 0.5,
        false_exact_rate: 0.25,
        resolution_misses: [],
        source: 'search-executor',
        evaluated_at: new Date().toISOString(),
      },
      {
        minRecallAt3: 1,
        minResolutionMatchRate: 1,
        minProvenanceMatchRate: 1,
        maxFalseExactRate: 0,
      },
    );

    const combined = combineReleaseGateStatuses(passingEvalGate, [noisyGate]);

    expect(noisyGate.passed).toBe(false);
    expect(combined.passed).toBe(false);
    expect(combined.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('noisy_entity_benchmark:recall_at_3=0.9000 is below required 1.0000'),
        expect.stringContaining('noisy_entity_benchmark:false_exact_rate=0.2500 is above allowed 0.0000'),
      ]),
    );
  });

  it('renders a markdown release summary with noisy slices and gate failures', () => {
    const markdown = buildEvalTrainingReleaseMarkdownSummary({
      generated_at: new Date().toISOString(),
      snapshot_id: 'snapshot-test',
      eval_dataset_version: 'pg_gold_set_store.v1',
      feature_schema_hash: 'feature-hash-test',
      evaluation_case_count: 12,
      trained_model_count: 1,
      noisy_entity_output_path: '/tmp/noisy-entity-eval-results.json',
      primary_eval_gate: passingEvalGate,
      auxiliary_gates: [{
        name: 'noisy_entity_benchmark',
        passed: false,
        failures: ['category.transliteration.recall_at_3=0.5000 is below required 1.0000'],
      }],
      combined_release_gate: {
        passed: false,
        failures: ['noisy_entity_benchmark:category.transliteration.recall_at_3=0.5000 is below required 1.0000'],
      },
      noisy_entity_metrics: {
        ...passingNoisyReport(),
      },
      activation: {
        status: 'shadow_only',
        activated_model_count: 0,
      },
    });

    expect(markdown).toContain('## Eval + LTR Release Summary');
    expect(markdown).toContain('### Noisy Category Slices');
    expect(markdown).toContain('### Failures');
    expect(markdown).toContain('category.transliteration.recall_at_3=0.5000');
  });

  it('fails combined release status when the primary eval gate fails', () => {
    const combined = combineReleaseGateStatuses(
      {
        passed: false,
        gates: [
          { name: 'maxWrongResolveRate', passed: false, actual: 0.05, threshold: 0.02 },
        ],
      },
      [],
    );

    expect(combined.passed).toBe(false);
    expect(combined.failures).toEqual([
      'eval:maxWrongResolveRate actual=0.0500 threshold=0.0200',
    ]);
  });

  it('skips activation when the primary eval gate fails even though models were trained', async () => {
    hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockResolvedValue(passingNoisyReport());
    const searchUseCase = {
      executeForEvaluation: vi.fn(async () => ({
        response: failingEvalSearchResponse(),
      })),
    };

    await expect(runEvaluationAndTraining(
      searchUseCase as never,
      {} as never,
      {
        snapshotId: 'snapshot-test',
        evalDatasetVersion: 'pg_gold_set_store.v1',
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        runtimeStatePath: '/tmp/nonexistent-runtime-search-snapshot.json',
        releaseSummaryOutput: '/tmp/eval-training-release-summary.json',
        releaseSummaryMarkdownOutput: '/tmp/eval-training-release-summary.md',
        noisyEntityMode: 'hybrid',
        noisyEntityConcurrency: 1,
        noisyEntityGateThresholds: {
          minRecallAt3: 1,
          minResolutionMatchRate: 1,
          minProvenanceMatchRate: 1,
          maxFalseExactRate: 0,
        },
      },
    )).rejects.toThrow(/Release gates failed/);

    expect(searchUseCase.executeForEvaluation).toHaveBeenCalledOnce();
    expect(hoisted.registry.saveModel).toHaveBeenCalledOnce();
    expect(hoisted.registry.activateSnapshot).not.toHaveBeenCalled();
  });

  it('skips activation when the noisy entity gate fails even if the primary eval gate passes', async () => {
    hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockResolvedValue({
      ...passingNoisyReport(),
      recall_at_3: 0.9,
      false_exact_rate: 0.25,
    });
    const searchUseCase = {
      executeForEvaluation: vi.fn(async () => ({
        response: passingSearchResponse(),
      })),
    };

    await expect(runEvaluationAndTraining(
      searchUseCase as never,
      {} as never,
      {
        snapshotId: 'snapshot-test',
        evalDatasetVersion: 'pg_gold_set_store.v1',
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        runtimeStatePath: '/tmp/nonexistent-runtime-search-snapshot.json',
        releaseSummaryOutput: '/tmp/eval-training-release-summary.json',
        releaseSummaryMarkdownOutput: '/tmp/eval-training-release-summary.md',
        noisyEntityMode: 'hybrid',
        noisyEntityConcurrency: 1,
        noisyEntityGateThresholds: {
          minRecallAt3: 1,
          minResolutionMatchRate: 1,
          minProvenanceMatchRate: 1,
          maxFalseExactRate: 0,
        },
      },
    )).rejects.toThrow(/noisy_entity_benchmark/);

    expect(searchUseCase.executeForEvaluation).toHaveBeenCalledOnce();
    expect(hoisted.registry.saveModel).toHaveBeenCalledOnce();
    expect(hoisted.registry.activateSnapshot).not.toHaveBeenCalled();
  });

  it('activates the snapshot when both primary eval and noisy gates pass', async () => {
    hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockResolvedValue(passingNoisyReport());
    const searchUseCase = {
      executeForEvaluation: vi.fn(async () => ({
        response: passingSearchResponse(),
      })),
    };

    await expect(runEvaluationAndTraining(
      searchUseCase as never,
      {} as never,
      {
        snapshotId: 'snapshot-test',
        evalDatasetVersion: 'pg_gold_set_store.v1',
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        runtimeStatePath: '/tmp/nonexistent-runtime-search-snapshot.json',
        releaseSummaryOutput: '/tmp/eval-training-release-summary.json',
        releaseSummaryMarkdownOutput: '/tmp/eval-training-release-summary.md',
        noisyEntityMode: 'hybrid',
        noisyEntityConcurrency: 1,
        noisyEntityGateThresholds: {
          minRecallAt3: 1,
          minResolutionMatchRate: 1,
          minProvenanceMatchRate: 1,
          maxFalseExactRate: 0,
        },
      },
    )).resolves.toBeUndefined();

    expect(searchUseCase.executeForEvaluation).toHaveBeenCalledOnce();
    expect(hoisted.registry.saveModel).toHaveBeenCalledOnce();
    expect(hoisted.registry.activateSnapshot).toHaveBeenCalledWith('snapshot-test');
    expect(hoisted.benchmarkRunStore.saveRun).toHaveBeenCalledWith(expect.objectContaining({
      benchmarkKind: 'noisy_entity',
      snapshotId: 'snapshot-test',
      queryCount: 20,
      recallAt3: 1,
      releaseGatePassed: true,
      activationStatus: 'activated',
    }));
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/eval-training-release-summary.json',
      expect.stringContaining('"snapshot_id": "snapshot-test"'),
      'utf8',
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/eval-training-release-summary.md',
      expect.stringContaining('## Eval + LTR Release Summary'),
      'utf8',
    );
  });
});
