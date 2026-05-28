import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUITES,
  buildPerfectEntityRetrievalPredictions,
  parseArgs,
  scoreEntityRetrievalFixtureCases,
} from '../../../scripts/eval/run-entity-retrieval-fixture-eval.ts';
import type { FixtureEntityBenchmarkCase } from '../../../scripts/eval/external-fixture-benchmark.ts';

describe('entity retrieval fixture eval', () => {
  it('includes noisy_attribute_recovery in the default suite set', () => {
    expect(DEFAULT_SUITES).toContain('noisy_attribute_recovery');
    expect(parseArgs([]).suites).toEqual(DEFAULT_SUITES);
  });

  it('scores exact, ambiguous, and mixed-script suites with suite-specific semantics', () => {
    const cases: FixtureEntityBenchmarkCase[] = [
      {
        benchmark_id: 'eek-001',
        suite: 'exact_entity_recovery',
        query: '오푸스원',
        expected_entity_id: 'opus-one-2018',
        category: 'transliteration',
        language: 'ko',
        difficulty: 'easy',
        top_k: 1,
        clarify_acceptable: false,
        confident_wrong_top1_forbidden: true,
        expected_resolution: 'resolved',
      },
      {
        benchmark_id: 'asf-001',
        suite: 'ambiguous_shortform',
        query: '마고',
        expected_entity_id: 'chateau-margaux-2015',
        category: 'noisy_short_form',
        language: 'ko',
        difficulty: 'hard',
        top_k: 1,
        clarify_acceptable: true,
        confident_wrong_top1_forbidden: true,
        expected_resolution: 'ambiguous',
      },
      {
        benchmark_id: 'mse-001',
        suite: 'mixed_script_entity',
        query: '오푸스원 2018 Napa Valley',
        expected_entity_id: 'opus-one-2018',
        category: 'mixed_language',
        language: 'mixed',
        difficulty: 'medium',
        top_k: 3,
        clarify_acceptable: false,
        confident_wrong_top1_forbidden: true,
        expected_resolution: 'resolved',
      },
    ];

    const predictions = new Map([
      ['eek-001', { rankedEntities: [{ entity_id: 'opus-one-2018' }], decisionStatus: 'resolved' as const }],
      ['asf-001', { rankedEntities: [{ entity_id: 'wrong-top1' }], decisionStatus: 'ambiguous' as const }],
      ['mse-001', { rankedEntities: [{ entity_id: 'wrong-top1' }, { entity_id: 'opus-one-2018' }], decisionStatus: 'resolved' as const }],
    ]);

    const report = scoreEntityRetrievalFixtureCases(cases, predictions);
    const exact = report.suites.find((suite) => suite.suite_id === 'exact_entity_recovery');
    const ambiguous = report.suites.find((suite) => suite.suite_id === 'ambiguous_shortform');
    const mixed = report.suites.find((suite) => suite.suite_id === 'mixed_script_entity');

    expect(exact?.top1_accuracy).toBe(1);
    expect(exact?.case_pass_rate).toBe(1);

    expect(ambiguous?.safe_response_rate).toBe(1);
    expect(ambiguous?.wrong_confident_top1_rate).toBe(0);
    expect(ambiguous?.case_pass_rate).toBe(1);

    expect(mixed?.top1_accuracy).toBe(0);
    expect(mixed?.topk_accuracy).toBe(1);
    expect(mixed?.case_pass_rate).toBe(0);
  });

  it('builds perfect fixture predictions from benchmark truth', () => {
    const cases: FixtureEntityBenchmarkCase[] = [{
      benchmark_id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: '오푸스원',
      expected_entity_id: 'opus-one-2018',
      category: 'transliteration',
      language: 'ko',
      difficulty: 'easy',
      top_k: 1,
      clarify_acceptable: false,
      confident_wrong_top1_forbidden: true,
      expected_resolution: 'resolved',
    }];

    const predictions = buildPerfectEntityRetrievalPredictions(cases);
    expect(predictions.get('eek-001')).toEqual({
      rankedEntities: [{ entity_id: 'opus-one-2018' }],
      decisionStatus: 'resolved',
    });
  });
});
