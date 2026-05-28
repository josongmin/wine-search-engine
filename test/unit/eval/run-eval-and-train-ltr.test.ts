import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEvalTrainingRuntimeHandles,
  buildEvalTrainingReleaseMarkdownSummary,
  combineReleaseGateStatuses,
  evaluateNoisyEntityReleaseGate,
  linkEvalTrainingReleaseToRuntimeState,
  parseArgs,
  resolveEvalTrainingArtifactPaths,
  runEvaluationAndTraining,
  stageEvalTrainingSnapshotRuntimeSubstrates,
} from '../../../scripts/eval/run-eval-and-train-ltr.ts';
import type { ReleaseGateResult } from '../../../src/domain/evaluation/service/eval-runner.js';
import type { EvalCase } from '../../../src/domain/evaluation/model/eval-case.js';
import { createCanonicalEntityId } from '../../../src/domain/shared/types/index.js';

const hoisted = vi.hoisted(() => ({
  goldCases: [] as EvalCase[],
  getCasesFilters: [] as unknown[],
  savedEvalResults: [] as unknown[],
  registry: {
    saveModel: vi.fn(async () => {}),
    activateSnapshot: vi.fn(async () => 1),
  },
  benchmarkRunStore: {
    saveRun: vi.fn(async () => {}),
  },
  stageSnapshotRuntimeSubstratesToPgMock: vi.fn(async () => ({
    snapshotId: 'search-snapshot:v1:test',
    entities: 1,
    aliases: 1,
    ambiguityRegistry: 0,
  })),
  evaluateNoisyEntityBenchmarkWithSearchExecutorMock: vi.fn(),
  buildTrainingExamplesMock: vi.fn(),
  trainAllModelsMock: vi.fn(),
}));

vi.mock('../../../src/infrastructure/adapter/pg-gold-set-store.js', () => ({
  PgGoldSetStore: class {
    async getCases(filter?: unknown) {
      hoisted.getCasesFilters.push(filter);
      return hoisted.goldCases;
    }
  },
}));

vi.mock('../../../src/infrastructure/adapter/pg-eval-result-store.js', () => ({
  PgEvalResultStore: class {
    async saveResult(result: unknown) {
      hoisted.savedEvalResults.push(result);
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

vi.mock('../../../scripts/etl/publish-runtime-substrates.js', () => ({
  stageSnapshotRuntimeSubstratesToPg: hoisted.stageSnapshotRuntimeSubstratesToPgMock,
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
  hoisted.getCasesFilters.length = 0;
  hoisted.savedEvalResults.length = 0;
  hoisted.registry.saveModel.mockClear();
  hoisted.registry.activateSnapshot.mockClear();
  hoisted.benchmarkRunStore.saveRun.mockClear();
  hoisted.stageSnapshotRuntimeSubstratesToPgMock.mockClear();
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
  it('defaults noisy entity mode to auto for release gating', () => {
    const parsed = parseArgs([]);
    expect(parsed.noisyEntityMode).toBe('auto');
  });

  it('keeps explicit noisy entity mode overrides', () => {
    const parsed = parseArgs(['--noisy-entity-mode', 'hybrid']);
    expect(parsed.noisyEntityMode).toBe('hybrid');
  });

  it('parses eval case filters and partial-run flags', () => {
    const parsed = parseArgs([
      '--query-class', 'exact_entity',
      '--slice-tag', 'mixed_constraint_guided_hybrid_fallback',
      '--label-tier', 'gold',
      '--since', '2026-05-27T00:00:00.000Z',
      '--case-limit', '12',
      '--skip-noisy-entity',
    ]);

    expect(parsed.evalCaseFilter).toMatchObject({
      queryClass: 'exact_entity',
      sliceTag: 'mixed_constraint_guided_hybrid_fallback',
      labelTier: 'gold',
    });
    expect(parsed.evalCaseFilter.since?.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(parsed.caseLimit).toBe(12);
    expect(parsed.skipNoisyEntity).toBe(true);
  });

  it('rewrites canonical release artifacts onto partial-debug paths for partial runs', () => {
    const parsed = parseArgs([
      '--query-class', 'exact_entity',
      '--case-limit', '1',
      '--skip-noisy-entity',
    ]);

    const resolved = resolveEvalTrainingArtifactPaths({
      partialDebugRun: true,
      noisyEntityOutput: parsed.noisyEntityOutput,
      releaseSummaryOutput: parsed.releaseSummaryOutput,
      releaseSummaryMarkdownOutput: parsed.releaseSummaryMarkdownOutput,
    });

    expect(resolved.noisyEntityOutputPath).toContain('.partial-debug.json');
    expect(resolved.releaseSummaryOutputPath).toContain('.partial-debug.json');
    expect(resolved.releaseSummaryMarkdownOutputPath).toContain('.partial-debug.md');
  });

  it('builds snapshot-scoped runtime handles from the target manifest for non-active eval runs', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-training-runtime-'));
    const snapshotId = 'search-snapshot:v1:target';
    const snapshotDir = path.join(tempDir, snapshotId);
    await fs.mkdir(snapshotDir, { recursive: true });
    await realFs.writeFile(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId,
        generatedAt: '2026-05-27T00:00:00.000Z',
        contentHash: 'target-hash',
        sourceInputPath: '/tmp/input.ndjson',
        artifacts: {
          documentsNdjson: '/tmp/documents.ndjson',
          vespaFeedNdjson: '/tmp/vespa-feed.ndjson',
          entitiesNdjson: '/tmp/entities.ndjson',
          aliasesNdjson: '/tmp/aliases.ndjson',
          ambiguityRegistryNdjson: '/tmp/ambiguity.ndjson',
          nlMappingsJson: '/tmp/nl-mappings.json',
          metadataJson: '/tmp/metadata.json',
        },
        counts: {
          documents: 1,
          vespaFeed: 1,
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 1,
        },
        hashes: {
          documents: 'd',
          vespaFeed: 'v',
          entities: 'e',
          aliases: 'a',
          ambiguityRegistry: 'r',
          nlMappings: 'n',
        },
        fieldAvailability: {
          appellation: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
          body: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
          sweetness: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
          acidity: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
          tannin: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
        },
        quality: {
          status: 'canonical',
          blockers: [],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      }, null, 2),
      'utf8',
    );

    try {
      const handles = await buildEvalTrainingRuntimeHandles({
        pool: {} as never,
        snapshotId,
        snapshotRootDir: tempDir,
      });
      expect(handles).toMatchObject({
        searchSnapshotId: snapshotId,
        searchSnapshotManifestPath: path.join(tempDir, snapshotId, 'manifest.json'),
        searchSnapshotFieldAvailability: {
          appellation: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
          body: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('stages snapshot-bound PG substrates before target-snapshot eval/train boot', async () => {
    await stageEvalTrainingSnapshotRuntimeSubstrates({
      snapshotId: 'search-snapshot:v1:target',
      snapshotRootDir: '/tmp/search-snapshots',
    });

    expect(hoisted.stageSnapshotRuntimeSubstratesToPgMock).toHaveBeenCalledWith({
      manifestPath: '/tmp/search-snapshots/search-snapshot:v1:target/manifest.json',
      allowExistingActiveSnapshot: true,
    });
  });

  it('skips PG substrate staging when no snapshot override is requested', async () => {
    await stageEvalTrainingSnapshotRuntimeSubstrates({});

    expect(hoisted.stageSnapshotRuntimeSubstratesToPgMock).not.toHaveBeenCalled();
  });

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
        evalCaseFilter: {},
        caseLimit: undefined,
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        skipNoisyEntity: false,
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
        evalCaseFilter: {},
        caseLimit: undefined,
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        skipNoisyEntity: false,
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
        evalCaseFilter: {},
        caseLimit: undefined,
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        skipNoisyEntity: false,
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
      queryCount: 20,
      recallAt3: 1,
      provenance: expect.objectContaining({
        searchSnapshotId: 'snapshot-test',
        suiteGatePassed: true,
        runtimeActivationStatus: 'activated',
      }),
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

  it('keeps filtered partial runs shadow-only even when eval passes', async () => {
    hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockResolvedValue(passingNoisyReport());
    const searchUseCase = {
      executeForEvaluation: vi.fn(async () => ({
        response: passingSearchResponse(),
      })),
    };
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const parsed = parseArgs([
      '--query-class', 'exact_entity',
      '--slice-tag', 'mixed_constraint_guided_hybrid_fallback',
      '--case-limit', '1',
      '--skip-noisy-entity',
    ]);

    await expect(runEvaluationAndTraining(
      searchUseCase as never,
      {} as never,
      {
        snapshotId: 'snapshot-test',
        ...parsed,
        evalCaseFilter: { queryClass: 'exact_entity', sliceTag: 'mixed_constraint_guided_hybrid_fallback' },
        runtimeStatePath: '/tmp/nonexistent-runtime-search-snapshot.json',
        noisyEntityGateThresholds: {
          minRecallAt3: 1,
          minResolutionMatchRate: 1,
          minProvenanceMatchRate: 1,
          maxFalseExactRate: 0,
        },
      },
    )).resolves.toBeUndefined();

    expect(hoisted.getCasesFilters).toEqual([
      expect.objectContaining({
        queryClass: 'exact_entity',
        sliceTag: 'mixed_constraint_guided_hybrid_fallback',
      }),
    ]);
    expect(hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock).not.toHaveBeenCalled();
    expect(hoisted.registry.saveModel).not.toHaveBeenCalled();
    expect(hoisted.registry.activateSnapshot).not.toHaveBeenCalled();
    expect(hoisted.benchmarkRunStore.saveRun).toHaveBeenCalledWith(expect.objectContaining({
      queryCount: 0,
      provenance: expect.objectContaining({
        runtimeActivationStatus: 'shadow_only',
        suiteGatePassed: true,
      }),
    }));
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('eval-training-release-summary.partial-debug.json'),
      expect.any(String),
      'utf8',
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('eval-training-release-summary.partial-debug.md'),
      expect.any(String),
      'utf8',
    );
    expect(readFileSpy).not.toHaveBeenCalledWith('/tmp/nonexistent-runtime-search-snapshot.json', 'utf8');
  });

  it('builds training examples from the in-memory eval report, not a schema-dependent DB reread', async () => {
    hoisted.evaluateNoisyEntityBenchmarkWithSearchExecutorMock.mockResolvedValue(passingNoisyReport());
    const searchUseCase = {
      executeForEvaluation: vi.fn(async () => ({
        response: passingSearchResponse(),
        runtimeClassification: {
          queryClass: 'short_entity',
          intent: 'entity_exact',
          route: 'hybrid',
          retrievalMode: 'attribute_search',
        },
      })),
    };

    await expect(runEvaluationAndTraining(
      searchUseCase as never,
      {} as never,
      {
        snapshotId: 'snapshot-test',
        evalDatasetVersion: 'pg_gold_set_store.v1',
        evalCaseFilter: {},
        caseLimit: undefined,
        noisyEntityInput: 'fixture://noisy_attribute_recovery',
        noisyEntityOutput: '/tmp/noisy-entity-eval-results.json',
        skipNoisyEntity: true,
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

    expect(hoisted.buildTrainingExamplesMock).toHaveBeenCalledOnce();
    expect(hoisted.buildTrainingExamplesMock.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        runtimeQueryClass: 'short_entity',
      }),
    ]);
    expect(hoisted.registry.saveModel).not.toHaveBeenCalled();
  });
});

describe('linkEvalTrainingReleaseToRuntimeState', () => {
  it('skips malformed runtime state instead of failing the whole training pipeline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ltr-runtime-link-'));
    const runtimeStatePath = path.join(dir, 'runtime-state.json');
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath) => {
      if (typeof filePath === 'string' && filePath === runtimeStatePath) {
        return '{"schemaVersion":"broken"}';
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = await linkEvalTrainingReleaseToRuntimeState({
      runtimeStatePath,
      snapshotId: 'search-snapshot:v1:test',
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash',
      noisyEntityOutputPath: path.join(dir, 'noisy.json'),
      releaseSummaryOutput: path.join(dir, 'summary.json'),
      releaseSummaryMarkdownOutput: path.join(dir, 'summary.md'),
      combinedReleaseGatePassed: true,
      activationStatus: 'activated',
    });
    readFileSpy.mockRestore();

    expect(result.status).toBe('skipped');
    expect(result.reason?.startsWith('runtime_state_unreadable:')).toBe(true);
  });
});
