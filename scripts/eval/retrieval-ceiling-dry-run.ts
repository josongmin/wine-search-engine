#!/usr/bin/env tsx
/**
 * Retrieval ceiling DRY-RUN.
 *
 * Walks AGENT_SCENARIOS and — for every scenario — builds a SYNTHETIC
 * retrieved/ranked candidate list with known ground-truth IDs, then runs
 * the analyzeScenarioRetrieval + summarizeRetrievalAnalysis pipeline and
 * writes both a per-scenario report and an aggregate summary to
 * data/retrieval-ceiling/dry-run-baseline.json.
 *
 * Intentionally synthetic:
 *   - NO HTTP calls, NO agent orchestrator, NO Vespa lookups
 *   - Proves the measurement plumbing runs end-to-end and produces
 *     non-zero, sensible numbers before the real retrieval pipeline is
 *     wired in
 *   - The resulting baseline is the "before" snapshot for future diffs
 *     against real runs
 *
 * Ground-truth strategy:
 *   - If scenario.expectation.expectedEntityIds is set, use it verbatim.
 *   - Otherwise, synthesize stable IDs from scenario.id so the dry-run
 *     is fully deterministic across machines.
 *
 * Permutation strategy:
 *   - No Math.random; a fixed interleave places gold and filler IDs at
 *     deterministic positions derived from scenario.id parity.
 *
 * Usage: npx tsx scripts/eval/retrieval-ceiling-dry-run.ts
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

import {
  analyzeScenarioRetrieval,
  summarizeRetrievalAnalysis,
  type ScenarioRetrievalAnalysis,
  type RetrievalAnalysisSummary,
} from '../../test/benchmark/agent/retrieval-analysis.js';
import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';
import {
  RELEVANCE_GOLD_CORPUS,
  resolveFixtureCorpusPath,
} from './fixture-corpus-paths.js';

/** Synthetic gold IDs per scenario when no real ground truth exists. */
const SYNTHETIC_GOLD_COUNT = 3;
/** Synthetic filler (non-relevant) IDs per scenario. */
const FILLER_COUNT = 5;
/** Output path for the exploratory dry-run baseline report. */
const OUTPUT_REL_PATH = 'data/retrieval-ceiling/exploratory-dry-run-baseline.json';
/** Optional hand-crafted gold judgments for exploratory ceiling analysis. */
const LEGACY_GOLD_JUDGMENTS_REL_PATH = 'data/gold-relevance-judgments.jsonl';
/** Minimum grade considered "relevant" for gold-derived ground truth. */
const GOLD_RELEVANCE_THRESHOLD = 2;

/**
 * Load hand-crafted gold judgments from NDJSON, keyed by queryId
 * (`scenario-<id>` convention), returning the set of relevant entityIds
 * per scenario. Missing file → empty map (fall back to synthetic gold).
 */
async function loadGoldRelevanceMap(
  absPath: string,
): Promise<Map<number, readonly string[]>> {
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Map();
    throw err;
  }
  const map = new Map<number, string[]>();
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as {
      queryId?: unknown;
      entityId?: unknown;
      grade?: unknown;
    };
    if (
      typeof obj.queryId !== 'string' ||
      typeof obj.entityId !== 'string' ||
      typeof obj.grade !== 'number'
    ) {
      continue;
    }
    if (obj.grade < GOLD_RELEVANCE_THRESHOLD) continue;
    const match = /^scenario-(\d+)$/.exec(obj.queryId);
    if (match === null || match[1] === undefined) continue;
    const scenarioId = Number.parseInt(match[1], 10);
    if (!Number.isFinite(scenarioId)) continue;
    let list = map.get(scenarioId);
    if (list === undefined) {
      list = [];
      map.set(scenarioId, list);
    }
    if (!list.includes(obj.entityId)) list.push(obj.entityId);
  }
  return map;
}

interface DryRunReport {
  readonly generatedAt: string;
  readonly note: string;
  readonly config: {
    readonly syntheticGoldCount: number;
    readonly fillerCount: number;
    readonly scenarioCount: number;
  };
  readonly summary: RetrievalAnalysisSummary;
  readonly analyses: readonly ScenarioRetrievalAnalysis[];
  readonly groundTruthSources: {
    readonly realExpectedEntityIds: number;
    readonly goldJudgments: number;
    readonly syntheticFallback: number;
  };
}

function syntheticGoldIds(scenario: AgentBenchmarkScenario): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < SYNTHETIC_GOLD_COUNT; i += 1) {
    ids.push(`synthetic-gold-${scenario.id}-${i}`);
  }
  return ids;
}

function syntheticFillerIds(scenario: AgentBenchmarkScenario): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < FILLER_COUNT; i += 1) {
    ids.push(`synthetic-filler-${scenario.id}-${i}`);
  }
  return ids;
}

/**
 * Deterministic permutation: alternates gold/filler, starting with
 * gold on even scenario IDs and filler on odd. No randomness.
 */
function deterministicInterleave(
  gold: readonly string[],
  filler: readonly string[],
  scenarioId: number,
): readonly string[] {
  const merged: string[] = [];
  const goldFirst = scenarioId % 2 === 0;
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const analyses: ScenarioRetrievalAnalysis[] = [];
  let realCount = 0;
  let goldCount = 0;
  let syntheticCount = 0;

  const goldMapAbs = resolveFixtureCorpusPath(RELEVANCE_GOLD_CORPUS)
    ?? path.resolve(process.cwd(), LEGACY_GOLD_JUDGMENTS_REL_PATH);
  const goldRelevanceMap = await loadGoldRelevanceMap(goldMapAbs);
  const goldSourceUsed = goldRelevanceMap.size > 0;

  for (const scenario of AGENT_SCENARIOS) {
    const realGold = scenario.expectation.expectedEntityIds;
    const handGold = goldRelevanceMap.get(scenario.id);
    let gold: readonly string[];
    if (realGold !== undefined && realGold.length > 0) {
      gold = realGold;
      realCount += 1;
    } else if (handGold !== undefined && handGold.length > 0) {
      gold = handGold;
      goldCount += 1;
    } else {
      gold = syntheticGoldIds(scenario);
      syntheticCount += 1;
    }

    const filler = syntheticFillerIds(scenario);
    const retrievedIds = [...gold, ...filler];
    const rankedIds = deterministicInterleave(gold, filler, scenario.id);
    const relevantIds = new Set(gold);

    analyses.push(analyzeScenarioRetrieval(scenario, retrievedIds, rankedIds, relevantIds));
  }

  const summary = summarizeRetrievalAnalysis(analyses);

  const report: DryRunReport = {
    generatedAt: new Date().toISOString(),
    note:
      'EXPLORATORY synthetic dry-run — no live retrieval pipeline. Validates the ' +
      'measurement harness plumbing only. Real ceiling requires a live ' +
      'benchmark run with actual retrieved/ranked IDs from the search ' +
      'pipeline. This report is non-gating and must not be treated as release truth.',
    config: {
      syntheticGoldCount: SYNTHETIC_GOLD_COUNT,
      fillerCount: FILLER_COUNT,
      scenarioCount: AGENT_SCENARIOS.length,
    },
    summary,
    analyses,
    groundTruthSources: {
      realExpectedEntityIds: realCount,
      goldJudgments: goldCount,
      syntheticFallback: syntheticCount,
    },
  };

  const outputAbs = resolveDataPath(OUTPUT_REL_PATH);
  await mkdir(path.dirname(outputAbs), { recursive: true });
  await writeFile(outputAbs, JSON.stringify(report, null, 2), 'utf8');

  // Summary to stderr so `| tee` / piping remains clean.
  const lines: string[] = [];
  lines.push('─── Retrieval Ceiling Dry-Run Summary (EXPLORATORY SYNTHETIC) ───');
  lines.push(`Scenarios analyzed:       ${summary.scenarioCount}`);
  lines.push(
    `Ground truth sources:     real=${realCount}, gold=${goldCount}, synthetic=${syntheticCount}`,
  );
  lines.push(
    `Hand-crafted gold file:   ${goldSourceUsed ? goldMapAbs : '(not found — synthetic only)'}`,
  );
  lines.push(`Mean Recall@20:           ${formatPercent(summary.mean_recall_at_20)}`);
  lines.push(`Mean Recall@50:           ${formatPercent(summary.mean_recall_at_50)}`);
  lines.push(`Mean Recall@100:          ${formatPercent(summary.mean_recall_at_100)}`);
  lines.push(`Mean Oracle NDCG@10:      ${formatPercent(summary.mean_oracle_ndcg)}`);
  lines.push(`Mean Actual NDCG@10:      ${formatPercent(summary.mean_actual_ndcg)}`);
  lines.push(`Mean Ranking Efficiency:  ${formatPercent(summary.mean_ranking_efficiency)}`);
  lines.push('─── Bottleneck Breakdown ───');
  lines.push(`retrieval_bottleneck:     ${summary.retrieval_bottleneck_count}`);
  lines.push(`ranking_bottleneck:       ${summary.ranking_bottleneck_count}`);
  lines.push(`both:                     ${summary.both_count}`);
  lines.push(`neither:                  ${summary.neither_count}`);
  lines.push(`Report written:           ${outputAbs}`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`dry-run failed: ${String(err)}\n`);
  process.exit(1);
});
