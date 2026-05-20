#!/usr/bin/env tsx
/**
 * Autocomplete benchmark eval runner.
 *
 * Scores autocomplete suggestion quality against a dedicated typeahead corpus:
 * Recall@1/3/5, MRR, false-exact rate for ambiguous expectations, and latency.
 */

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseNdjson } from '../etl/ndjson.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import type { AutocompleteUseCasePort } from '../../src/application/search/port/search-route-usecases.port.js';

export const AUTOCOMPLETE_BENCHMARK_CATEGORIES = [
  'latin_prefix',
  'hangul_prefix',
  'hangul_ime',
  'acronym',
  'diacriticless',
  'ambiguous_short',
] as const;

export const AUTOCOMPLETE_STATUSES = ['resolved', 'ambiguous', 'failed'] as const;

const AutocompleteBenchmarkCaseSchema = z.object({
  benchmark_id: z.string().min(1),
  query: z.string().min(1),
  expected_entity_id: z.string().min(1),
  category: z.enum(AUTOCOMPLETE_BENCHMARK_CATEGORIES),
  language: z.enum(['en', 'ko', 'mixed']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  expected_status: z.enum(AUTOCOMPLETE_STATUSES).optional(),
  notes: z.string().optional(),
}).strict();

const AutocompleteRankedEntitySchema = z.object({
  entity_id: z.string().min(1),
}).strict();

const AutocompletePredictionSchema = z.object({
  benchmark_id: z.string().min(1),
  ranked_entity_ids: z.array(z.string().min(1)).optional(),
  ranked_entities: z.array(AutocompleteRankedEntitySchema).optional(),
  status: z.enum(AUTOCOMPLETE_STATUSES).optional(),
  latency_ms: z.number().finite().nonnegative().optional(),
}).strict().refine(
  (value) => value.ranked_entity_ids !== undefined || value.ranked_entities !== undefined,
  { message: 'ranked_entity_ids or ranked_entities is required' },
);

export type AutocompleteBenchmarkCase = z.infer<typeof AutocompleteBenchmarkCaseSchema>;
export type AutocompleteStatus = z.infer<typeof AutocompletePredictionSchema.shape.status>;
export type AutocompletePrediction = z.infer<typeof AutocompletePredictionSchema>;

interface RankedPrediction {
  readonly rankedEntityIds: readonly string[];
  readonly status?: AutocompleteStatus | undefined;
  readonly latencyMs?: number | undefined;
}

export interface AutocompleteSliceMetrics {
  readonly query_count: number;
  readonly recall_at_1: number;
  readonly recall_at_3: number;
  readonly recall_at_5: number;
  readonly mrr: number;
}

export interface AutocompleteLatencyMetrics {
  readonly measured_count: number;
  readonly avg_ms: number | null;
  readonly p95_ms: number | null;
  readonly max_ms: number | null;
}

export interface AutocompleteBenchmarkReport {
  readonly benchmark: 'autocomplete-benchmark';
  readonly query_count: number;
  readonly recall_at_1: number;
  readonly recall_at_3: number;
  readonly recall_at_5: number;
  readonly mrr: number;
  readonly false_exact_rate: number | null;
  readonly status_checked_count: number;
  readonly status_match_rate: number | null;
  readonly latency: AutocompleteLatencyMetrics;
  readonly by_category: Record<string, AutocompleteSliceMetrics>;
  readonly by_language: Record<string, AutocompleteSliceMetrics>;
  readonly misses: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_entity_id: string;
    readonly category: string;
    readonly language: string;
    readonly top_entity_id: string | null;
    readonly top_5: readonly string[];
  }[];
  readonly status_misses: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_status: string;
    readonly actual_status: string | null;
  }[];
  readonly source: 'live-api' | 'predictions' | 'autocomplete-usecase';
  readonly evaluated_at: string;
}

export interface AutocompleteBenchmarkThresholds {
  readonly minRecallAt1?: number | undefined;
  readonly minRecallAt3?: number | undefined;
  readonly minRecallAt5?: number | undefined;
  readonly minMrr?: number | undefined;
  readonly maxFalseExactRate?: number | undefined;
  readonly maxP95LatencyMs?: number | undefined;
  readonly enforceMinRecallAt3ByCategory?: boolean | undefined;
  readonly enforceMinRecallAt3ByLanguage?: boolean | undefined;
}

export interface AutocompleteUseCaseBenchmarkOptions {
  readonly input?: string | undefined;
  readonly concurrency?: number | undefined;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_INPUT = `${REPO_ROOT}data/autocomplete-benchmark.jsonl`;
const DEFAULT_OUTPUT = resolveDataPath('data/autocomplete-eval-results.json');

interface CliArgs {
  readonly input: string;
  readonly output: string;
  readonly apiUrl: string;
  readonly predictions: string | null;
  readonly smokePredictions: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly minRecallAt1?: number | undefined;
  readonly minRecallAt3?: number | undefined;
  readonly minRecallAt5?: number | undefined;
  readonly minMrr?: number | undefined;
  readonly maxFalseExactRate?: number | undefined;
  readonly maxP95LatencyMs?: number | undefined;
  readonly enforceMinRecallAt3ByCategory: boolean;
  readonly enforceMinRecallAt3ByLanguage: boolean;
}

function parseOptionalFiniteFloat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:4000';
  let predictions: string | null = null;
  let smokePredictions = false;
  let timeoutMs = 30_000;
  let concurrency = 4;
  let minRecallAt1: number | undefined;
  let minRecallAt3: number | undefined;
  let minRecallAt5: number | undefined;
  let minMrr: number | undefined;
  let maxFalseExactRate: number | undefined;
  let maxP95LatencyMs: number | undefined;
  let enforceMinRecallAt3ByCategory = false;
  let enforceMinRecallAt3ByLanguage = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      input = resolveCliDataPathArg(argv[++index] ?? DEFAULT_INPUT);
    } else if (arg === '--output' || arg === '-o') {
      output = resolveCliDataPathArg(argv[++index] ?? DEFAULT_OUTPUT);
    } else if (arg === '--api-url') {
      apiUrl = argv[++index] ?? apiUrl;
    } else if (arg === '--predictions') {
      const value = argv[++index];
      predictions = value === undefined ? null : resolveCliDataPathArg(value);
    } else if (arg === '--smoke-predictions') {
      smokePredictions = true;
    } else if (arg === '--timeout-ms') {
      timeoutMs = parseOptionalPositiveInt(argv[++index]) ?? timeoutMs;
    } else if (arg === '--concurrency') {
      const value = parseOptionalPositiveInt(argv[++index]);
      if (value !== undefined) concurrency = Math.min(16, value);
    } else if (arg === '--min-recall-at-1') {
      minRecallAt1 = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--min-recall-at-3') {
      minRecallAt3 = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--min-recall-at-5') {
      minRecallAt5 = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--min-mrr') {
      minMrr = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--max-false-exact-rate') {
      maxFalseExactRate = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--max-p95-latency-ms') {
      maxP95LatencyMs = parseOptionalFiniteFloat(argv[++index]);
    } else if (arg === '--enforce-min-recall-at-3-by-category') {
      enforceMinRecallAt3ByCategory = true;
    } else if (arg === '--enforce-min-recall-at-3-by-language') {
      enforceMinRecallAt3ByLanguage = true;
    }
  }

  return {
    input,
    output,
    apiUrl,
    predictions,
    smokePredictions,
    timeoutMs,
    concurrency,
    minRecallAt1,
    minRecallAt3,
    minRecallAt5,
    minMrr,
    maxFalseExactRate,
    maxP95LatencyMs,
    enforceMinRecallAt3ByCategory,
    enforceMinRecallAt3ByLanguage,
  };
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

export function validateAutocompleteBenchmark(cases: readonly AutocompleteBenchmarkCase[]): void {
  const seenIds = new Set<string>();
  for (const item of cases) {
    if (seenIds.has(item.benchmark_id)) {
      throw new Error(`Duplicate benchmark_id detected: ${item.benchmark_id}`);
    }
    seenIds.add(item.benchmark_id);

    if (item.category === 'ambiguous_short' && item.expected_status === undefined) {
      throw new Error(
        `Benchmark row ${item.benchmark_id} in category ambiguous_short requires expected_status`,
      );
    }
  }
}

export function validateAutocompletePredictions(
  predictions: readonly AutocompletePrediction[],
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

function buildLatencyMetrics(values: readonly number[]): AutocompleteLatencyMetrics {
  const finiteValues = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (finiteValues.length === 0) {
    return {
      measured_count: 0,
      avg_ms: null,
      p95_ms: null,
      max_ms: null,
    };
  }

  let sum = 0;
  let max = 0;
  for (const value of finiteValues) {
    sum += value;
    if (value > max) max = value;
  }
  const p95Index = Math.min(finiteValues.length - 1, Math.ceil(finiteValues.length * 0.95) - 1);

  return {
    measured_count: finiteValues.length,
    avg_ms: sum / finiteValues.length,
    p95_ms: finiteValues[p95Index] ?? null,
    max_ms: max,
  };
}

function addSliceAccumulator(
  target: Map<string, { queryCount: number; recallAt1Total: number; recallAt3Total: number; recallAt5Total: number; mrrTotal: number }>,
  key: string,
  recallAt1: number,
  recallAt3: number,
  recallAt5: number,
  reciprocal: number,
): void {
  const accumulator = target.get(key) ?? {
    queryCount: 0,
    recallAt1Total: 0,
    recallAt3Total: 0,
    recallAt5Total: 0,
    mrrTotal: 0,
  };
  accumulator.queryCount += 1;
  accumulator.recallAt1Total += recallAt1;
  accumulator.recallAt3Total += recallAt3;
  accumulator.recallAt5Total += recallAt5;
  accumulator.mrrTotal += reciprocal;
  target.set(key, accumulator);
}

function materializeSlices(
  source: ReadonlyMap<string, { queryCount: number; recallAt1Total: number; recallAt3Total: number; recallAt5Total: number; mrrTotal: number }>,
): Record<string, AutocompleteSliceMetrics> {
  const output: Record<string, AutocompleteSliceMetrics> = {};
  for (const [key, accumulator] of source) {
    output[key] = {
      query_count: accumulator.queryCount,
      recall_at_1: accumulator.queryCount === 0 ? 0 : accumulator.recallAt1Total / accumulator.queryCount,
      recall_at_3: accumulator.queryCount === 0 ? 0 : accumulator.recallAt3Total / accumulator.queryCount,
      recall_at_5: accumulator.queryCount === 0 ? 0 : accumulator.recallAt5Total / accumulator.queryCount,
      mrr: accumulator.queryCount === 0 ? 0 : accumulator.mrrTotal / accumulator.queryCount,
    };
  }
  return output;
}

export function scoreAutocompleteBenchmark(
  cases: readonly AutocompleteBenchmarkCase[],
  rankedByBenchmarkId: ReadonlyMap<string, RankedPrediction | readonly string[]>,
): AutocompleteBenchmarkReport {
  const categoryAccumulators = new Map<string, { queryCount: number; recallAt1Total: number; recallAt3Total: number; recallAt5Total: number; mrrTotal: number }>();
  const languageAccumulators = new Map<string, { queryCount: number; recallAt1Total: number; recallAt3Total: number; recallAt5Total: number; mrrTotal: number }>();
  const misses: AutocompleteBenchmarkReport['misses'] = [];
  const statusMisses: AutocompleteBenchmarkReport['status_misses'] = [];
  const latencies: number[] = [];

  let queryCount = 0;
  let totalRecallAt1 = 0;
  let totalRecallAt3 = 0;
  let totalRecallAt5 = 0;
  let totalMrr = 0;
  let statusCheckedCount = 0;
  let statusMatchCount = 0;
  let ambiguousExpectedCount = 0;
  let falseExactCount = 0;

  for (const row of cases) {
    const rawPrediction = rankedByBenchmarkId.get(row.benchmark_id);
    const prediction: RankedPrediction = Array.isArray(rawPrediction)
      ? { rankedEntityIds: rawPrediction }
      : rawPrediction ?? { rankedEntityIds: [] };
    const rankedEntityIds = prediction.rankedEntityIds;
    const recallAt1 = recallAtK(rankedEntityIds, row.expected_entity_id, 1);
    const recallAt3 = recallAtK(rankedEntityIds, row.expected_entity_id, 3);
    const recallAt5 = recallAtK(rankedEntityIds, row.expected_entity_id, 5);
    const reciprocal = reciprocalRank(rankedEntityIds, row.expected_entity_id);

    queryCount += 1;
    totalRecallAt1 += recallAt1;
    totalRecallAt3 += recallAt3;
    totalRecallAt5 += recallAt5;
    totalMrr += reciprocal;
    addSliceAccumulator(categoryAccumulators, row.category, recallAt1, recallAt3, recallAt5, reciprocal);
    addSliceAccumulator(languageAccumulators, row.language, recallAt1, recallAt3, recallAt5, reciprocal);

    if (prediction.latencyMs !== undefined) {
      latencies.push(prediction.latencyMs);
    }

    if (recallAt5 === 0 && misses.length < 25) {
      misses.push({
        benchmark_id: row.benchmark_id,
        query: row.query,
        expected_entity_id: row.expected_entity_id,
        category: row.category,
        language: row.language,
        top_entity_id: rankedEntityIds[0] ?? null,
        top_5: rankedEntityIds.slice(0, 5),
      });
    }

    if (row.expected_status !== undefined) {
      statusCheckedCount += 1;
      if (row.expected_status === 'ambiguous') {
        ambiguousExpectedCount += 1;
      }
      if (prediction.status === row.expected_status) {
        statusMatchCount += 1;
      } else {
        if (row.expected_status === 'ambiguous' && prediction.status === 'resolved') {
          falseExactCount += 1;
        }
        if (statusMisses.length < 25) {
          statusMisses.push({
            benchmark_id: row.benchmark_id,
            query: row.query,
            expected_status: row.expected_status,
            actual_status: prediction.status ?? null,
          });
        }
      }
    }
  }

  return {
    benchmark: 'autocomplete-benchmark',
    query_count: queryCount,
    recall_at_1: queryCount === 0 ? 0 : totalRecallAt1 / queryCount,
    recall_at_3: queryCount === 0 ? 0 : totalRecallAt3 / queryCount,
    recall_at_5: queryCount === 0 ? 0 : totalRecallAt5 / queryCount,
    mrr: queryCount === 0 ? 0 : totalMrr / queryCount,
    false_exact_rate: ambiguousExpectedCount === 0 ? null : falseExactCount / ambiguousExpectedCount,
    status_checked_count: statusCheckedCount,
    status_match_rate: statusCheckedCount === 0 ? null : statusMatchCount / statusCheckedCount,
    latency: buildLatencyMetrics(latencies),
    by_category: materializeSlices(categoryAccumulators),
    by_language: materializeSlices(languageAccumulators),
    misses,
    status_misses: statusMisses,
    source: 'predictions',
    evaluated_at: new Date().toISOString(),
  };
}

export function getAutocompleteQualityViolations(
  report: AutocompleteBenchmarkReport,
  thresholds: AutocompleteBenchmarkThresholds,
): readonly string[] {
  const violations: string[] = [];

  if (thresholds.minRecallAt1 !== undefined && report.recall_at_1 < thresholds.minRecallAt1) {
    violations.push(`recall_at_1=${report.recall_at_1.toFixed(4)} is below required ${thresholds.minRecallAt1.toFixed(4)}`);
  }
  if (thresholds.minRecallAt3 !== undefined && report.recall_at_3 < thresholds.minRecallAt3) {
    violations.push(`recall_at_3=${report.recall_at_3.toFixed(4)} is below required ${thresholds.minRecallAt3.toFixed(4)}`);
  }
  if (thresholds.minRecallAt5 !== undefined && report.recall_at_5 < thresholds.minRecallAt5) {
    violations.push(`recall_at_5=${report.recall_at_5.toFixed(4)} is below required ${thresholds.minRecallAt5.toFixed(4)}`);
  }
  if (thresholds.minMrr !== undefined && report.mrr < thresholds.minMrr) {
    violations.push(`mrr=${report.mrr.toFixed(4)} is below required ${thresholds.minMrr.toFixed(4)}`);
  }
  if (
    thresholds.maxFalseExactRate !== undefined &&
    report.false_exact_rate !== null &&
    report.false_exact_rate > thresholds.maxFalseExactRate
  ) {
    violations.push(`false_exact_rate=${report.false_exact_rate.toFixed(4)} is above allowed ${thresholds.maxFalseExactRate.toFixed(4)}`);
  }
  if (
    thresholds.maxP95LatencyMs !== undefined &&
    report.latency.p95_ms !== null &&
    report.latency.p95_ms > thresholds.maxP95LatencyMs
  ) {
    violations.push(`latency.p95_ms=${report.latency.p95_ms.toFixed(2)} is above allowed ${thresholds.maxP95LatencyMs.toFixed(2)}`);
  }

  if (thresholds.enforceMinRecallAt3ByCategory === true && thresholds.minRecallAt3 !== undefined) {
    for (const [category, metrics] of Object.entries(report.by_category)) {
      if (metrics.recall_at_3 < thresholds.minRecallAt3) {
        violations.push(`category.${category}.recall_at_3=${metrics.recall_at_3.toFixed(4)} is below required ${thresholds.minRecallAt3.toFixed(4)}`);
      }
    }
  }

  if (thresholds.enforceMinRecallAt3ByLanguage === true && thresholds.minRecallAt3 !== undefined) {
    for (const [language, metrics] of Object.entries(report.by_language)) {
      if (metrics.recall_at_3 < thresholds.minRecallAt3) {
        violations.push(`language.${language}.recall_at_3=${metrics.recall_at_3.toFixed(4)} is below required ${thresholds.minRecallAt3.toFixed(4)}`);
      }
    }
  }

  return violations;
}

export function assertAutocompleteQualityThresholds(
  report: AutocompleteBenchmarkReport,
  thresholds: AutocompleteBenchmarkThresholds,
): void {
  const violations = getAutocompleteQualityViolations(report, thresholds);
  if (violations.length > 0) {
    throw new Error(`Autocomplete quality gate failed:\n- ${violations.join('\n- ')}`);
  }
}

export async function loadAutocompleteBenchmark(
  path = DEFAULT_INPUT,
): Promise<AutocompleteBenchmarkCase[]> {
  const cases = await readValidatedJsonl(path, AutocompleteBenchmarkCaseSchema);
  validateAutocompleteBenchmark(cases);
  return cases;
}

export async function loadAutocompletePredictions(
  path: string,
  benchmarkIds?: ReadonlySet<string>,
): Promise<Map<string, RankedPrediction>> {
  const records = await readValidatedJsonl(path, AutocompletePredictionSchema);
  validateAutocompletePredictions(records, benchmarkIds);
  return new Map(records.map((record) => {
    const rankedEntityIds = record.ranked_entity_ids ?? record.ranked_entities?.map((entity) => entity.entity_id) ?? [];
    return [record.benchmark_id, {
      rankedEntityIds,
      status: record.status,
      latencyMs: record.latency_ms,
    }] as const;
  }));
}

export function buildPerfectAutocompletePredictions(
  cases: readonly AutocompleteBenchmarkCase[],
): Map<string, RankedPrediction> {
  return new Map(cases.map((benchmarkCase) => [
    benchmarkCase.benchmark_id,
    {
      rankedEntityIds: [benchmarkCase.expected_entity_id],
      status: benchmarkCase.expected_status ?? 'resolved',
      latencyMs: 1,
    },
  ]));
}

export function extractAutocompleteRankedEntityIds(responseBody: unknown): readonly string[] {
  if (typeof responseBody !== 'object' || responseBody === null) return [];
  const body = responseBody as Record<string, unknown>;
  const suggestions = Array.isArray(body['suggestions'])
    ? body['suggestions'] as Record<string, unknown>[]
    : [];

  return suggestions
    .map((suggestion) => {
      const entity = (suggestion['entity'] ?? {}) as Record<string, unknown>;
      const entityId = entity['entity_id'] ?? entity['entityId'] ?? suggestion['entity_id'] ?? suggestion['entityId'];
      return typeof entityId === 'string' ? entityId : '';
    })
    .filter((entityId) => entityId.length > 0);
}

export function extractAutocompleteStatus(responseBody: unknown): AutocompleteStatus | undefined {
  if (typeof responseBody !== 'object' || responseBody === null) return undefined;
  const status = (responseBody as Record<string, unknown>)['status'];
  return status === 'resolved' || status === 'ambiguous' || status === 'failed'
    ? status
    : undefined;
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

function benchmarkContextForLanguage(
  language: AutocompleteBenchmarkCase['language'],
): { readonly locale: string; readonly currency: string } {
  switch (language) {
    case 'ko':
    case 'mixed':
      return { locale: 'ko-KR', currency: 'KRW' };
    case 'en':
    default:
      return { locale: 'en-US', currency: 'USD' };
  }
}

export async function evaluateAutocompleteBenchmarkWithUseCase(
  autocompleteUseCase: AutocompleteUseCasePort,
  options: AutocompleteUseCaseBenchmarkOptions = {},
): Promise<AutocompleteBenchmarkReport> {
  const cases = await loadAutocompleteBenchmark(options.input ?? DEFAULT_INPUT);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const rankedByBenchmarkId = new Map(await mapPool(
    cases,
    concurrency,
    async (benchmarkCase) => {
      const start = performance.now();
      const response = await autocompleteUseCase.execute({
        query: benchmarkCase.query,
        context: benchmarkContextForLanguage(benchmarkCase.language),
        requestId: `autocomplete-bench-${benchmarkCase.benchmark_id}`,
      });
      const latencyMs = performance.now() - start;
      return [benchmarkCase.benchmark_id, {
        rankedEntityIds: response.suggestions.map((suggestion) => suggestion.entity.entity_id),
        status: extractAutocompleteStatus(response),
        latencyMs,
      }] as const;
    },
  ));

  const report = scoreAutocompleteBenchmark(cases, rankedByBenchmarkId);
  return {
    ...report,
    source: 'autocomplete-usecase',
    evaluated_at: new Date().toISOString(),
  };
}

export async function fetchLiveAutocompleteRankings(
  cases: readonly AutocompleteBenchmarkCase[],
  apiUrl: string,
  timeoutMs: number,
  concurrency: number,
): Promise<Map<string, RankedPrediction>> {
  const endpoint = new URL('/v1/entity/autocomplete', apiUrl).toString();
  const mappings = await mapPool(
    cases,
    concurrency,
    async (benchmarkCase) => {
      const payload = {
        query: benchmarkCase.query,
        context: benchmarkContextForLanguage(benchmarkCase.language),
      };
      const start = performance.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = performance.now() - start;
      if (!response.ok) {
        return [benchmarkCase.benchmark_id, { rankedEntityIds: [], latencyMs }] as const;
      }
      const body = await response.json() as unknown;
      return [benchmarkCase.benchmark_id, {
        rankedEntityIds: extractAutocompleteRankedEntityIds(body),
        status: extractAutocompleteStatus(body),
        latencyMs,
      }] as const;
    },
  );

  return new Map(mappings);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadAutocompleteBenchmark(args.input);
  const rankedByBenchmarkId = args.smokePredictions
    ? buildPerfectAutocompletePredictions(cases)
    : args.predictions !== null
    ? await loadAutocompletePredictions(args.predictions, new Set(cases.map((item) => item.benchmark_id)))
    : await fetchLiveAutocompleteRankings(cases, args.apiUrl, args.timeoutMs, args.concurrency);

  const report = scoreAutocompleteBenchmark(cases, rankedByBenchmarkId);
  const finalReport: AutocompleteBenchmarkReport = {
    ...report,
    source: args.predictions !== null || args.smokePredictions ? 'predictions' : 'live-api',
    evaluated_at: new Date().toISOString(),
  };

  await fs.writeFile(args.output, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');

  console.log('Autocomplete benchmark complete');
  console.log(`  cases:       ${finalReport.query_count}`);
  console.log(`  recall@1:    ${finalReport.recall_at_1.toFixed(4)}`);
  console.log(`  recall@3:    ${finalReport.recall_at_3.toFixed(4)}`);
  console.log(`  recall@5:    ${finalReport.recall_at_5.toFixed(4)}`);
  console.log(`  mrr:         ${finalReport.mrr.toFixed(4)}`);
  console.log(`  false_exact: ${finalReport.false_exact_rate === null ? 'n/a' : finalReport.false_exact_rate.toFixed(4)}`);
  console.log(`  p95_ms:      ${finalReport.latency.p95_ms === null ? 'n/a' : finalReport.latency.p95_ms.toFixed(2)}`);
  console.log(`  output:      ${args.output}`);
  console.log(`  source:      ${finalReport.source}`);

  assertAutocompleteQualityThresholds(finalReport, {
    minRecallAt1: args.minRecallAt1,
    minRecallAt3: args.minRecallAt3,
    minRecallAt5: args.minRecallAt5,
    minMrr: args.minMrr,
    maxFalseExactRate: args.maxFalseExactRate,
    maxP95LatencyMs: args.maxP95LatencyMs,
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
