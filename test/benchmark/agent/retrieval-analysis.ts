/**
 * Per-scenario retrieval analysis harness.
 *
 * Wraps the existing retrieval-ceiling-metrics + ranking-metrics primitives
 * to produce per-scenario diagnostics, then aggregates across a benchmark
 * run. Distinguishes "retrieval bottleneck" (didn't find relevant docs) from
 * "ranking bottleneck" (found them but ranked them poorly).
 */

import { computeRetrievalCeiling, diagnoseRankingGap } from './retrieval-ceiling-metrics.js';
import { ndcg_at_k, mrr } from './ranking-metrics.js';
import type { AgentBenchmarkScenario } from './scenario.js';

/** k for nDCG comparison. */
const NDCG_K = 10;

export interface ScenarioRetrievalAnalysis {
  readonly scenarioId: number;
  readonly query: string;
  readonly retrievedCount: number;
  readonly rankedCount: number;
  readonly relevantCount: number;
  readonly recall_at_20: number;
  readonly recall_at_50: number;
  readonly recall_at_100: number;
  readonly oracle_ndcg_at_10: number;
  readonly actual_ndcg_at_10: number;
  readonly oracle_mrr: number;
  readonly actual_mrr: number;
  readonly ranking_efficiency: number;
  readonly gap: 'retrieval_bottleneck' | 'ranking_bottleneck' | 'both' | 'neither';
}

export interface RetrievalAnalysisSummary {
  readonly scenarioCount: number;
  readonly mean_recall_at_20: number;
  readonly mean_recall_at_50: number;
  readonly mean_recall_at_100: number;
  readonly mean_oracle_ndcg: number;
  readonly mean_actual_ndcg: number;
  readonly mean_ranking_efficiency: number;
  readonly retrieval_bottleneck_count: number;
  readonly ranking_bottleneck_count: number;
  readonly both_count: number;
  readonly neither_count: number;
}

export function analyzeScenarioRetrieval(
  scenario: AgentBenchmarkScenario,
  retrievedIds: readonly string[],
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
): ScenarioRetrievalAnalysis {
  const ceiling = computeRetrievalCeiling(retrievedIds, rankedIds, relevantIds);
  const gap = diagnoseRankingGap(retrievedIds, rankedIds, relevantIds, NDCG_K);
  const actualNdcg = ndcg_at_k(rankedIds, relevantIds, NDCG_K);
  const actualMrr = mrr(rankedIds, relevantIds);

  return {
    scenarioId: scenario.id,
    query: scenario.query,
    retrievedCount: ceiling.retrieved_count,
    rankedCount: ceiling.ranked_count,
    relevantCount: ceiling.relevant_count,
    recall_at_20: ceiling.recall_at_20,
    recall_at_50: ceiling.recall_at_50,
    recall_at_100: ceiling.recall_at_100,
    oracle_ndcg_at_10: ceiling.oracle_ndcg_at_10,
    actual_ndcg_at_10: actualNdcg,
    oracle_mrr: ceiling.oracle_mrr,
    actual_mrr: actualMrr,
    ranking_efficiency: gap.rankingEfficiency,
    gap: gap.gap,
  };
}

function safeMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export function summarizeRetrievalAnalysis(
  analyses: readonly ScenarioRetrievalAnalysis[],
): RetrievalAnalysisSummary {
  if (analyses.length === 0) {
    return {
      scenarioCount: 0,
      mean_recall_at_20: 0,
      mean_recall_at_50: 0,
      mean_recall_at_100: 0,
      mean_oracle_ndcg: 0,
      mean_actual_ndcg: 0,
      mean_ranking_efficiency: 0,
      retrieval_bottleneck_count: 0,
      ranking_bottleneck_count: 0,
      both_count: 0,
      neither_count: 0,
    };
  }

  let retrievalCount = 0;
  let rankingCount = 0;
  let bothCount = 0;
  let neitherCount = 0;
  for (const a of analyses) {
    if (a.gap === 'retrieval_bottleneck') retrievalCount++;
    else if (a.gap === 'ranking_bottleneck') rankingCount++;
    else if (a.gap === 'both') bothCount++;
    else neitherCount++;
  }

  return {
    scenarioCount: analyses.length,
    mean_recall_at_20: safeMean(analyses.map((a) => a.recall_at_20)),
    mean_recall_at_50: safeMean(analyses.map((a) => a.recall_at_50)),
    mean_recall_at_100: safeMean(analyses.map((a) => a.recall_at_100)),
    mean_oracle_ndcg: safeMean(analyses.map((a) => a.oracle_ndcg_at_10)),
    mean_actual_ndcg: safeMean(analyses.map((a) => a.actual_ndcg_at_10)),
    mean_ranking_efficiency: safeMean(analyses.map((a) => a.ranking_efficiency)),
    retrieval_bottleneck_count: retrievalCount,
    ranking_bottleneck_count: rankingCount,
    both_count: bothCount,
    neither_count: neitherCount,
  };
}
