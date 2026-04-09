/**
 * Retrieval ceiling measurement harness smoke test.
 *
 * Validates the analyzeScenarioRetrieval + summarizeRetrievalAnalysis
 * pipeline end-to-end against a small sample of real AGENT_SCENARIOS
 * with SYNTHETIC retrieved/ranked lists. This is NOT a live search
 * benchmark — it exists to prove the measurement wrapping runs on the
 * real scenario shape and produces sensible numbers before we wire in
 * the live retrieval pipeline.
 *
 * The test intentionally fabricates ground-truth entity IDs per scenario
 * because production AGENT_SCENARIOS do not yet carry `expectedEntityIds`.
 * The measurement layer is oblivious to this — it operates on opaque IDs.
 */

import { describe, it, expect } from 'vitest';

import {
  analyzeScenarioRetrieval,
  summarizeRetrievalAnalysis,
  type ScenarioRetrievalAnalysis,
} from '../retrieval-analysis.js';
import { AGENT_SCENARIOS } from '../scenarios.js';
import type { AgentBenchmarkScenario } from '../scenario.js';

/** Number of scenarios sampled from AGENT_SCENARIOS for the smoke run. */
const SAMPLE_SIZE = 8;
/** Number of synthetic ground-truth entity IDs per scenario. */
const GOLD_PER_SCENARIO = 3;
/** Number of synthetic filler (non-relevant) IDs per scenario. */
const FILLER_PER_SCENARIO = 5;

function syntheticGoldIds(scenario: AgentBenchmarkScenario): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < GOLD_PER_SCENARIO; i += 1) {
    ids.push(`gold-${scenario.id}-${i}`);
  }
  return ids;
}

function syntheticFillerIds(scenario: AgentBenchmarkScenario): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < FILLER_PER_SCENARIO; i += 1) {
    ids.push(`filler-${scenario.id}-${i}`);
  }
  return ids;
}

/**
 * Deterministic interleave permutation: alternates filler-first so gold
 * IDs end up at non-top positions, exercising the ranking_bottleneck path
 * for some scenarios.
 */
function interleaveRanking(
  gold: readonly string[],
  filler: readonly string[],
  scenarioIndex: number,
): readonly string[] {
  const merged: string[] = [];
  const goldFirst = scenarioIndex % 2 === 0;
  const maxLen = Math.max(gold.length, filler.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (goldFirst) {
      if (i < gold.length) merged.push(gold[i]!);
      if (i < filler.length) merged.push(filler[i]!);
    } else {
      if (i < filler.length) merged.push(filler[i]!);
      if (i < gold.length) merged.push(gold[i]!);
    }
  }
  return merged;
}

function analyzeSample(): readonly ScenarioRetrievalAnalysis[] {
  const sample = AGENT_SCENARIOS.slice(0, SAMPLE_SIZE);
  const analyses: ScenarioRetrievalAnalysis[] = [];
  sample.forEach((scenario, idx) => {
    const gold = syntheticGoldIds(scenario);
    const filler = syntheticFillerIds(scenario);
    const retrievedIds = [...gold, ...filler];
    const rankedIds = interleaveRanking(gold, filler, idx);
    const relevantIds = new Set(gold);
    analyses.push(analyzeScenarioRetrieval(scenario, retrievedIds, rankedIds, relevantIds));
  });
  return analyses;
}

describe('retrieval ceiling measurement harness smoke', () => {
  it('loads a non-empty sample of real AGENT_SCENARIOS', () => {
    expect(AGENT_SCENARIOS.length).toBeGreaterThan(0);
    const sample = AGENT_SCENARIOS.slice(0, SAMPLE_SIZE);
    expect(sample.length).toBe(SAMPLE_SIZE);
    for (const scenario of sample) {
      expect(typeof scenario.id).toBe('number');
      expect(typeof scenario.query).toBe('string');
    }
  });

  it('analyzeScenarioRetrieval runs without errors on every sampled scenario', () => {
    const analyses = analyzeSample();
    expect(analyses.length).toBe(SAMPLE_SIZE);
    for (const a of analyses) {
      expect(Number.isFinite(a.recall_at_20)).toBe(true);
      expect(Number.isFinite(a.oracle_ndcg_at_10)).toBe(true);
      expect(Number.isFinite(a.actual_ndcg_at_10)).toBe(true);
      expect(Number.isFinite(a.ranking_efficiency)).toBe(true);
      expect(a.retrievedCount).toBe(GOLD_PER_SCENARIO + FILLER_PER_SCENARIO);
      expect(a.relevantCount).toBe(GOLD_PER_SCENARIO);
    }
  });

  it('summary aggregates non-zero, sensible metrics', () => {
    const analyses = analyzeSample();
    const summary = summarizeRetrievalAnalysis(analyses);
    expect(summary.scenarioCount).toBe(SAMPLE_SIZE);
    // Every sampled scenario has full synthetic recall — gold IDs are
    // all inside the retrieved pool by construction.
    expect(summary.mean_recall_at_20).toBeCloseTo(1);
    expect(summary.mean_oracle_ndcg).toBeGreaterThan(0);
    expect(summary.mean_actual_ndcg).toBeGreaterThan(0);
    expect(summary.mean_ranking_efficiency).toBeGreaterThan(0);
    expect(summary.mean_ranking_efficiency).toBeLessThanOrEqual(1);
  });

  it('bottleneck classification hits at least one category', () => {
    const analyses = analyzeSample();
    const summary = summarizeRetrievalAnalysis(analyses);
    const total =
      summary.retrieval_bottleneck_count +
      summary.ranking_bottleneck_count +
      summary.both_count +
      summary.neither_count;
    expect(total).toBe(SAMPLE_SIZE);
    // At least one category must be non-zero (tautological given total
    // equals SAMPLE_SIZE > 0, but asserts each counter is a non-negative
    // integer and the classifier produced a decision for every scenario).
    const anyCategoryHit =
      summary.retrieval_bottleneck_count > 0 ||
      summary.ranking_bottleneck_count > 0 ||
      summary.both_count > 0 ||
      summary.neither_count > 0;
    expect(anyCategoryHit).toBe(true);
    for (const a of analyses) {
      expect(['retrieval_bottleneck', 'ranking_bottleneck', 'both', 'neither']).toContain(a.gap);
    }
  });
});
