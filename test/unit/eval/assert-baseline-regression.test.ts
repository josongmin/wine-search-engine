import { describe, expect, it } from 'vitest';
import {
  compareNoisyRegression,
  compareOfflineRegression,
  type NoisyEvalReport,
  type OfflineEvalReport,
} from '../../../scripts/eval/assert-baseline-regression.js';

describe('assert-baseline-regression', () => {
  it('passes offline reports within thresholds', () => {
    const baseline: OfflineEvalReport = {
      dataset_tier: 'bronze',
      query_count: 100,
      ndcg_at_10: 0.65,
      mrr_at_10: 0.62,
      recall_at_100: 0.81,
      wrong_top1_rate: 0.01,
    };
    const current: OfflineEvalReport = {
      ...baseline,
      ndcg_at_10: 0.64,
      mrr_at_10: 0.61,
      recall_at_100: 0.80,
      wrong_top1_rate: 0.01,
    };

    expect(compareOfflineRegression(current, baseline, {
      ndcg_at_10_max_drop: 0.02,
      mrr_at_10_max_drop: 0.02,
      recall_at_100_max_drop: 0.02,
      wrong_top1_rate_max_increase: 0,
    })).toEqual([]);
  });

  it('fails offline reports that regress beyond thresholds', () => {
    const baseline: OfflineEvalReport = {
      dataset_tier: 'bronze',
      query_count: 100,
      ndcg_at_10: 0.65,
      mrr_at_10: 0.62,
      recall_at_100: 0.81,
      wrong_top1_rate: 0.01,
    };
    const current: OfflineEvalReport = {
      ...baseline,
      ndcg_at_10: 0.60,
      wrong_top1_rate: 0.03,
    };

    const violations = compareOfflineRegression(current, baseline, {
      ndcg_at_10_max_drop: 0.02,
      mrr_at_10_max_drop: 0.02,
      recall_at_100_max_drop: 0.02,
      wrong_top1_rate_max_increase: 0,
    });

    expect(violations.map((violation) => violation.metric)).toEqual([
      'ndcg_at_10',
      'wrong_top1_rate',
    ]);
  });

  it('passes noisy reports within thresholds', () => {
    const baseline: NoisyEvalReport = {
      benchmark: 'noisy-entity-benchmark',
      query_count: 30,
      recall_at_1: 0.95,
      recall_at_3: 1,
      mrr: 0.98,
      false_exact_rate: 0,
    };
    const current: NoisyEvalReport = {
      ...baseline,
      recall_at_3: 0.99,
      mrr: 0.97,
    };

    expect(compareNoisyRegression(current, baseline, {
      recall_at_3_max_drop: 0.02,
      mrr_max_drop: 0.02,
      false_exact_rate_max_increase: 0,
    })).toEqual([]);
  });

  it('fails noisy reports that regress beyond thresholds', () => {
    const baseline: NoisyEvalReport = {
      benchmark: 'noisy-entity-benchmark',
      query_count: 30,
      recall_at_1: 0.95,
      recall_at_3: 1,
      mrr: 0.98,
      false_exact_rate: 0,
    };
    const current: NoisyEvalReport = {
      ...baseline,
      recall_at_3: 0.95,
      mrr: 0.95,
      false_exact_rate: 0.01,
    };

    const violations = compareNoisyRegression(current, baseline, {
      recall_at_3_max_drop: 0.02,
      mrr_max_drop: 0.02,
      false_exact_rate_max_increase: 0,
    });

    expect(violations.map((violation) => violation.metric)).toEqual([
      'recall_at_3',
      'mrr',
      'false_exact_rate',
    ]);
  });
});
