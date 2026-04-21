#!/usr/bin/env tsx
/**
 * Noisy Entity Benchmark Eval Runner.
 *
 * Reads the noisy entity benchmark JSONL artifact and scores either:
 * - live search API responses, or
 * - a captured predictions JSONL file with ranked entity IDs
 *
 * Metrics:
 * - Recall@1
 * - Recall@3
 * - MRR
 * Plus per-category and per-language slices for the benchmark.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import { parseNdjson } from '../etl/ndjson.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  ENTITY_RETRIEVAL_SUITE_IDS,
  loadEntityRetrievalFixtureCases,
  parseSuiteIdList,
  type EntityRetrievalSuiteId,
} from './external-fixture-benchmark.js';
import {
  buildBenchmarkRequestHeaders,
  resolveBenchmarkSearchEndpoint,
  runLiveBenchmarkPreflight,
  type BenchmarkExecutionLane,
} from './live-benchmark-preflight.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const NOISY_ENTITY_CATEGORIES = [
  'typo',
  'accent_stripped',
  'whitespace_collapse_split',
  'abbreviation',
  'transliteration',
  'phonetic',
  'producer_label_partial',
  'vintage_partial',
  'mixed_language',
  'noisy_short_form',
  'adversarial_near_miss',
] as const;

export const NOISY_ENTITY_PROVENANCE_STAGES = [
  'exact',
  'lexical',
  'phonetic',
  'transliteration',
  'semantic',
] as const;

export const NOISY_ENTITY_DECISION_STATUSES = [
  'resolved',
  'ambiguous',
  'failed',
] as const;

const NoisyEntityBenchmarkCaseSchema = z.object({
  benchmark_id: z.string().min(1),
  query: z.string().min(1),
  expected_entity_id: z.string().min(1),
  category: z.string().min(1),
  language: z.enum(['en', 'ko', 'mixed']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  top_k: z.number().int().min(1).max(20).optional(),
  suite: z.enum(ENTITY_RETRIEVAL_SUITE_IDS).optional(),
  clarify_acceptable: z.boolean().optional(),
  confident_wrong_top1_forbidden: z.boolean().optional(),
  expected_resolution: z.enum(NOISY_ENTITY_DECISION_STATUSES).optional(),
  expected_provenance_stage: z.string().min(1).optional(),
  expected_provenance_source: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const RankedEntitySchema = z.object({
  entity_id: z.string().min(1),
  provenance_stage: z.enum(NOISY_ENTITY_PROVENANCE_STAGES).optional(),
  provenance_source: z.string().min(1).optional(),
});

const NoisyEntityPredictionSchema = z.object({
  benchmark_id: z.string().min(1),
  ranked_entity_ids: z.array(z.string().min(1)).optional(),
  ranked_entities: z.array(RankedEntitySchema).optional(),
  decision_status: z.enum(NOISY_ENTITY_DECISION_STATUSES).optional(),
}).refine(
  (value) => value.ranked_entity_ids !== undefined || value.ranked_entities !== undefined,
  { message: 'ranked_entity_ids or ranked_entities is required' },
);

export type NoisyEntityBenchmarkCase = z.infer<typeof NoisyEntityBenchmarkCaseSchema>;
export type RankedEntity = z.infer<typeof RankedEntitySchema>;
export type NoisyEntityPrediction = z.infer<typeof NoisyEntityPredictionSchema>;
export type NoisyEntityDecisionStatus = z.infer<typeof NoisyEntityPredictionSchema.shape.decision_status>;
type RankedEntityLike = string | RankedEntity;

interface RankedPrediction {
  readonly rankedEntities: readonly RankedEntity[];
  readonly decisionStatus?: NoisyEntityDecisionStatus;
}

export interface NoisyEntitySliceMetrics {
  readonly query_count: number;
  readonly recall_at_1: number;
  readonly recall_at_3: number;
  readonly mrr: number;
}

export interface NoisyEntityBenchmarkReport {
  readonly benchmark: 'noisy-entity-benchmark';
  readonly query_count: number;
  readonly recall_at_1: number;
  readonly recall_at_3: number;
  readonly mrr: number;
  readonly by_category: Record<string, NoisyEntitySliceMetrics>;
  readonly by_language: Record<string, NoisyEntitySliceMetrics>;
  readonly misses: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_entity_id: string;
    readonly category: string;
    readonly language: string;
    readonly top_entity_id: string | null;
    readonly top_3: readonly string[];
  }[];
  readonly provenance_checked_count: number;
  readonly provenance_match_rate: number | null;
  readonly provenance_misses: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_stage: string;
    readonly actual_stage: string | null;
    readonly expected_source: string | null;
    readonly actual_source: string | null;
  }[];
  readonly resolution_checked_count: number;
  readonly resolution_match_rate: number | null;
  readonly false_exact_rate: number | null;
  readonly resolution_misses: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_resolution: string;
    readonly actual_resolution: string | null;
  }[];
  readonly source: 'live-api' | 'predictions' | 'search-executor';
  readonly evaluated_at: string;
}

export interface NoisyEntityBenchmarkThresholds {
  readonly minRecallAt3?: number;
  readonly minResolutionMatchRate?: number;
  readonly minProvenanceMatchRate?: number;
  readonly maxFalseExactRate?: number;
  readonly enforceMinRecallAt3ByCategory?: boolean;
  readonly enforceMinRecallAt3ByLanguage?: boolean;
}

export interface SearchExecutorNoisyBenchmarkOptions {
  readonly input?: string;
  readonly suites?: readonly EntityRetrievalSuiteId[];
  readonly mode?: 'auto' | 'hybrid' | 'entity';
  readonly concurrency?: number;
}

const DEFAULT_INPUT = 'fixture://noisy_attribute_recovery';
const DEFAULT_OUTPUT = resolveDataPath('data/noisy-entity-eval-results.json');
const DEFAULT_SMOKE_PREDICTIONS = resolveDataPath('data/noisy-entity-predictions-smoke.jsonl');

interface CliArgs {
  input: string;
  output: string;
  apiUrl: string;
  predictions: string | null;
  smokePredictions: boolean;
  suites: readonly EntityRetrievalSuiteId[] | undefined;
  mode: 'auto' | 'hybrid' | 'entity';
  timeoutMs: number;
  concurrency: number;
  executionLane: BenchmarkExecutionLane;
  debugKey?: string;
  minRecallAt3?: number;
  minResolutionMatchRate?: number;
  minProvenanceMatchRate?: number;
  maxFalseExactRate?: number;
  enforceMinRecallAt3ByCategory: boolean;
  enforceMinRecallAt3ByLanguage: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    apiUrl: process.env['SEARCH_API_URL'] ?? 'http://localhost:3000',
    predictions: null,
    smokePredictions: false,
    suites: undefined,
    mode: 'hybrid',
    timeoutMs: 60_000,
    concurrency: 4,
    executionLane: 'trusted_benchmark',
    debugKey: process.env['BENCHMARK_DEBUG_KEY'] ?? process.env['HTTP_DEBUG_SECRET'],
    minRecallAt3: undefined,
    minResolutionMatchRate: undefined,
    minProvenanceMatchRate: undefined,
    maxFalseExactRate: undefined,
    enforceMinRecallAt3ByCategory: false,
    enforceMinRecallAt3ByLanguage: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      args.input = resolveCliDataPathArg(argv[++i] ?? DEFAULT_INPUT);
    } else if (arg === '--output' || arg === '-o') {
      args.output = resolveCliDataPathArg(argv[++i] ?? DEFAULT_OUTPUT);
    } else if (arg === '--api-url') {
      args.apiUrl = argv[++i] ?? args.apiUrl;
    } else if (arg === '--predictions') {
      const predictions = argv[++i];
      args.predictions = predictions === undefined ? null : resolveCliDataPathArg(predictions);
    } else if (arg === '--smoke-predictions') {
      args.smokePredictions = true;
    } else if (arg === '--suite' || arg === '--suites') {
      args.suites = parseSuiteIdList(argv[++i], ENTITY_RETRIEVAL_SUITE_IDS);
    } else if (arg === '--mode') {
      const mode = argv[++i];
      if (mode === 'auto' || mode === 'hybrid' || mode === 'entity') {
        args.mode = mode;
      }
    } else if (arg === '--timeout-ms') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 1000) {
        args.timeoutMs = value;
      }
    } else if (arg === '--concurrency') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 1) {
        args.concurrency = Math.min(16, value);
      }
    } else if (arg === '--execution-lane') {
      const value = argv[++i];
      if (value === 'public' || value === 'trusted_benchmark') {
        args.executionLane = value;
      }
    } else if (arg === '--debug-key') {
      args.debugKey = argv[++i] ?? args.debugKey;
    } else if (arg === '--min-recall-at-3') {
      const value = Number.parseFloat(argv[++i] ?? '');
      if (Number.isFinite(value)) {
        args.minRecallAt3 = value;
      }
    } else if (arg === '--min-resolution-match-rate') {
      const value = Number.parseFloat(argv[++i] ?? '');
      if (Number.isFinite(value)) {
        args.minResolutionMatchRate = value;
      }
    } else if (arg === '--min-provenance-match-rate') {
      const value = Number.parseFloat(argv[++i] ?? '');
      if (Number.isFinite(value)) {
        args.minProvenanceMatchRate = value;
      }
    } else if (arg === '--max-false-exact-rate') {
      const value = Number.parseFloat(argv[++i] ?? '');
      if (Number.isFinite(value)) {
        args.maxFalseExactRate = value;
      }
    } else if (arg === '--enforce-min-recall-at-3-by-category') {
      args.enforceMinRecallAt3ByCategory = true;
    } else if (arg === '--enforce-min-recall-at-3-by-language') {
      args.enforceMinRecallAt3ByLanguage = true;
    }
  }

  return args;
}

export function getNoisyEntityQualityViolations(
  report: NoisyEntityBenchmarkReport,
  thresholds: NoisyEntityBenchmarkThresholds,
): readonly string[] {
  const violations: string[] = [];

  const maybeCheckSliceRecallAt3 = (
    slices: Record<string, NoisyEntitySliceMetrics>,
    threshold: number | undefined,
    enabled: boolean | undefined,
    label: 'category' | 'language',
  ): void => {
    if (!enabled || threshold === undefined) {
      return;
    }

    for (const [sliceName, metrics] of Object.entries(slices)) {
      if (metrics.recall_at_3 < threshold) {
        violations.push(
          `${label}.${sliceName}.recall_at_3=${metrics.recall_at_3.toFixed(4)} is below required ${threshold.toFixed(4)}`,
        );
      }
    }
  };

  if (
    thresholds.minRecallAt3 !== undefined &&
    report.recall_at_3 < thresholds.minRecallAt3
  ) {
    violations.push(
      `recall_at_3=${report.recall_at_3.toFixed(4)} is below required ${thresholds.minRecallAt3.toFixed(4)}`,
    );
  }

  maybeCheckSliceRecallAt3(
    report.by_category,
    thresholds.minRecallAt3,
    thresholds.enforceMinRecallAt3ByCategory,
    'category',
  );
  maybeCheckSliceRecallAt3(
    report.by_language,
    thresholds.minRecallAt3,
    thresholds.enforceMinRecallAt3ByLanguage,
    'language',
  );

  if (
    thresholds.minResolutionMatchRate !== undefined &&
    report.resolution_match_rate !== null &&
    report.resolution_match_rate < thresholds.minResolutionMatchRate
  ) {
    violations.push(
      `resolution_match_rate=${report.resolution_match_rate.toFixed(4)} is below required ${thresholds.minResolutionMatchRate.toFixed(4)}`,
    );
  }

  if (
    thresholds.minProvenanceMatchRate !== undefined &&
    report.provenance_match_rate !== null &&
    report.provenance_match_rate < thresholds.minProvenanceMatchRate
  ) {
    violations.push(
      `provenance_match_rate=${report.provenance_match_rate.toFixed(4)} is below required ${thresholds.minProvenanceMatchRate.toFixed(4)}`,
    );
  }

  if (
    thresholds.maxFalseExactRate !== undefined &&
    report.false_exact_rate !== null &&
    report.false_exact_rate > thresholds.maxFalseExactRate
  ) {
    violations.push(
      `false_exact_rate=${report.false_exact_rate.toFixed(4)} is above allowed ${thresholds.maxFalseExactRate.toFixed(4)}`,
    );
  }

  return violations;
}

export function assertNoisyEntityQualityThresholds(
  report: NoisyEntityBenchmarkReport,
  thresholds: NoisyEntityBenchmarkThresholds,
): void {
  const violations = getNoisyEntityQualityViolations(report, thresholds);
  if (violations.length > 0) {
    throw new Error(`Noisy entity quality gate failed:\n- ${violations.join('\n- ')}`);
  }
}

async function readValidatedJsonl<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const content = await fs.readFile(path, 'utf8');
  const { records, skipped } = parseNdjson<unknown>(content, path);
  if (skipped > 0) {
    throw new Error(`Malformed JSONL lines found in ${path}; expected a clean benchmark artifact.`);
  }

  return records.map((record, index) => {
    try {
      return schema.parse(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid record at ${path}:${index + 1} - ${message}`);
    }
  });
}

export function validateNoisyEntityBenchmark(cases: readonly NoisyEntityBenchmarkCase[]): void {
  const seenIds = new Set<string>();

  for (const item of cases) {
    if (seenIds.has(item.benchmark_id)) {
      throw new Error(`Duplicate benchmark_id detected: ${item.benchmark_id}`);
    }
    seenIds.add(item.benchmark_id);

    if ((item.category === 'transliteration' || item.category === 'phonetic') &&
      item.expected_provenance_stage === undefined) {
      throw new Error(
        `Benchmark row ${item.benchmark_id} in category ${item.category} requires expected_provenance_stage`,
      );
    }
    if (item.expected_provenance_source !== undefined && item.expected_provenance_stage === undefined) {
      throw new Error(
        `Benchmark row ${item.benchmark_id} declares expected_provenance_source without expected_provenance_stage`,
      );
    }
    if (item.category === 'noisy_short_form' && item.expected_resolution === undefined) {
      throw new Error(
        `Benchmark row ${item.benchmark_id} in category noisy_short_form requires expected_resolution`,
      );
    }
  }
}

export function validateNoisyEntityPredictions(
  predictions: readonly NoisyEntityPrediction[],
  benchmarkIds?: ReadonlySet<string>,
): void {
  const seenIds = new Set<string>();
  for (const prediction of predictions) {
    if (seenIds.has(prediction.benchmark_id)) {
      throw new Error(`Duplicate benchmark_id in predictions: ${prediction.benchmark_id}`);
    }
    seenIds.add(prediction.benchmark_id);

    if (benchmarkIds !== undefined && !benchmarkIds.has(prediction.benchmark_id)) {
      throw new Error(`Prediction references unknown benchmark_id: ${prediction.benchmark_id}`);
    }
  }
}

function recallAtK(rankedEntityIds: readonly string[], expectedEntityId: string, k: number): number {
  return rankedEntityIds.slice(0, k).includes(expectedEntityId) ? 1 : 0;
}

function reciprocalRank(rankedEntityIds: readonly string[], expectedEntityId: string): number {
  const rank = rankedEntityIds.indexOf(expectedEntityId);
  return rank >= 0 ? 1 / (rank + 1) : 0;
}

function _average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeRankedEntities(raw: readonly RankedEntityLike[] | undefined): readonly RankedEntity[] {
  if (raw === undefined) return [];
  return raw.map((item) => (typeof item === 'string' ? { entity_id: item } : item));
}

function normalizeRankedPrediction(
  raw: readonly RankedEntityLike[] | RankedPrediction | undefined,
): RankedPrediction {
  if (raw === undefined) {
    return { rankedEntities: [] };
  }
  if (Array.isArray(raw)) {
    return { rankedEntities: normalizeRankedEntities(raw) };
  }
  return {
    rankedEntities: raw.rankedEntities,
    decisionStatus: raw.decisionStatus,
  };
}

function extractDecisionStatus(
  responseBody: unknown,
): NoisyEntityDecisionStatus | undefined {
  if (typeof responseBody !== 'object' || responseBody === null) return undefined;
  const body = responseBody as Record<string, unknown>;
  const engineDecision = body['engine_decision'] ?? body['engineDecision'];
  if (typeof engineDecision !== 'object' || engineDecision === null) return undefined;
  const decisionStatus = (engineDecision as Record<string, unknown>)['decision_status']
    ?? (engineDecision as Record<string, unknown>)['decisionStatus'];
  return decisionStatus === 'resolved' || decisionStatus === 'ambiguous' || decisionStatus === 'failed'
    ? decisionStatus
    : undefined;
}

function scoreRows(
  rows: readonly NoisyEntityBenchmarkCase[],
  rankedByBenchmarkId: ReadonlyMap<string, readonly RankedEntityLike[] | RankedPrediction>,
): NoisyEntityBenchmarkReport {
  const categoryAccumulators = new Map<string, {
    queryCount: number;
    recallAt1Total: number;
    recallAt3Total: number;
    mrrTotal: number;
  }>();
  const languageAccumulators = new Map<string, {
    queryCount: number;
    recallAt1Total: number;
    recallAt3Total: number;
    mrrTotal: number;
  }>();

  const byCategory: Record<string, NoisyEntitySliceMetrics> = {};
  const byLanguage: Record<string, NoisyEntitySliceMetrics> = {};
  const misses: NoisyEntityBenchmarkReport['misses'] = [];
  const provenanceMisses: NoisyEntityBenchmarkReport['provenance_misses'] = [];
  const resolutionMisses: NoisyEntityBenchmarkReport['resolution_misses'] = [];

  let queryCount = 0;
  let totalRecallAt1 = 0;
  let totalRecallAt3 = 0;
  let totalMrr = 0;
  let provenanceCheckedCount = 0;
  let provenanceMatchCount = 0;
  let resolutionCheckedCount = 0;
  let resolutionMatchCount = 0;
  let ambiguousExpectedCount = 0;
  let falseExactCount = 0;

  for (const row of rows) {
    const prediction = normalizeRankedPrediction(rankedByBenchmarkId.get(row.benchmark_id));
    const rankedEntities = prediction.rankedEntities;
    const rankedEntityIds = rankedEntities.map((item) => item.entity_id);
    const rank = rankedEntityIds.indexOf(row.expected_entity_id);
    const topEntity = rankedEntities[0] ?? null;
    const predictedResolution = prediction.decisionStatus ?? (rankedEntityIds.length > 0 ? 'resolved' : 'failed');
    const topK = row.top_k ?? 3;
    const recallAt1 = recallAtK(rankedEntityIds, row.expected_entity_id, 1);
    const recallAt3 = recallAtK(rankedEntityIds, row.expected_entity_id, topK);
    const reciprocal = reciprocalRank(rankedEntityIds, row.expected_entity_id);

    queryCount += 1;
    totalRecallAt1 += recallAt1;
    totalRecallAt3 += recallAt3;
    totalMrr += reciprocal;

    const categoryAccumulator = categoryAccumulators.get(row.category) ?? {
      queryCount: 0,
      recallAt1Total: 0,
      recallAt3Total: 0,
      mrrTotal: 0,
    };
    categoryAccumulator.queryCount += 1;
    categoryAccumulator.recallAt1Total += recallAt1;
    categoryAccumulator.recallAt3Total += recallAt3;
    categoryAccumulator.mrrTotal += reciprocal;
    categoryAccumulators.set(row.category, categoryAccumulator);

    const languageAccumulator = languageAccumulators.get(row.language) ?? {
      queryCount: 0,
      recallAt1Total: 0,
      recallAt3Total: 0,
      mrrTotal: 0,
    };
    languageAccumulator.queryCount += 1;
    languageAccumulator.recallAt1Total += recallAt1;
    languageAccumulator.recallAt3Total += recallAt3;
    languageAccumulator.mrrTotal += reciprocal;
    languageAccumulators.set(row.language, languageAccumulator);

    if (rank === -1 && misses.length < 25) {
      misses.push({
        benchmark_id: row.benchmark_id,
        query: row.query,
        expected_entity_id: row.expected_entity_id,
        category: row.category,
        language: row.language,
        top_entity_id: topEntity?.entity_id ?? null,
        top_3: rankedEntityIds.slice(0, 3),
      });
    }

    if (row.expected_provenance_stage !== undefined) {
      provenanceCheckedCount += 1;
      const provenanceMatch =
        topEntity?.provenance_stage === row.expected_provenance_stage &&
        (row.expected_provenance_source === undefined ||
          topEntity?.provenance_source === row.expected_provenance_source);
      if (provenanceMatch) {
        provenanceMatchCount += 1;
      } else if (provenanceMisses.length < 25) {
        provenanceMisses.push({
          benchmark_id: row.benchmark_id,
          query: row.query,
          expected_stage: row.expected_provenance_stage,
          actual_stage: topEntity?.provenance_stage ?? null,
          expected_source: row.expected_provenance_source ?? null,
          actual_source: topEntity?.provenance_source ?? null,
        });
      }
    }

    if (row.expected_resolution !== undefined) {
      resolutionCheckedCount += 1;
      if (row.expected_resolution === 'ambiguous') {
        ambiguousExpectedCount += 1;
      }
      if (row.expected_resolution === predictedResolution) {
        resolutionMatchCount += 1;
      } else if (row.expected_resolution === 'ambiguous' && predictedResolution === 'resolved') {
        falseExactCount += 1;
        if (resolutionMisses.length < 25) {
          resolutionMisses.push({
            benchmark_id: row.benchmark_id,
            query: row.query,
            expected_resolution: row.expected_resolution,
            actual_resolution: predictedResolution,
          });
        }
      } else if (resolutionMisses.length < 25) {
        resolutionMisses.push({
          benchmark_id: row.benchmark_id,
          query: row.query,
          expected_resolution: row.expected_resolution,
          actual_resolution: predictedResolution,
        });
      }
    }
  }

  for (const [category, accumulator] of categoryAccumulators) {
    byCategory[category] = {
      query_count: accumulator.queryCount,
      recall_at_1: accumulator.queryCount === 0 ? 0 : accumulator.recallAt1Total / accumulator.queryCount,
      recall_at_3: accumulator.queryCount === 0 ? 0 : accumulator.recallAt3Total / accumulator.queryCount,
      mrr: accumulator.queryCount === 0 ? 0 : accumulator.mrrTotal / accumulator.queryCount,
    };
  }

  for (const [language, accumulator] of languageAccumulators) {
    byLanguage[language] = {
      query_count: accumulator.queryCount,
      recall_at_1: accumulator.queryCount === 0 ? 0 : accumulator.recallAt1Total / accumulator.queryCount,
      recall_at_3: accumulator.queryCount === 0 ? 0 : accumulator.recallAt3Total / accumulator.queryCount,
      mrr: accumulator.queryCount === 0 ? 0 : accumulator.mrrTotal / accumulator.queryCount,
    };
  }

  return {
    benchmark: 'noisy-entity-benchmark',
    query_count: queryCount,
    recall_at_1: queryCount === 0 ? 0 : totalRecallAt1 / queryCount,
    recall_at_3: queryCount === 0 ? 0 : totalRecallAt3 / queryCount,
    mrr: queryCount === 0 ? 0 : totalMrr / queryCount,
    by_category: byCategory,
    by_language: byLanguage,
    misses,
    provenance_checked_count: provenanceCheckedCount,
    provenance_match_rate: provenanceCheckedCount === 0 ? null : provenanceMatchCount / provenanceCheckedCount,
    provenance_misses: provenanceMisses,
    resolution_checked_count: resolutionCheckedCount,
    resolution_match_rate: resolutionCheckedCount === 0 ? null : resolutionMatchCount / resolutionCheckedCount,
    false_exact_rate: ambiguousExpectedCount === 0 ? null : falseExactCount / ambiguousExpectedCount,
    resolution_misses: resolutionMisses,
    source: 'predictions',
    evaluated_at: new Date().toISOString(),
  };
}

export function extractRankedEntityIds(responseBody: unknown): readonly string[] {
  const body = responseBody as Record<string, unknown>;
  const results = Array.isArray(body['results']) ? (body['results'] as Record<string, unknown>[]) : [];

  return results
    .map((result) => {
      const entity = (result['entity'] ?? {}) as Record<string, unknown>;
      const entityId = entity['entity_id'] ?? entity['entityId'] ?? result['entity_id'] ?? result['entityId'];
      return typeof entityId === 'string' ? entityId : '';
    })
    .filter((entityId) => entityId.length > 0);
}

export function extractRankedEntities(responseBody: unknown): readonly RankedEntity[] {
  const body = responseBody as Record<string, unknown>;
  const results = Array.isArray(body['results']) ? (body['results'] as Record<string, unknown>[]) : [];

  return results
    .map((result) => {
      const entity = (result['entity'] ?? {}) as Record<string, unknown>;
      const entityId = entity['entity_id'] ?? entity['entityId'] ?? result['entity_id'] ?? result['entityId'];
      if (typeof entityId !== 'string' || entityId.length === 0) return null;

      const provenance = (result['provenance'] ?? entity['provenance']) as Record<string, unknown> | undefined;
      const provenanceStage = provenance?.['stage'];
      const provenanceSource = provenance?.['source'];

      return {
        entity_id: entityId,
        ...(typeof provenanceStage === 'string' && NOISY_ENTITY_PROVENANCE_STAGES.includes(provenanceStage as never)
          ? { provenance_stage: provenanceStage as RankedEntity['provenance_stage'] }
          : {}),
        ...(typeof provenanceSource === 'string' && provenanceSource.length > 0
          ? { provenance_source: provenanceSource }
          : {}),
      } satisfies RankedEntity;
    })
    .filter((item): item is RankedEntity => item !== null);
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function fetchLiveRankings(
  cases: readonly NoisyEntityBenchmarkCase[],
  apiUrl: string,
  mode: CliArgs['mode'],
  timeoutMs: number,
  concurrency: number,
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Promise<Map<string, RankedPrediction>> {
  const endpoint = resolveBenchmarkSearchEndpoint(apiUrl, executionLane);
  const headers = buildBenchmarkRequestHeaders(executionLane, debugKey);
  const mappings = await mapPool(
    cases,
    concurrency,
    async (benchmarkCase) => {
      const payload: Record<string, unknown> = {
        query: benchmarkCase.query,
      };

      if (mode !== 'auto') {
        payload.options = { mode };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return [benchmarkCase.benchmark_id, { rankedEntities: [] }] as const;
      }

      const body = (await response.json()) as unknown;
      return [benchmarkCase.benchmark_id, {
        rankedEntities: extractRankedEntities(body),
        decisionStatus: extractDecisionStatus(body),
      }] as const;
    },
  );

  return new Map(mappings);
}

export async function loadNoisyEntityPredictions(
  path = DEFAULT_SMOKE_PREDICTIONS,
  benchmarkIds?: ReadonlySet<string>,
): Promise<Map<string, RankedPrediction>> {
  const records = await readValidatedJsonl(path, NoisyEntityPredictionSchema);
  validateNoisyEntityPredictions(records, benchmarkIds);
  return new Map(records.map((record) => {
    const rankedEntities = record.ranked_entities ?? record.ranked_entity_ids?.map((entity_id) => ({ entity_id }));
    return [record.benchmark_id, {
      rankedEntities: rankedEntities ?? [],
      decisionStatus: record.decision_status,
    }] as const;
  }));
}

function isExternalFixtureSource(path: string): boolean {
  return path.startsWith('fixture://')
    || ENTITY_RETRIEVAL_SUITE_IDS.includes(path as EntityRetrievalSuiteId);
}

function parseFixtureSuitesFromSource(
  path: string,
  explicitSuites: readonly EntityRetrievalSuiteId[] | undefined,
): readonly EntityRetrievalSuiteId[] {
  if (explicitSuites !== undefined && explicitSuites.length > 0) {
    return explicitSuites;
  }
  if (path.startsWith('fixture://')) {
    const raw = path.slice('fixture://'.length);
    return parseSuiteIdList(raw, ENTITY_RETRIEVAL_SUITE_IDS) ?? ['noisy_attribute_recovery'];
  }
  if (ENTITY_RETRIEVAL_SUITE_IDS.includes(path as EntityRetrievalSuiteId)) {
    return [path as EntityRetrievalSuiteId];
  }
  return ['noisy_attribute_recovery'];
}

export async function loadNoisyEntityBenchmark(
  path = DEFAULT_INPUT,
  suites?: readonly EntityRetrievalSuiteId[],
): Promise<NoisyEntityBenchmarkCase[]> {
  if (isExternalFixtureSource(path)) {
    const fixtureCases = await loadEntityRetrievalFixtureCases(
      parseFixtureSuitesFromSource(path, suites),
    );
    const noisyCases = fixtureCases.filter((item) => item.suite === 'noisy_attribute_recovery');
    validateNoisyEntityBenchmark(noisyCases);
    return [...noisyCases];
  }

  const cases = await readValidatedJsonl(path, NoisyEntityBenchmarkCaseSchema);
  validateNoisyEntityBenchmark(cases);
  return cases;
}

export function scoreNoisyEntityBenchmark(
  cases: readonly NoisyEntityBenchmarkCase[],
  rankedByBenchmarkId: ReadonlyMap<string, readonly RankedEntityLike[] | RankedPrediction>,
): NoisyEntityBenchmarkReport {
  return scoreRows(cases, rankedByBenchmarkId);
}

export function buildPerfectNoisyEntityPredictions(
  cases: readonly NoisyEntityBenchmarkCase[],
): Map<string, RankedPrediction> {
  return new Map(cases.map((benchmarkCase) => [
    benchmarkCase.benchmark_id,
    {
      rankedEntities: [{
        entity_id: benchmarkCase.expected_entity_id,
        ...(benchmarkCase.expected_provenance_stage !== undefined
          ? { provenance_stage: benchmarkCase.expected_provenance_stage as RankedEntity['provenance_stage'] }
          : {}),
        ...(benchmarkCase.expected_provenance_source !== undefined
          ? { provenance_source: benchmarkCase.expected_provenance_source }
          : {}),
      }],
      decisionStatus: benchmarkCase.expected_resolution ?? 'resolved',
    },
  ]));
}

function benchmarkSearchContextForLanguage(
  language: NoisyEntityBenchmarkCase['language'],
): { readonly locale: string; readonly currency: string } {
  switch (language) {
    case 'ko':
      return { locale: 'ko-KR', currency: 'KRW' };
    case 'mixed':
      return { locale: 'ko-KR', currency: 'KRW' };
    case 'en':
    default:
      return { locale: 'en-US', currency: 'USD' };
  }
}

export async function evaluateNoisyEntityBenchmarkWithSearchExecutor(
  searchExecutor: SearchExecutorPort,
  options: SearchExecutorNoisyBenchmarkOptions = {},
): Promise<NoisyEntityBenchmarkReport> {
  const cases = await loadNoisyEntityBenchmark(options.input ?? DEFAULT_INPUT, options.suites);
  const mode = options.mode ?? 'hybrid';
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));

  const rankedByBenchmarkId = new Map(await mapPool(
    cases,
    concurrency,
    async (benchmarkCase) => {
      const request = {
        query: benchmarkCase.query,
        context: benchmarkSearchContextForLanguage(benchmarkCase.language),
        ...(mode !== 'auto'
          ? { options: { mode, explain: false, clarification: false } as const }
          : {}),
      };
      const requestId = `noisy-bench-${benchmarkCase.benchmark_id}`;
      const execution = searchExecutor.executeForEvaluation !== undefined
        ? await searchExecutor.executeForEvaluation(
            request,
            requestId,
            { executionPrincipal: 'benchmark_trusted', requestId },
          )
        : {
            response: await searchExecutor.execute(
              request,
              requestId,
              { executionPrincipal: 'benchmark_trusted', requestId },
            ),
          };
      const responseBody = execution.response;
      if (responseBody.queryType !== 'search') {
        return [benchmarkCase.benchmark_id, { rankedEntities: [] }] as const;
      }
      return [benchmarkCase.benchmark_id, {
        rankedEntities: extractRankedEntities(responseBody),
        decisionStatus: extractDecisionStatus(responseBody),
      }] as const;
    },
  ));

  const report = scoreNoisyEntityBenchmark(cases, rankedByBenchmarkId);
  return {
    ...report,
    source: 'search-executor',
    evaluated_at: new Date().toISOString(),
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadNoisyEntityBenchmark(args.input, args.suites);

  if (!args.smokePredictions && args.predictions === null) {
    await runLiveBenchmarkPreflight({
      apiUrl: args.apiUrl,
      executionLane: args.executionLane,
      debugKey: args.debugKey,
      requiredEntityIds: cases.map((item) => item.expected_entity_id),
    });
  }

  const rankedByBenchmarkId = args.smokePredictions
    ? buildPerfectNoisyEntityPredictions(cases)
    : args.predictions !== null
    ? await loadNoisyEntityPredictions(args.predictions, new Set(cases.map((item) => item.benchmark_id)))
    : await fetchLiveRankings(
        cases,
        args.apiUrl,
        args.mode,
        args.timeoutMs,
        args.concurrency,
        args.executionLane,
        args.debugKey,
      );

  const report = scoreNoisyEntityBenchmark(cases, rankedByBenchmarkId);
  const finalReport: NoisyEntityBenchmarkReport = {
    ...report,
    source: args.predictions !== null || args.smokePredictions ? 'predictions' : 'live-api',
    evaluated_at: new Date().toISOString(),
  };

  await fs.writeFile(args.output, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');

  console.log('Noisy entity benchmark complete');
  console.log(`  cases:       ${finalReport.query_count}`);
  console.log(`  recall@1:    ${finalReport.recall_at_1.toFixed(4)}`);
  console.log(`  recall@3:    ${finalReport.recall_at_3.toFixed(4)}`);
  console.log(`  mrr:         ${finalReport.mrr.toFixed(4)}`);
  if (finalReport.provenance_checked_count > 0) {
    console.log(
      `  provenance:  ${finalReport.provenance_checked_count} checked, match=${(finalReport.provenance_match_rate ?? 0).toFixed(4)}`,
    );
  }
  console.log(`  output:      ${args.output}`);
  console.log(`  source:      ${finalReport.source}`);

  for (const [category, metrics] of Object.entries(finalReport.by_category)) {
    console.log(
      `  category:${category} n=${metrics.query_count} recall@1=${metrics.recall_at_1.toFixed(3)} recall@3=${metrics.recall_at_3.toFixed(3)} mrr=${metrics.mrr.toFixed(3)}`,
    );
  }

  assertNoisyEntityQualityThresholds(finalReport, {
    minRecallAt3: args.minRecallAt3,
    minResolutionMatchRate: args.minResolutionMatchRate,
    minProvenanceMatchRate: args.minProvenanceMatchRate,
    maxFalseExactRate: args.maxFalseExactRate,
    enforceMinRecallAt3ByCategory: args.enforceMinRecallAt3ByCategory,
    enforceMinRecallAt3ByLanguage: args.enforceMinRecallAt3ByLanguage,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
