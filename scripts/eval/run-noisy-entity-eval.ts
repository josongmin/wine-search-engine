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

import 'dotenv/config';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { parseNdjson } from '../etl/ndjson.js';

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
  category: z.enum(NOISY_ENTITY_CATEGORIES),
  language: z.enum(['en', 'ko', 'mixed']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  expected_resolution: z.enum(NOISY_ENTITY_DECISION_STATUSES).optional(),
  expected_provenance_stage: z.enum(NOISY_ENTITY_PROVENANCE_STAGES).optional(),
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
  readonly source: 'live-api' | 'predictions';
  readonly evaluated_at: string;
}

const DEFAULT_INPUT = 'data/noisy-entity-benchmark.jsonl';
const DEFAULT_OUTPUT = 'data/noisy-entity-eval-results.json';
const DEFAULT_SMOKE_PREDICTIONS = 'data/noisy-entity-predictions-smoke.jsonl';

interface CliArgs {
  input: string;
  output: string;
  apiUrl: string;
  predictions: string | null;
  mode: 'auto' | 'hybrid' | 'entity';
  timeoutMs: number;
  concurrency: number;
  minRecallAt3?: number;
  minResolutionMatchRate?: number;
  minProvenanceMatchRate?: number;
  maxFalseExactRate?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    apiUrl: process.env['SEARCH_API_URL'] ?? 'http://localhost:3000',
    predictions: null,
    mode: 'hybrid',
    timeoutMs: 60_000,
    concurrency: 8,
    minRecallAt3: undefined,
    minResolutionMatchRate: undefined,
    minProvenanceMatchRate: undefined,
    maxFalseExactRate: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      args.input = argv[++i] ?? DEFAULT_INPUT;
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[++i] ?? DEFAULT_OUTPUT;
    } else if (arg === '--api-url') {
      args.apiUrl = argv[++i] ?? args.apiUrl;
    } else if (arg === '--predictions') {
      args.predictions = argv[++i] ?? null;
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
        args.concurrency = Math.min(32, value);
      }
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
    }
  }

  return args;
}

export function assertNoisyEntityQualityThresholds(
  report: NoisyEntityBenchmarkReport,
  thresholds: {
    readonly minRecallAt3?: number;
    readonly minResolutionMatchRate?: number;
    readonly minProvenanceMatchRate?: number;
    readonly maxFalseExactRate?: number;
  },
): void {
  const violations: string[] = [];

  if (
    thresholds.minRecallAt3 !== undefined &&
    report.recall_at_3 < thresholds.minRecallAt3
  ) {
    violations.push(
      `recall_at_3=${report.recall_at_3.toFixed(4)} is below required ${thresholds.minRecallAt3.toFixed(4)}`,
    );
  }

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
  const categoryCounts = new Map<string, number>();

  for (const item of cases) {
    if (seenIds.has(item.benchmark_id)) {
      throw new Error(`Duplicate benchmark_id detected: ${item.benchmark_id}`);
    }
    seenIds.add(item.benchmark_id);
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);

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

  const missingCategories = NOISY_ENTITY_CATEGORIES.filter(
    (category) => (categoryCounts.get(category) ?? 0) === 0,
  );
  if (missingCategories.length > 0) {
    throw new Error(`Benchmark is missing required categories: ${missingCategories.join(', ')}`);
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

function average(values: readonly number[]): number {
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

function scoreRows(
  rows: readonly NoisyEntityBenchmarkCase[],
  rankedByBenchmarkId: ReadonlyMap<string, readonly RankedEntityLike[] | RankedPrediction>,
): NoisyEntityBenchmarkReport {
  const scored = rows.map((row) => {
    const prediction = normalizeRankedPrediction(rankedByBenchmarkId.get(row.benchmark_id));
    const rankedEntities = prediction.rankedEntities;
    const rankedEntityIds = rankedEntities.map((item) => item.entity_id);
    const rank = rankedEntityIds.indexOf(row.expected_entity_id);
    const topEntity = rankedEntities[0] ?? null;
    const predictedResolution = prediction.decisionStatus ?? (rankedEntityIds.length > 0 ? 'resolved' : 'failed');

    return {
      row,
      rankedEntityIds,
      rankedEntities,
      recallAt1: recallAtK(rankedEntityIds, row.expected_entity_id, 1),
      recallAt3: recallAtK(rankedEntityIds, row.expected_entity_id, 3),
      reciprocalRank: reciprocalRank(rankedEntityIds, row.expected_entity_id),
      topEntityId: topEntity?.entity_id ?? null,
      topProvenanceStage: topEntity?.provenance_stage ?? null,
      topProvenanceSource: topEntity?.provenance_source ?? null,
      predictedResolution,
      top3: rankedEntityIds.slice(0, 3),
      foundRank: rank >= 0 ? rank + 1 : null,
    };
  });

  const sliceMetrics = (
    subset: readonly (typeof scored)[number][],
  ): NoisyEntitySliceMetrics => ({
    query_count: subset.length,
    recall_at_1: average(subset.map((item) => item.recallAt1)),
    recall_at_3: average(subset.map((item) => item.recallAt3)),
    mrr: average(subset.map((item) => item.reciprocalRank)),
  });

  const byCategory: Record<string, NoisyEntitySliceMetrics> = {};
  const categoryGroups = new Map<string, typeof scored>();
  for (const item of scored) {
    const existing = categoryGroups.get(item.row.category);
    if (existing) {
      existing.push(item);
    } else {
      categoryGroups.set(item.row.category, [item]);
    }
  }
  for (const [category, group] of categoryGroups) {
    byCategory[category] = sliceMetrics(group);
  }

  const byLanguage: Record<string, NoisyEntitySliceMetrics> = {};
  const languageGroups = new Map<string, typeof scored>();
  for (const item of scored) {
    const existing = languageGroups.get(item.row.language);
    if (existing) {
      existing.push(item);
    } else {
      languageGroups.set(item.row.language, [item]);
    }
  }
  for (const [language, group] of languageGroups) {
    byLanguage[language] = sliceMetrics(group);
  }

  const misses = scored
    .filter((item) => item.foundRank === null)
    .slice(0, 25)
    .map((item) => ({
      benchmark_id: item.row.benchmark_id,
      query: item.row.query,
      expected_entity_id: item.row.expected_entity_id,
      category: item.row.category,
      language: item.row.language,
      top_entity_id: item.topEntityId,
      top_3: item.top3,
    }));

  const provenanceRelevant = scored.filter((item) => item.row.expected_provenance_stage !== undefined);
  const provenanceMatches = provenanceRelevant.filter((item) => {
    return item.topProvenanceStage === item.row.expected_provenance_stage
      && (
        item.row.expected_provenance_source === undefined ||
        item.topProvenanceSource === item.row.expected_provenance_source
      );
  });
  const provenanceMisses = provenanceRelevant
    .filter((item) => !provenanceMatches.includes(item))
    .slice(0, 25)
    .map((item) => ({
      benchmark_id: item.row.benchmark_id,
      query: item.row.query,
      expected_stage: item.row.expected_provenance_stage!,
      actual_stage: item.topProvenanceStage,
      expected_source: item.row.expected_provenance_source ?? null,
      actual_source: item.topProvenanceSource,
    }));

  const resolutionRelevant = scored.filter((item) => item.row.expected_resolution !== undefined);
  const resolutionMatches = resolutionRelevant.filter(
    (item) => item.row.expected_resolution === item.predictedResolution,
  );
  const ambiguousExpected = resolutionRelevant.filter((item) => item.row.expected_resolution === 'ambiguous');
  const falseExactMatches = ambiguousExpected.filter((item) => item.predictedResolution === 'resolved');
  const resolutionMisses = resolutionRelevant
    .filter((item) => item.row.expected_resolution !== item.predictedResolution)
    .slice(0, 25)
    .map((item) => ({
      benchmark_id: item.row.benchmark_id,
      query: item.row.query,
      expected_resolution: item.row.expected_resolution!,
      actual_resolution: item.predictedResolution,
    }));

  return {
    benchmark: 'noisy-entity-benchmark',
    query_count: scored.length,
    recall_at_1: average(scored.map((item) => item.recallAt1)),
    recall_at_3: average(scored.map((item) => item.recallAt3)),
    mrr: average(scored.map((item) => item.reciprocalRank)),
    by_category: byCategory,
    by_language: byLanguage,
    misses,
    provenance_checked_count: provenanceRelevant.length,
    provenance_match_rate: provenanceRelevant.length === 0 ? null : provenanceMatches.length / provenanceRelevant.length,
    provenance_misses: provenanceMisses,
    resolution_checked_count: resolutionRelevant.length,
    resolution_match_rate: resolutionRelevant.length === 0 ? null : resolutionMatches.length / resolutionRelevant.length,
    false_exact_rate: ambiguousExpected.length === 0 ? null : falseExactMatches.length / ambiguousExpected.length,
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

async function fetchLiveRankings(
  cases: readonly NoisyEntityBenchmarkCase[],
  apiUrl: string,
  mode: CliArgs['mode'],
  timeoutMs: number,
  concurrency: number,
): Promise<Map<string, RankedPrediction>> {
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

      const response = await fetch(`${apiUrl}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return [benchmarkCase.benchmark_id, { rankedEntities: [] }] as const;
      }

      const body = (await response.json()) as unknown;
      return [benchmarkCase.benchmark_id, { rankedEntities: extractRankedEntities(body) }] as const;
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

export async function loadNoisyEntityBenchmark(path = DEFAULT_INPUT): Promise<NoisyEntityBenchmarkCase[]> {
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

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadNoisyEntityBenchmark(args.input);

  const rankedByBenchmarkId = args.predictions !== null
    ? await loadNoisyEntityPredictions(args.predictions, new Set(cases.map((item) => item.benchmark_id)))
    : await fetchLiveRankings(cases, args.apiUrl, args.mode, args.timeoutMs, args.concurrency);

  const report = scoreNoisyEntityBenchmark(cases, rankedByBenchmarkId);
  const finalReport: NoisyEntityBenchmarkReport = {
    ...report,
    source: args.predictions !== null ? 'predictions' : 'live-api',
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
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
