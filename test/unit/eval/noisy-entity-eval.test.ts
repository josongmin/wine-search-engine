import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoisyEntityQualityThresholds,
  evaluateNoisyEntityBenchmarkWithSearchExecutor,
  extractRankedEntityIds,
  loadNoisyEntityBenchmark,
  loadNoisyEntityPredictions,
  scoreNoisyEntityBenchmark,
  validateNoisyEntityBenchmark,
  type NoisyEntityBenchmarkCase,
} from '../../../scripts/eval/run-noisy-entity-eval.ts';
import { resolveDataPath } from '../../../src/domain/shared/utils/data-paths.js';

describe('noisy entity benchmark eval', () => {
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

  it('loads the benchmark artifact with the expected category coverage', async () => {
    const cases = await loadNoisyEntityBenchmark(resolveDataPath('data/noisy-entity-benchmark.jsonl'));

    expect(cases).toHaveLength(104);

    const categoryCounts = new Map<string, number>();
    const languageCounts = new Map<string, number>();
    for (const item of cases) {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
      languageCounts.set(item.language, (languageCounts.get(item.language) ?? 0) + 1);
    }

    expect(categoryCounts).toEqual(new Map([
      ['typo', 16],
      ['accent_stripped', 6],
      ['whitespace_collapse_split', 8],
      ['abbreviation', 9],
      ['transliteration', 12],
      ['producer_label_partial', 12],
      ['vintage_partial', 8],
      ['mixed_language', 9],
      ['noisy_short_form', 9],
      ['adversarial_near_miss', 9],
      ['phonetic', 6],
    ]));

    expect(languageCounts.get('en')).toBe(79);
    expect(languageCounts.get('ko')).toBe(16);
    expect(languageCounts.get('mixed')).toBe(9);
  });

  it('scores Recall@1, Recall@3, and MRR from ranked entity ids', () => {
    const cases: NoisyEntityBenchmarkCase[] = [
      {
        benchmark_id: 'case-1',
        query: 'q1',
        expected_entity_id: 'entity-a',
        category: 'typo',
        language: 'en',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'case-2',
        query: 'q2',
        expected_entity_id: 'entity-b',
        category: 'accent_stripped',
        language: 'en',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'case-3',
        query: 'q3',
        expected_entity_id: 'entity-c',
        category: 'transliteration',
        language: 'ko',
        difficulty: 'medium',
      },
      {
        benchmark_id: 'case-4',
        query: 'q4',
        expected_entity_id: 'entity-d',
        category: 'adversarial_near_miss',
        language: 'mixed',
        difficulty: 'hard',
      },
    ];

    const rankedByBenchmarkId = new Map<string, readonly string[]>([
      ['case-1', ['entity-a', 'entity-x', 'entity-y']],
      ['case-2', ['entity-x', 'entity-b', 'entity-y']],
      ['case-3', ['entity-x', 'entity-y', 'entity-c']],
      ['case-4', ['entity-x', 'entity-y', 'entity-z']],
    ]);

    const report = scoreNoisyEntityBenchmark(cases, rankedByBenchmarkId);

    expect(report.query_count).toBe(4);
    expect(report.recall_at_1).toBeCloseTo(0.25, 10);
    expect(report.recall_at_3).toBeCloseTo(0.75, 10);
    expect(report.mrr).toBeCloseTo((1 + 0.5 + (1 / 3) + 0) / 4, 10);
    expect(report.by_category.typo.query_count).toBe(1);
    expect(report.by_language.en.query_count).toBe(2);
    expect(report.misses).toHaveLength(1);
    expect(report.misses[0]?.benchmark_id).toBe('case-4');
  });

  it('loads the smoke predictions fixture and produces a perfect benchmark run', async () => {
    const cases = await loadNoisyEntityBenchmark(resolveDataPath('data/noisy-entity-benchmark.jsonl'));
    const predictions = await loadNoisyEntityPredictions(
      resolveDataPath('data/noisy-entity-predictions-smoke.jsonl'),
      new Set(cases.map((item) => item.benchmark_id)),
    );

    const report = scoreNoisyEntityBenchmark(cases, predictions);

    expect(report.query_count).toBe(104);
    expect(report.recall_at_1).toBe(1);
    expect(report.recall_at_3).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.provenance_checked_count).toBe(18);
    expect(report.provenance_match_rate).toBe(1);
    expect(report.provenance_misses).toHaveLength(0);
    expect(report.resolution_checked_count).toBe(11);
    expect(report.resolution_match_rate).toBe(1);
    expect(report.false_exact_rate).toBe(0);
    expect(report.resolution_misses).toHaveLength(0);
    expect(report.misses).toHaveLength(0);
  });

  it('rejects duplicate benchmark ids in the benchmark artifact', () => {
    const duplicateCases: NoisyEntityBenchmarkCase[] = [
      {
        benchmark_id: 'duplicate',
        query: 'q1',
        expected_entity_id: 'entity-a',
        category: 'typo',
        language: 'en',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'duplicate',
        query: 'q2',
        expected_entity_id: 'entity-b',
        category: 'accent_stripped',
        language: 'en',
        difficulty: 'easy',
      },
    ];

    expect(() => validateNoisyEntityBenchmark(duplicateCases)).toThrow(/Duplicate benchmark_id/);
  });

  it('requires provenance expectations for transliteration and phonetic benchmark rows', () => {
    const invalidCases: NoisyEntityBenchmarkCase[] = [
      {
        benchmark_id: 'case-1',
        query: '오푸스원',
        expected_entity_id: 'opus-one-2018',
        category: 'transliteration',
        language: 'ko',
        difficulty: 'easy',
      },
      {
        benchmark_id: 'case-2',
        query: 'romane conti',
        expected_entity_id: 'romanee-conti-2015',
        category: 'phonetic',
        language: 'en',
        difficulty: 'hard',
        expected_provenance_stage: 'phonetic',
      },
    ];

    expect(() => validateNoisyEntityBenchmark(invalidCases)).toThrow(
      /requires expected_provenance_stage/,
    );
  });

  it('requires ambiguous resolution expectations for short noisy queries', () => {
    const invalidCases: NoisyEntityBenchmarkCase[] = [
      {
        benchmark_id: 'case-1',
        query: 'opus',
        expected_entity_id: 'opus-one-2018',
        category: 'noisy_short_form',
        language: 'en',
        difficulty: 'hard',
      },
    ];

    expect(() => validateNoisyEntityBenchmark(invalidCases)).toThrow(
      /requires expected_resolution/,
    );
  });

  it('extracts ranked entity ids from the current search response shape', () => {
    const ids = extractRankedEntityIds({
      results: [
        { entity: { entityId: 'entity-a' } },
        { entity: { entity_id: 'entity-b' } },
        { entityId: 'entity-c' },
        { entity_id: 'entity-d' },
      ],
    });

    expect(ids).toEqual(['entity-a', 'entity-b', 'entity-c', 'entity-d']);
  });

  it('runs the noisy benchmark against an in-process search executor using camelCase runtime fields', async () => {
    const report = await evaluateNoisyEntityBenchmarkWithSearchExecutor(
      {
        execute: async (request) => ({
          queryType: 'search',
          engineDecision: {
            decisionStatus: request.query === 'opus'
              ? 'ambiguous'
              : 'resolved',
          },
          results: request.query === 'opus'
            ? [
                {
                  entity: {
                    entityId: 'opus-one-2018',
                    provenance: { stage: 'semantic', source: 'dense' },
                  },
                },
              ]
            : [
                {
                  entity: {
                    entityId: request.query === '오푸스 원'
                      ? 'opus-one-2018'
                      : 'masseto-2020',
                    provenance: {
                      stage: request.query === '오푸스 원' ? 'transliteration' : 'semantic',
                      source: request.query === '오푸스 원' ? 'ko_alias' : 'dense',
                    },
                  },
                },
              ],
          meta: {},
        }) as never,
      },
      {
        input: resolveDataPath('data/noisy-entity-benchmark.jsonl'),
        concurrency: 2,
      },
    );

    expect(report.source).toBe('search-executor');
    expect(report.query_count).toBe(104);
    expect(report.recall_at_3).toBeGreaterThan(0);
    expect(report.resolution_checked_count).toBeGreaterThan(0);
    expect(report.by_category.transliteration).toBeDefined();
  });

  it('fails when noisy quality thresholds are violated', () => {
    expect(() =>
      assertNoisyEntityQualityThresholds(
        {
          benchmark: 'noisy-entity-benchmark',
          query_count: 10,
          recall_at_1: 0.6,
          recall_at_3: 0.7,
          mrr: 0.65,
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
          source: 'predictions',
          evaluated_at: new Date().toISOString(),
        },
        {
          minRecallAt3: 0.9,
          minResolutionMatchRate: 0.8,
          minProvenanceMatchRate: 0.8,
          maxFalseExactRate: 0.1,
        },
      ),
    ).toThrow(/Noisy entity quality gate failed/);
  });

  it('passes when noisy quality thresholds are satisfied', () => {
    expect(() =>
      assertNoisyEntityQualityThresholds(
        {
          benchmark: 'noisy-entity-benchmark',
          query_count: 10,
          recall_at_1: 0.9,
          recall_at_3: 1,
          mrr: 0.95,
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
          source: 'predictions',
          evaluated_at: new Date().toISOString(),
        },
        {
          minRecallAt3: 0.9,
          minResolutionMatchRate: 0.8,
          minProvenanceMatchRate: 0.8,
          maxFalseExactRate: 0.1,
        },
      ),
    ).not.toThrow();
  });

  it('fails when a category or language slice falls below the release floor', () => {
    expect(() =>
      assertNoisyEntityQualityThresholds(
        {
          benchmark: 'noisy-entity-benchmark',
          query_count: 10,
          recall_at_1: 0.95,
          recall_at_3: 1,
          mrr: 0.97,
          by_category: {
            transliteration: { query_count: 2, recall_at_1: 1, recall_at_3: 0.5, mrr: 0.75 },
          },
          by_language: {
            ko: { query_count: 2, recall_at_1: 1, recall_at_3: 0.5, mrr: 0.75 },
          },
          misses: [],
          provenance_checked_count: 2,
          provenance_match_rate: 1,
          provenance_misses: [],
          resolution_checked_count: 2,
          resolution_match_rate: 1,
          false_exact_rate: 0,
          resolution_misses: [],
          source: 'predictions',
          evaluated_at: new Date().toISOString(),
        },
        {
          minRecallAt3: 1,
          enforceMinRecallAt3ByCategory: true,
          enforceMinRecallAt3ByLanguage: true,
        },
      ),
    ).toThrow(/category\.transliteration\.recall_at_3=0.5000/);
  });
});
