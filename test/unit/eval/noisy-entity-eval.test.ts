import { describe, expect, it } from 'vitest';
import {
  NOISY_ENTITY_CATEGORIES,
  extractRankedEntityIds,
  loadNoisyEntityBenchmark,
  loadNoisyEntityPredictions,
  scoreNoisyEntityBenchmark,
  validateNoisyEntityBenchmark,
  type NoisyEntityBenchmarkCase,
} from '../../../scripts/eval/run-noisy-entity-eval.ts';

describe('noisy entity benchmark eval', () => {
  it('loads the benchmark artifact with the expected category coverage', async () => {
    const cases = await loadNoisyEntityBenchmark('data/noisy-entity-benchmark.jsonl');

    expect(cases).toHaveLength(30);

    const categoryCounts = new Map<string, number>();
    const languageCounts = new Map<string, number>();
    for (const item of cases) {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
      languageCounts.set(item.language, (languageCounts.get(item.language) ?? 0) + 1);
    }

    for (const category of NOISY_ENTITY_CATEGORIES) {
      expect(categoryCounts.get(category)).toBe(3);
    }

    expect(languageCounts.get('en')).toBe(23);
    expect(languageCounts.get('ko')).toBe(4);
    expect(languageCounts.get('mixed')).toBe(3);
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
    const cases = await loadNoisyEntityBenchmark('data/noisy-entity-benchmark.jsonl');
    const predictions = await loadNoisyEntityPredictions(
      'data/noisy-entity-predictions-smoke.jsonl',
      new Set(cases.map((item) => item.benchmark_id)),
    );

    const report = scoreNoisyEntityBenchmark(cases, predictions);

    expect(report.query_count).toBe(30);
    expect(report.recall_at_1).toBe(1);
    expect(report.recall_at_3).toBe(1);
    expect(report.mrr).toBe(1);
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
});
