import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAutocompleteQualityThresholds,
  buildPerfectAutocompletePredictions,
  evaluateAutocompleteBenchmarkWithUseCase,
  extractAutocompleteRankedEntityIds,
  extractAutocompleteStatus,
  getAutocompleteQualityViolations,
  loadAutocompleteBenchmark,
  scoreAutocompleteBenchmark,
  validateAutocompleteBenchmark,
  type AutocompleteBenchmarkCase,
} from '../../../scripts/eval/run-autocomplete-eval.ts';
import { resolveDataPath } from '../../../src/shared/utils/data-paths.js';
import { createTestContainer } from '../../integration/helpers/test-container.js';

describe('autocomplete benchmark eval', () => {
  const repoDataDir = path.resolve(process.cwd(), 'data');
  const previousWineDataDir = process.env['WINE_DATA_DIR'];

  beforeAll(() => {
    process.env['WINE_DATA_DIR'] = repoDataDir;
  });

  afterAll(() => {
    if (previousWineDataDir === undefined) {
      delete process.env['WINE_DATA_DIR'];
      return;
    }
    process.env['WINE_DATA_DIR'] = previousWineDataDir;
  });

  it('loads the autocomplete benchmark artifact with expected slice coverage', async () => {
    const cases = await loadAutocompleteBenchmark(resolveDataPath('data/autocomplete-benchmark.jsonl'));

    expect(cases).toHaveLength(15);

    const categoryCounts = new Map<string, number>();
    const languageCounts = new Map<string, number>();
    for (const item of cases) {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
      languageCounts.set(item.language, (languageCounts.get(item.language) ?? 0) + 1);
    }

    expect(categoryCounts).toEqual(new Map([
      ['latin_prefix', 4],
      ['hangul_prefix', 7],
      ['hangul_ime', 1],
      ['ambiguous_short', 1],
      ['acronym', 1],
      ['diacriticless', 1],
    ]));
    expect(languageCounts).toEqual(new Map([
      ['en', 6],
      ['ko', 9],
    ]));
  });

  it('scores Recall@1/3/5, MRR, false-exact rate, and latency', () => {
    const cases: AutocompleteBenchmarkCase[] = [
      {
        benchmark_id: 'case-1',
        query: 'op',
        expected_entity_id: 'entity-a',
        category: 'latin_prefix',
        language: 'en',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'case-2',
        query: '마고',
        expected_entity_id: 'entity-b',
        category: 'ambiguous_short',
        language: 'ko',
        difficulty: 'hard',
        expected_status: 'ambiguous',
      },
      {
        benchmark_id: 'case-3',
        query: 'drc',
        expected_entity_id: 'entity-c',
        category: 'acronym',
        language: 'en',
        difficulty: 'hard',
      },
    ];

    const report = scoreAutocompleteBenchmark(cases, new Map([
      ['case-1', { rankedEntityIds: ['entity-a'], status: 'resolved', latencyMs: 10 }],
      ['case-2', { rankedEntityIds: ['entity-x', 'entity-b'], status: 'resolved', latencyMs: 20 }],
      ['case-3', { rankedEntityIds: ['entity-x', 'entity-y', 'entity-z'], status: 'failed', latencyMs: 30 }],
    ]));

    expect(report.query_count).toBe(3);
    expect(report.recall_at_1).toBeCloseTo(1 / 3, 10);
    expect(report.recall_at_3).toBeCloseTo(2 / 3, 10);
    expect(report.recall_at_5).toBeCloseTo(2 / 3, 10);
    expect(report.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
    expect(report.false_exact_rate).toBe(1);
    expect(report.status_match_rate).toBe(0);
    expect(report.latency.measured_count).toBe(3);
    expect(report.latency.avg_ms).toBe(20);
    expect(report.latency.p95_ms).toBe(30);
    expect(report.misses).toHaveLength(1);
  });

  it('builds perfect predictions for smoke runs', async () => {
    const cases = await loadAutocompleteBenchmark(resolveDataPath('data/autocomplete-benchmark.jsonl'));
    const report = scoreAutocompleteBenchmark(cases, buildPerfectAutocompletePredictions(cases));

    expect(report.recall_at_1).toBe(1);
    expect(report.recall_at_3).toBe(1);
    expect(report.recall_at_5).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.false_exact_rate).toBe(0);
    expect(report.misses).toHaveLength(0);
  });

  it('rejects duplicate benchmark ids and ambiguous rows without expected status', () => {
    const duplicateCases: AutocompleteBenchmarkCase[] = [
      {
        benchmark_id: 'duplicate',
        query: 'q1',
        expected_entity_id: 'entity-a',
        category: 'latin_prefix',
        language: 'en',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'duplicate',
        query: 'q2',
        expected_entity_id: 'entity-b',
        category: 'hangul_prefix',
        language: 'ko',
        difficulty: 'easy',
      },
    ];

    expect(() => validateAutocompleteBenchmark(duplicateCases)).toThrow(/Duplicate benchmark_id/);
    expect(() => validateAutocompleteBenchmark([
      {
        benchmark_id: 'ambiguous-missing-status',
        query: '마고',
        expected_entity_id: 'chateau-margaux-2015',
        category: 'ambiguous_short',
        language: 'ko',
        difficulty: 'hard',
      },
    ])).toThrow(/requires expected_status/);
  });

  it('extracts ranked entity ids and status from wire response shape', () => {
    const response = {
      status: 'resolved',
      suggestions: [
        { entity: { entity_id: 'entity-a' } },
        { entity: { entityId: 'entity-b' } },
        { entity_id: 'entity-c' },
      ],
    };

    expect(extractAutocompleteRankedEntityIds(response)).toEqual(['entity-a', 'entity-b', 'entity-c']);
    expect(extractAutocompleteStatus(response)).toBe('resolved');
  });

  it('reports quality gate violations with slice controls', () => {
    const report = scoreAutocompleteBenchmark([
      {
        benchmark_id: 'case-1',
        query: 'op',
        expected_entity_id: 'entity-a',
        category: 'latin_prefix',
        language: 'en',
        difficulty: 'easy',
      },
    ], new Map([
      ['case-1', { rankedEntityIds: [], latencyMs: 200 }],
    ]));

    expect(getAutocompleteQualityViolations(report, {
      minRecallAt1: 1,
      minRecallAt3: 1,
      minRecallAt5: 1,
      minMrr: 1,
      maxP95LatencyMs: 100,
      enforceMinRecallAt3ByCategory: true,
      enforceMinRecallAt3ByLanguage: true,
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('recall_at_1=0.0000'),
      expect.stringContaining('category.latin_prefix.recall_at_3=0.0000'),
      expect.stringContaining('language.en.recall_at_3=0.0000'),
      expect.stringContaining('latency.p95_ms=200.00'),
    ]));

    expect(() => assertAutocompleteQualityThresholds(report, { minRecallAt3: 1 })).toThrow(
      /Autocomplete quality gate failed/,
    );
  });

  it('runs the autocomplete benchmark against the in-process test container', async () => {
    const { container } = createTestContainer();
    const report = await evaluateAutocompleteBenchmarkWithUseCase(container.autocompleteUseCase, {
      input: resolveDataPath('data/autocomplete-benchmark.jsonl'),
      concurrency: 3,
    });

    expect(report.query_count).toBe(15);
    expect(report.recall_at_1).toBe(1);
    expect(report.recall_at_3).toBe(1);
    expect(report.recall_at_5).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.latency.measured_count).toBe(15);
    expect(report.source).toBe('autocomplete-usecase');
  });
});
