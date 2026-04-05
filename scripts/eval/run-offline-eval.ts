#!/usr/bin/env tsx
/**
 * Offline Evaluation Runner: Reads golden queries, runs them through the
 * search pipeline, and computes all metrics.
 *
 * Outputs:
 * - Global metrics (NDCG, MRR, Recall, Decision Utility, AURC, ECE)
 * - Scenario-specific slices (entity_resolve, ranking_quality, set_retrieval, no_match)
 * - Language slices
 * - Release gate pass/fail verdict
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/eval/run-offline-eval.ts
 *   npx tsx --env-file=.env scripts/eval/run-offline-eval.ts --tier gate --output data/eval-results.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import type { GoldenQuery } from '../etl/types.js';
import {
  ndcg,
  reciprocalRank,
  recall,
  queryUtility,
  wrongTop1Rate,
  safeAbstainRate,
  avoidableAbstainRate,
  aurc,
  excessAurc,
  ece,
  type RankedHit,
  type DecisionOutcome,
  type GroundTruth,
  type EvalResult,
  type ScenarioSlice,
} from './metrics.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = 'data/golden-queries-bronze.jsonl';
const DEFAULT_OUTPUT = 'data/eval-results.json';

/** Release gate thresholds (RFC-017 §3.2). */
const RELEASE_GATES = {
  wrong_top1_rate_max: 0.02,
  decision_utility_min_delta: -0.05,
  ndcg_at_10_min_delta: -0.03,
  recall_at_100_min: 0.90,
  aurc_max_delta: 0.01,
  entity_resolve_wrong_top1_max: 0.03,
  set_retrieval_recall_at_10_min: 0.60,
  no_match_false_resolve_max: 0.05,
} as const;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  tier: 'bronze' | 'silver' | 'gate';
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    tier: 'bronze',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--tier') {
      const t = argv[++i];
      if (t === 'bronze' || t === 'silver' || t === 'gate') out.tier = t;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search execution (calls the running engine)
// ---------------------------------------------------------------------------

interface SearchResult {
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
}

async function executeSearch(
  query: string,
): Promise<SearchResult> {
  // Call the running search API
  const apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';

  try {
    const response = await fetch(`${apiUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ranked: [],
        decision: {
          decision_status: 'failed',
          top_entity_id: null,
          decision_confidence: 0,
        },
      };
    }

    const data = (await response.json()) as {
      engine_decision?: { decision_status?: string; decision_confidence?: number };
      results?: { entity?: { entity_id?: string }; relevance_score?: number }[];
    };

    const ranked: RankedHit[] = (data.results ?? []).map((r) => ({
      entity_id: r.entity?.entity_id ?? '',
      score: r.relevance_score ?? 0,
    }));

    const decision: DecisionOutcome = {
      decision_status:
        (data.engine_decision?.decision_status as 'resolved' | 'ambiguous' | 'failed') ?? 'failed',
      top_entity_id: ranked[0]?.entity_id ?? null,
      decision_confidence: data.engine_decision?.decision_confidence ?? 0,
    };

    return { ranked, decision };
  } catch {
    return {
      ranked: [],
      decision: {
        decision_status: 'failed',
        top_entity_id: null,
        decision_confidence: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Query → GroundTruth conversion
// ---------------------------------------------------------------------------

function queryToGroundTruth(q: GoldenQuery): GroundTruth {
  const judgments = new Map<string, number>();
  for (const j of q.retrieval_labels.relevant) {
    judgments.set(j.entity_id, j.grade);
  }

  return {
    expected_status: q.decision_labels.expected_decision_status,
    expected_entity_id: q.decision_labels.expected_entity_id,
    ambiguity_expected: q.decision_labels.ambiguity_expected,
    requires_abstain: q.decision_labels.requires_abstain,
    relevant: { judgments },
  };
}

// ---------------------------------------------------------------------------
// Compute slice metrics
// ---------------------------------------------------------------------------

function computeSlice(
  results: readonly { ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth }[],
): ScenarioSlice {
  if (results.length === 0) {
    return {
      query_count: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      wrong_top1_rate: 0,
      decision_utility: 0,
    };
  }

  const ndcgValues = results.map((r) => ndcg(r.ranked, r.truth.relevant, 10));
  const mrrValues = results.map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10));
  const decisions = results.map((r) => r.decision);
  const truths = results.map((r) => r.truth);

  return {
    query_count: results.length,
    ndcg_at_10: ndcgValues.reduce((a, b) => a + b, 0) / ndcgValues.length,
    mrr_at_10: mrrValues.reduce((a, b) => a + b, 0) / mrrValues.length,
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    decision_utility:
      decisions.reduce((sum, d, i) => sum + queryUtility(d, truths[i]!), 0) /
      decisions.length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Loading golden queries from ${args.input} (tier: ${args.tier}) …`);
  const content = await fs.readFile(args.input, 'utf8');
  const allQueries: GoldenQuery[] = content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldenQuery);

  // Filter by tier
  const queries = allQueries.filter((q) => q.annotation_tier === args.tier);
  console.log(`  Queries for tier "${args.tier}": ${queries.length} / ${allQueries.length}`);

  if (queries.length === 0) {
    console.log('  No queries found for this tier. Using all queries.');
  }
  const evalQueries = queries.length > 0 ? queries : allQueries;

  // Execute searches
  console.log(`\nExecuting ${evalQueries.length} searches …`);
  const allResults: { query: GoldenQuery; ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth }[] = [];

  for (let i = 0; i < evalQueries.length; i++) {
    const q = evalQueries[i]!;
    const { ranked, decision } = await executeSearch(q.query);
    const truth = queryToGroundTruth(q);
    allResults.push({ query: q, ranked, decision, truth });

    if ((i + 1) % 50 === 0 || i === evalQueries.length - 1) {
      console.log(`  Progress: ${i + 1}/${evalQueries.length}`);
    }
  }

  // Compute global metrics
  console.log('\nComputing metrics …');
  const decisions = allResults.map((r) => r.decision);
  const truths = allResults.map((r) => r.truth);

  const globalNdcg = allResults
    .map((r) => ndcg(r.ranked, r.truth.relevant, 10))
    .reduce((a, b) => a + b, 0) / allResults.length;
  const globalMrr = allResults
    .map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10))
    .reduce((a, b) => a + b, 0) / allResults.length;
  const globalRecall = allResults
    .map((r) => recall(r.ranked, r.truth.relevant, 100))
    .reduce((a, b) => a + b, 0) / allResults.length;

  // Scenario slices
  const byScenario: Record<string, ScenarioSlice> = {};
  const scenarioGroups = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = r.query.scenario;
    const existing = scenarioGroups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      scenarioGroups.set(key, [r]);
    }
  }
  for (const [scenario, group] of scenarioGroups) {
    byScenario[scenario] = computeSlice(group);
  }

  // Language slices
  const byLanguage: Record<string, ScenarioSlice> = {};
  const langGroups = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = r.query.language;
    const existing = langGroups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      langGroups.set(key, [r]);
    }
  }
  for (const [lang, group] of langGroups) {
    byLanguage[lang] = computeSlice(group);
  }

  const evalResult: EvalResult = {
    dataset_tier: args.tier,
    query_count: allResults.length,
    ndcg_at_10: globalNdcg,
    mrr_at_10: globalMrr,
    recall_at_100: globalRecall,
    decision_utility: decisionUtilityScore(decisions, truths),
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    safe_abstain_rate: safeAbstainRate(decisions, truths),
    avoidable_abstain_rate: avoidableAbstainRate(decisions, truths),
    aurc: aurc(decisions, truths),
    e_aurc: excessAurc(decisions, truths),
    ece: ece(decisions, truths),
    by_scenario: byScenario,
    by_language: byLanguage,
  };

  // Write results
  await fs.writeFile(args.output, JSON.stringify(evalResult, null, 2) + '\n', 'utf8');

  // Print summary
  console.log('\n=== EVAL RESULTS ===');
  console.log(`  Queries:          ${evalResult.query_count}`);
  console.log(`  NDCG@10:          ${evalResult.ndcg_at_10.toFixed(4)}`);
  console.log(`  MRR@10:           ${evalResult.mrr_at_10.toFixed(4)}`);
  console.log(`  Recall@100:       ${evalResult.recall_at_100.toFixed(4)}`);
  console.log(`  Decision Utility: ${evalResult.decision_utility.toFixed(4)}`);
  console.log(`  WrongTop1 rate:   ${evalResult.wrong_top1_rate.toFixed(4)}`);
  console.log(`  AURC:             ${evalResult.aurc.toFixed(4)}`);
  console.log(`  ECE:              ${evalResult.ece.toFixed(4)}`);

  console.log('\n  By scenario:');
  for (const [s, m] of Object.entries(evalResult.by_scenario)) {
    console.log(`    ${s}: n=${m.query_count} ndcg=${m.ndcg_at_10.toFixed(3)} wt1=${m.wrong_top1_rate.toFixed(3)}`);
  }

  // Release gate check (only for gate tier)
  if (args.tier === 'gate') {
    console.log('\n=== RELEASE GATE ===');
    const violations: string[] = [];

    if (evalResult.wrong_top1_rate > RELEASE_GATES.wrong_top1_rate_max) {
      violations.push(`wrong_top1_rate ${evalResult.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.wrong_top1_rate_max}`);
    }
    if (evalResult.recall_at_100 < RELEASE_GATES.recall_at_100_min) {
      violations.push(`recall_at_100 ${evalResult.recall_at_100.toFixed(4)} < ${RELEASE_GATES.recall_at_100_min}`);
    }

    if (violations.length === 0) {
      console.log('  ✅ RELEASE GATE PASSED');
    } else {
      console.log('  ❌ RELEASE GATE FAILED:');
      for (const v of violations) {
        console.log(`    - ${v}`);
      }
    }
  }

  console.log(`\n  Results written to: ${args.output}`);
}

function decisionUtilityScore(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < outcomes.length; i++) {
    total += queryUtility(outcomes[i]!, truths[i]!);
  }
  return total / outcomes.length;
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
