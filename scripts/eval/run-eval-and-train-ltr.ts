/**
 * Complete evaluation and LTR training pipeline.
 *
 * Orchestrates:
 * 1. Load eval cases from database
 * 2. Run evaluation against search pipeline
 * 3. Collect results
 * 4. Train LambdaMART models per query class
 * 5. Store trained models
 * 6. Produce evaluation report with LTR metrics
 *
 * Epic 3 + Epic 4: Eval baseline + LambdaMART training
 */

import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { EvalRunner } from '../../src/domain/evaluation/service/eval-runner.js';
import type { ReleaseGateResult } from '../../src/domain/evaluation/service/eval-runner.js';
import { PgGoldSetStore } from '../../src/infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../../src/infrastructure/adapter/pg-eval-result-store.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';
import { SearchPipelineEvaluator } from '../../src/infrastructure/adapter/search-pipeline-evaluator.js';
import { buildTrainingExamples, trainAllModels } from '../../src/domain/ranking/training.js';
import { PgLtrModelRegistry } from '../../src/infrastructure/adapter/pg-ltr-model-registry.js';
import type { SearchUseCase } from '../../src/application/search/search.usecase.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { hashText } from '../../src/shared/utils/stable-json.js';
import {
  evaluateNoisyEntityBenchmarkWithSearchExecutor,
  getNoisyEntityQualityViolations,
  type NoisyEntityBenchmarkReport,
  type NoisyEntityBenchmarkThresholds,
} from './run-noisy-entity-eval.js';
import { atomicWriteFile } from '../etl/etl-utils.js';

const DEFAULT_EVAL_DATASET_VERSION = 'pg_gold_set_store.v1';
const DEFAULT_NOISY_ENTITY_INPUT = 'fixture://noisy_attribute_recovery';
const DEFAULT_NOISY_ENTITY_OUTPUT = resolveDataPath('data/noisy-entity-eval-results.json');
const DEFAULT_RELEASE_SUMMARY_OUTPUT = resolveDataPath('data/eval-training-release-summary.json');
const DEFAULT_RELEASE_SUMMARY_MARKDOWN_OUTPUT = resolveDataPath('data/eval-training-release-summary.md');
const DEFAULT_NOISY_ENTITY_GATE_THRESHOLDS = {
  minRecallAt3: 1,
  minResolutionMatchRate: 1,
  minProvenanceMatchRate: 1,
  maxFalseExactRate: 0,
  enforceMinRecallAt3ByCategory: true,
  enforceMinRecallAt3ByLanguage: true,
} satisfies Required<NoisyEntityBenchmarkThresholds>;

interface CliArgs {
  readonly snapshotId?: string;
  readonly evalDatasetVersion: string;
  readonly noisyEntityInput: string;
  readonly noisyEntityOutput: string;
  readonly runtimeStatePath: string;
  readonly releaseSummaryOutput: string;
  readonly releaseSummaryMarkdownOutput: string;
  readonly noisyEntityMode: 'auto' | 'hybrid' | 'entity';
  readonly noisyEntityConcurrency: number;
  readonly noisyEntityGateThresholds: NoisyEntityBenchmarkThresholds;
}

export interface AuxiliaryReleaseGateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface CombinedReleaseGateStatus {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface EvalTrainingReleaseSummary {
  readonly generated_at: string;
  readonly snapshot_id: string;
  readonly eval_dataset_version: string;
  readonly feature_schema_hash: string;
  readonly evaluation_case_count: number;
  readonly trained_model_count: number;
  readonly noisy_entity_output_path: string;
  readonly primary_eval_gate: ReleaseGateResult;
  readonly auxiliary_gates: readonly AuxiliaryReleaseGateResult[];
  readonly combined_release_gate: CombinedReleaseGateStatus;
  readonly noisy_entity_metrics: Pick<
    NoisyEntityBenchmarkReport,
    | 'query_count'
    | 'recall_at_1'
    | 'recall_at_3'
    | 'mrr'
    | 'by_category'
    | 'by_language'
    | 'provenance_checked_count'
    | 'provenance_match_rate'
    | 'resolution_checked_count'
    | 'resolution_match_rate'
    | 'false_exact_rate'
    | 'source'
    | 'evaluated_at'
  >;
  readonly activation: {
    readonly status: 'activated' | 'shadow_only';
    readonly activated_model_count: number;
  };
}

export interface RuntimeStateReleaseProvenanceLinkResult {
  readonly status: 'linked' | 'skipped';
  readonly runtimeStatePath: string;
  readonly reason?: string;
}

export function evaluateNoisyEntityReleaseGate(
  report: NoisyEntityBenchmarkReport,
  thresholds: NoisyEntityBenchmarkThresholds,
): AuxiliaryReleaseGateResult {
  const failures = getNoisyEntityQualityViolations(report, thresholds);
  return {
    name: 'noisy_entity_benchmark',
    passed: failures.length === 0,
    failures,
  };
}

export function combineReleaseGateStatuses(
  evalGate: ReleaseGateResult,
  auxiliaryGates: readonly AuxiliaryReleaseGateResult[],
): CombinedReleaseGateStatus {
  const failures = [
    ...evalGate.gates
      .filter((gate) => !gate.passed)
      .map((gate) => `eval:${gate.name} actual=${gate.actual.toFixed(4)} threshold=${gate.threshold.toFixed(4)}`),
    ...auxiliaryGates.flatMap((gate) =>
      gate.passed
        ? []
        : gate.failures.map((failure) => `${gate.name}:${failure}`)),
  ];

  return {
    passed: evalGate.passed && auxiliaryGates.every((gate) => gate.passed),
    failures,
  };
}

function buildEvalTrainingReleaseSummary(
  args: {
    readonly snapshotId: string;
    readonly evalDatasetVersion: string;
    readonly featureSchemaHash: string;
    readonly evaluationCaseCount: number;
    readonly trainedModelCount: number;
    readonly noisyEntityOutputPath: string;
    readonly evalGate: ReleaseGateResult;
    readonly auxiliaryGates: readonly AuxiliaryReleaseGateResult[];
    readonly combinedReleaseGate: CombinedReleaseGateStatus;
    readonly noisyEntityReport: NoisyEntityBenchmarkReport;
    readonly activationStatus: EvalTrainingReleaseSummary['activation']['status'];
    readonly activatedModelCount: number;
  },
): EvalTrainingReleaseSummary {
  return {
    generated_at: new Date().toISOString(),
    snapshot_id: args.snapshotId,
    eval_dataset_version: args.evalDatasetVersion,
    feature_schema_hash: args.featureSchemaHash,
    evaluation_case_count: args.evaluationCaseCount,
    trained_model_count: args.trainedModelCount,
    noisy_entity_output_path: args.noisyEntityOutputPath,
    primary_eval_gate: args.evalGate,
    auxiliary_gates: args.auxiliaryGates,
    combined_release_gate: args.combinedReleaseGate,
    noisy_entity_metrics: {
      query_count: args.noisyEntityReport.query_count,
      recall_at_1: args.noisyEntityReport.recall_at_1,
      recall_at_3: args.noisyEntityReport.recall_at_3,
      mrr: args.noisyEntityReport.mrr,
      by_category: args.noisyEntityReport.by_category,
      by_language: args.noisyEntityReport.by_language,
      provenance_checked_count: args.noisyEntityReport.provenance_checked_count,
      provenance_match_rate: args.noisyEntityReport.provenance_match_rate,
      resolution_checked_count: args.noisyEntityReport.resolution_checked_count,
      resolution_match_rate: args.noisyEntityReport.resolution_match_rate,
      false_exact_rate: args.noisyEntityReport.false_exact_rate,
      source: args.noisyEntityReport.source,
      evaluated_at: args.noisyEntityReport.evaluated_at,
    },
    activation: {
      status: args.activationStatus,
      activated_model_count: args.activatedModelCount,
    },
  };
}

export function buildEvalTrainingReleaseMarkdownSummary(
  summary: EvalTrainingReleaseSummary,
): string {
  const lines: string[] = [
    '## Eval + LTR Release Summary',
    '',
    `- Snapshot: \`${summary.snapshot_id}\``,
    `- Eval dataset: \`${summary.eval_dataset_version}\``,
    `- Feature schema hash: \`${summary.feature_schema_hash}\``,
    `- Eval cases: \`${summary.evaluation_case_count}\``,
    `- Trained models: \`${summary.trained_model_count}\``,
    `- Release gate: \`${summary.combined_release_gate.passed ? 'passed' : 'failed'}\``,
    `- Activation: \`${summary.activation.status}\` (${summary.activation.activated_model_count})`,
    `- Noisy report: \`${summary.noisy_entity_output_path}\``,
    '',
    '### Noisy Entity',
    '',
    `- Queries: \`${summary.noisy_entity_metrics.query_count}\``,
    `- Recall@1: \`${summary.noisy_entity_metrics.recall_at_1.toFixed(4)}\``,
    `- Recall@3: \`${summary.noisy_entity_metrics.recall_at_3.toFixed(4)}\``,
    `- MRR: \`${summary.noisy_entity_metrics.mrr.toFixed(4)}\``,
    `- Provenance match: \`${summary.noisy_entity_metrics.provenance_match_rate === null ? 'n/a' : summary.noisy_entity_metrics.provenance_match_rate.toFixed(4)}\``,
    `- Resolution match: \`${summary.noisy_entity_metrics.resolution_match_rate === null ? 'n/a' : summary.noisy_entity_metrics.resolution_match_rate.toFixed(4)}\``,
    `- False exact: \`${summary.noisy_entity_metrics.false_exact_rate === null ? 'n/a' : summary.noisy_entity_metrics.false_exact_rate.toFixed(4)}\``,
  ];

  const categoryLines = Object.entries(summary.noisy_entity_metrics.by_category)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([category, metrics]) =>
      `- \`${category}\`: n=${metrics.query_count}, recall@3=${metrics.recall_at_3.toFixed(4)}, mrr=${metrics.mrr.toFixed(4)}`,
    );
  if (categoryLines.length > 0) {
    lines.push('', '### Noisy Category Slices', '', ...categoryLines);
  }

  const languageLines = Object.entries(summary.noisy_entity_metrics.by_language)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([language, metrics]) =>
      `- \`${language}\`: n=${metrics.query_count}, recall@3=${metrics.recall_at_3.toFixed(4)}, mrr=${metrics.mrr.toFixed(4)}`,
    );
  if (languageLines.length > 0) {
    lines.push('', '### Noisy Language Slices', '', ...languageLines);
  }

  if (summary.combined_release_gate.failures.length > 0) {
    lines.push('', '### Failures', '', ...summary.combined_release_gate.failures.map((failure) => `- ${failure}`));
  }

  return `${lines.join('\n')}\n`;
}

export async function linkEvalTrainingReleaseToRuntimeState(
  args: {
    readonly runtimeStatePath: string;
    readonly snapshotId: string;
    readonly evalDatasetVersion: string;
    readonly featureSchemaHash: string;
    readonly noisyEntityOutputPath: string;
    readonly releaseSummaryOutput: string;
    readonly releaseSummaryMarkdownOutput: string;
    readonly combinedReleaseGatePassed: boolean;
    readonly activationStatus: EvalTrainingReleaseSummary['activation']['status'];
  },
): Promise<RuntimeStateReleaseProvenanceLinkResult> {
  let runtimeStateRaw: string;
  try {
    runtimeStateRaw = await fs.readFile(args.runtimeStatePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'skipped',
        runtimeStatePath: args.runtimeStatePath,
        reason: 'runtime_state_missing',
      };
    }
    throw error;
  }

  const runtimeState = await loadSearchSnapshotRuntimeState(args.runtimeStatePath);
  if (runtimeState.snapshotId !== args.snapshotId) {
    return {
      status: 'skipped',
      runtimeStatePath: args.runtimeStatePath,
      reason: `runtime_snapshot_mismatch:${runtimeState.snapshotId}`,
    };
  }

  const [noisyEntityRaw, summaryJsonRaw, summaryMarkdownRaw] = await Promise.all([
    fs.readFile(args.noisyEntityOutputPath, 'utf8'),
    fs.readFile(args.releaseSummaryOutput, 'utf8'),
    fs.readFile(args.releaseSummaryMarkdownOutput, 'utf8'),
  ]);
  const parsedRuntimeState = JSON.parse(runtimeStateRaw) as Record<string, unknown>;
  const nextRuntimeState = {
    ...parsedRuntimeState,
    ltrReleaseProvenance: {
      updatedAt: new Date().toISOString(),
      evalDatasetVersion: args.evalDatasetVersion,
      featureSchemaHash: args.featureSchemaHash,
      summaryJsonPath: args.releaseSummaryOutput,
      summaryJsonHash: hashText(summaryJsonRaw),
      summaryMarkdownPath: args.releaseSummaryMarkdownOutput,
      summaryMarkdownHash: hashText(summaryMarkdownRaw),
      noisyEntityOutputPath: args.noisyEntityOutputPath,
      noisyEntityOutputHash: hashText(noisyEntityRaw),
      combinedReleaseGatePassed: args.combinedReleaseGatePassed,
      activationStatus: args.activationStatus,
    },
  };
  await atomicWriteFile(args.runtimeStatePath, `${JSON.stringify(nextRuntimeState, null, 2)}\n`);
  return {
    status: 'linked',
    runtimeStatePath: args.runtimeStatePath,
  };
}

function parseArgs(argv: readonly string[]): CliArgs {
  let snapshotId: string | undefined;
  let evalDatasetVersion = DEFAULT_EVAL_DATASET_VERSION;
  let noisyEntityInput = DEFAULT_NOISY_ENTITY_INPUT;
  let noisyEntityOutput = DEFAULT_NOISY_ENTITY_OUTPUT;
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let releaseSummaryOutput = DEFAULT_RELEASE_SUMMARY_OUTPUT;
  let releaseSummaryMarkdownOutput = DEFAULT_RELEASE_SUMMARY_MARKDOWN_OUTPUT;
  let noisyEntityMode: CliArgs['noisyEntityMode'] = 'hybrid';
  let noisyEntityConcurrency = 4;
  let noisyEntityGateThresholds: NoisyEntityBenchmarkThresholds = {
    ...DEFAULT_NOISY_ENTITY_GATE_THRESHOLDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot-id') {
      snapshotId = argv[index + 1] ?? undefined;
      index += 1;
    } else if (arg === '--eval-dataset-version') {
      evalDatasetVersion = argv[index + 1] ?? DEFAULT_EVAL_DATASET_VERSION;
      index += 1;
    } else if (arg === '--noisy-entity-input') {
      noisyEntityInput = argv[index + 1] ?? DEFAULT_NOISY_ENTITY_INPUT;
      index += 1;
    } else if (arg === '--noisy-entity-output') {
      noisyEntityOutput = argv[index + 1] ?? DEFAULT_NOISY_ENTITY_OUTPUT;
      index += 1;
    } else if (arg === '--runtime-state-path') {
      runtimeStatePath = argv[index + 1] ?? DEFAULT_RUNTIME_STATE_PATH;
      index += 1;
    } else if (arg === '--release-summary-output') {
      releaseSummaryOutput = argv[index + 1] ?? DEFAULT_RELEASE_SUMMARY_OUTPUT;
      index += 1;
    } else if (arg === '--release-summary-markdown-output') {
      releaseSummaryMarkdownOutput = argv[index + 1] ?? DEFAULT_RELEASE_SUMMARY_MARKDOWN_OUTPUT;
      index += 1;
    } else if (arg === '--noisy-entity-mode') {
      const value = argv[index + 1];
      if (value === 'auto' || value === 'hybrid' || value === 'entity') {
        noisyEntityMode = value;
      }
      index += 1;
    } else if (arg === '--noisy-entity-concurrency') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(value) && value >= 1) {
        noisyEntityConcurrency = Math.min(16, value);
      }
      index += 1;
    } else if (arg === '--noisy-min-recall-at-3') {
      const value = Number.parseFloat(argv[index + 1] ?? '');
      if (Number.isFinite(value)) {
        noisyEntityGateThresholds = { ...noisyEntityGateThresholds, minRecallAt3: value };
      }
      index += 1;
    } else if (arg === '--noisy-min-resolution-match-rate') {
      const value = Number.parseFloat(argv[index + 1] ?? '');
      if (Number.isFinite(value)) {
        noisyEntityGateThresholds = { ...noisyEntityGateThresholds, minResolutionMatchRate: value };
      }
      index += 1;
    } else if (arg === '--noisy-min-provenance-match-rate') {
      const value = Number.parseFloat(argv[index + 1] ?? '');
      if (Number.isFinite(value)) {
        noisyEntityGateThresholds = { ...noisyEntityGateThresholds, minProvenanceMatchRate: value };
      }
      index += 1;
    } else if (arg === '--noisy-max-false-exact-rate') {
      const value = Number.parseFloat(argv[index + 1] ?? '');
      if (Number.isFinite(value)) {
        noisyEntityGateThresholds = { ...noisyEntityGateThresholds, maxFalseExactRate: value };
      }
      index += 1;
    } else if (arg === '--noisy-enforce-min-recall-at-3-by-category') {
      noisyEntityGateThresholds = { ...noisyEntityGateThresholds, enforceMinRecallAt3ByCategory: true };
    } else if (arg === '--noisy-enforce-min-recall-at-3-by-language') {
      noisyEntityGateThresholds = { ...noisyEntityGateThresholds, enforceMinRecallAt3ByLanguage: true };
    }
  }

  return {
    snapshotId,
    evalDatasetVersion,
    noisyEntityInput,
    noisyEntityOutput,
    runtimeStatePath,
    releaseSummaryOutput,
    releaseSummaryMarkdownOutput,
    noisyEntityMode,
    noisyEntityConcurrency,
    noisyEntityGateThresholds,
  };
}

/**
 * Main evaluation pipeline.
 *
 * @param searchUseCase - The wired SearchUseCase (from container).
 * @param pool - Postgres pool instance (caller manages lifecycle).
 */
async function runEvaluationAndTraining(
  searchUseCase: SearchUseCase,
  pool: Pool,
  args: CliArgs,
): Promise<void> {
  const searchSnapshotId = args.snapshotId ?? (await loadSearchSnapshotRuntimeState()).snapshotId;
  const featureSchemaHash = getCurrentFeatureSchemaHash();
  {
    console.log('🚀 Starting Evaluation + LTR Training Pipeline\n');
    console.log('='.repeat(60));
    console.log(`🔒 Binding trained models to search snapshot: ${searchSnapshotId}`);
    console.log(`🧪 Eval dataset version: ${args.evalDatasetVersion}`);
    console.log(`🧬 Feature schema hash: ${featureSchemaHash}`);

    // Step 1: Load evaluation cases
    console.log('\n📖 Step 1: Loading evaluation cases from database...');
    const goldSetStore = new PgGoldSetStore(pool);
    const cases = await goldSetStore.getCases();
    console.log(`   ✓ Loaded ${cases.length} evaluation cases`);

    // Distribution by query class
    const classDistribution = new Map<string, number>();
    for (const c of cases) {
      classDistribution.set(c.queryClass, (classDistribution.get(c.queryClass) ?? 0) + 1);
    }
    console.log('\n   Query class distribution:');
    for (const [queryClass, count] of Array.from(classDistribution.entries()).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`     ${queryClass}: ${count} cases`);
    }

    // Distribution by label tier
    const tierDistribution = new Map<string, number>();
    for (const c of cases) {
      tierDistribution.set(c.labelTier, (tierDistribution.get(c.labelTier) ?? 0) + 1);
    }
    console.log('\n   Label tier distribution:');
    for (const [tier, count] of tierDistribution.entries()) {
      console.log(`     ${tier}: ${count} cases`);
    }

    // Step 2: Run evaluation
    console.log('\n📊 Step 2: Running evaluation...');
    const evalResultStore = new PgEvalResultStore(pool);
    const searchPipeline = new SearchPipelineEvaluator(searchUseCase);
    const evalRunner = new EvalRunner(goldSetStore, evalResultStore, searchPipeline);

    const evalReport = await evalRunner.run();
    console.log(`   ✓ Evaluated ${evalReport.caseCount} cases`);

    // Summary metrics
    console.log('\n   📈 Overall metrics:');
    console.log(`     Decision Utility: ${evalReport.overallMetrics.decisionUtility.toFixed(3)}`);
    console.log(`     Correct Resolve Rate: ${(evalReport.overallMetrics.correctResolveRate * 100).toFixed(1)}%`);
    console.log(`     Wrong Resolve Rate: ${(evalReport.overallMetrics.wrongResolveRate * 100).toFixed(2)}%`);
    console.log(`     Safe Abstain Rate: ${(evalReport.overallMetrics.safeAbstainRate * 100).toFixed(1)}%`);
    console.log(`     Expected Calibration Error (ECE): ${evalReport.overallMetrics.ece.toFixed(3)}`);

    // Release gate status
    console.log('\n   🚪 Release Gate Results:');
    if (evalReport.releaseGateResult.passed) {
      console.log('     ✅ ALL GATES PASSED');
    } else {
      console.log('     ❌ SOME GATES FAILED:');
      for (const gate of evalReport.releaseGateResult.gates) {
        if (!gate.passed) {
          console.log(
            `        ${gate.name}: ${gate.actual.toFixed(3)} (threshold: ${gate.threshold})`,
          );
        }
      }
    }

    console.log('\n🧪 Step 2b: Running noisy entity benchmark gate...');
    const noisyEntityReport = await evaluateNoisyEntityBenchmarkWithSearchExecutor(searchUseCase, {
      input: args.noisyEntityInput,
      mode: args.noisyEntityMode,
      concurrency: args.noisyEntityConcurrency,
    });
    await fs.writeFile(args.noisyEntityOutput, `${JSON.stringify(noisyEntityReport, null, 2)}\n`, 'utf8');
    const noisyEntityGate = evaluateNoisyEntityReleaseGate(
      noisyEntityReport,
      args.noisyEntityGateThresholds,
    );
    console.log(`   ✓ Evaluated ${noisyEntityReport.query_count} noisy entity cases`);
    console.log(`     recall@1: ${noisyEntityReport.recall_at_1.toFixed(3)}`);
    console.log(`     recall@3: ${noisyEntityReport.recall_at_3.toFixed(3)}`);
    console.log(`     mrr: ${noisyEntityReport.mrr.toFixed(3)}`);
    console.log(`     output: ${args.noisyEntityOutput}`);
    if (noisyEntityGate.passed) {
      console.log('     ✅ noisy entity gate passed');
    } else {
      console.log('     ❌ noisy entity gate failed:');
      for (const failure of noisyEntityGate.failures) {
        console.log(`        ${failure}`);
      }
    }

    const combinedReleaseGate = combineReleaseGateStatuses(
      evalReport.releaseGateResult,
      [noisyEntityGate],
    );

    // Step 3: Build training examples from evaluation results
    console.log('\n🧠 Step 3: Building LambdaMART training examples...');
    const results = await evalResultStore.getResults();
    const examples = buildTrainingExamples(results, cases);
    console.log(`   ✓ Built ${examples.length} training examples`);

    // Step 4: Train LambdaMART models per query class
    console.log('\n🎓 Step 4: Training LambdaMART models...');
    let storedModelCount = 0;
    let activatedModelCount = 0;
    let activationStatus: EvalTrainingReleaseSummary['activation']['status'] = 'shadow_only';

    if (examples.length > 0) {
      const models = trainAllModels(examples);

      if (models.size > 0) {
        console.log(`   ✓ Trained models for ${models.size} query classes`);

        // Step 5: Store trained models in registry
        console.log('\n💾 Step 5: Persisting trained models to database...');
        const modelRegistry = new PgLtrModelRegistry(pool);

        let storedCount = 0;
        for (const [queryClass, weights] of models.entries()) {
          await modelRegistry.saveModel(queryClass, weights, {
            searchSnapshotId,
            evalDatasetVersion: args.evalDatasetVersion,
            featureSchemaHash,
            activate: false,
          });
          storedCount++;
          console.log(
            `   ✓ Stored model for ${queryClass} (NDCG@5: ${weights.ndcg5ValidationScore.toFixed(3)})`,
          );
        }
        storedModelCount = storedCount;

        if (combinedReleaseGate.passed) {
          activatedModelCount = await modelRegistry.activateSnapshot(searchSnapshotId);
          activationStatus = 'activated';
          console.log(`   ✓ Activated ${activatedModelCount} LTR models for snapshot ${searchSnapshotId}`);
        } else {
          console.log('   ⚠️  Skipped activation because release gates failed; models remain shadow-only');
        }

        console.log(`   ✓ Persisted ${storedCount} models to ltr_model_registry`);
      } else {
        console.log('   ⚠️  No models trained (insufficient examples per class)');
      }
    } else {
      console.log('   ⚠️  No training examples generated (eval results needed)');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Evaluation + LTR Training Pipeline Complete\n');
    console.log('📋 Summary:');
    console.log(`   • Evaluation Cases: ${cases.length}`);
    console.log(`   • Evaluation Status: ${combinedReleaseGate.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   • Query Classes: ${classDistribution.size}`);
    console.log('');

    const releaseSummary = buildEvalTrainingReleaseSummary({
      snapshotId: searchSnapshotId,
      evalDatasetVersion: args.evalDatasetVersion,
      featureSchemaHash,
      evaluationCaseCount: cases.length,
      trainedModelCount: storedModelCount,
      noisyEntityOutputPath: args.noisyEntityOutput,
      evalGate: evalReport.releaseGateResult,
      auxiliaryGates: [noisyEntityGate],
      combinedReleaseGate,
      noisyEntityReport,
      activationStatus,
      activatedModelCount,
    });
    await fs.writeFile(args.releaseSummaryOutput, `${JSON.stringify(releaseSummary, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      args.releaseSummaryMarkdownOutput,
      buildEvalTrainingReleaseMarkdownSummary(releaseSummary),
      'utf8',
    );
    const evalBenchmarkRunStore = new PgEvalBenchmarkRunStore(pool);
    await evalBenchmarkRunStore.saveRun({
      benchmarkKind: 'noisy_entity',
      snapshotId: searchSnapshotId,
      evalDatasetVersion: args.evalDatasetVersion,
      featureSchemaHash,
      queryCount: noisyEntityReport.query_count,
      recallAt1: noisyEntityReport.recall_at_1,
      recallAt3: noisyEntityReport.recall_at_3,
      mrr: noisyEntityReport.mrr,
      ...(noisyEntityReport.false_exact_rate === null
        ? {}
        : { falseExactRate: noisyEntityReport.false_exact_rate }),
      releaseGatePassed: combinedReleaseGate.passed,
      activationStatus,
      report: noisyEntityReport as unknown as Readonly<Record<string, unknown>>,
    });
    const runtimeStateLinkResult = await linkEvalTrainingReleaseToRuntimeState({
      runtimeStatePath: args.runtimeStatePath,
      snapshotId: searchSnapshotId,
      evalDatasetVersion: args.evalDatasetVersion,
      featureSchemaHash,
      noisyEntityOutputPath: args.noisyEntityOutput,
      releaseSummaryOutput: args.releaseSummaryOutput,
      releaseSummaryMarkdownOutput: args.releaseSummaryMarkdownOutput,
      combinedReleaseGatePassed: combinedReleaseGate.passed,
      activationStatus,
    });
    if (runtimeStateLinkResult.status === 'linked') {
      console.log(`   • Runtime Release Provenance: linked (${runtimeStateLinkResult.runtimeStatePath})`);
    } else {
      console.log(
        `   • Runtime Release Provenance: skipped (${runtimeStateLinkResult.reason ?? 'unknown'})`,
      );
    }

    if (!combinedReleaseGate.passed) {
      throw new Error(`Release gates failed:\n- ${combinedReleaseGate.failures.join('\n- ')}`);
    }
  }
}

// Entry point (for CLI use)
// Usage: npx tsx scripts/eval/run-eval-and-train-ltr.ts
// Requires: PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD env vars
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    // Bootstrap the DI container to get a wired SearchUseCase
    const { config } = await import('../../src/config/env.js');
    const { createContainer } = await import('../../src/config/container.js');
    const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');

    const pool = getPgPool();
    const container = await createContainer(config, pool);

    await runEvaluationAndTraining(container.searchUseCase, pool, args);
    await pool.end();
  })().catch((err: unknown) => {
    console.error('❌ Pipeline failed:', err);
    process.exit(1);
  });
}

export { runEvaluationAndTraining };
