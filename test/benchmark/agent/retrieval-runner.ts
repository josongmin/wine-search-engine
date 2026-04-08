/**
 * Retrieval-only benchmark runner.
 *
 * Evaluates the search/retrieval pipeline independently from the agent loop.
 * This allows diagnosing whether low agent scores stem from retrieval failure
 * or agent/LLM failure.
 *
 * Usage:
 *   npx tsx test/benchmark/agent/retrieval-runner.ts
 *   npx tsx test/benchmark/agent/retrieval-runner.ts --limit 20
 *   npx tsx test/benchmark/agent/retrieval-runner.ts --tier single_shot
 *   npx tsx test/benchmark/agent/retrieval-runner.ts --verbose
 *   npx tsx test/benchmark/agent/retrieval-runner.ts --profile retrieval
 *
 * Metrics computed (for scenarios with expectedEntityIds):
 *   - Recall@K  (K = 1, 3, 5, 10)
 *   - MRR       (Mean Reciprocal Rank, first golden in top-10)
 *   - NDCG@5    (graded: 3=exact match, 1=partial, 0=no match)
 *
 * For scenarios without expectedEntityIds, reports coverage (≥1 result returned).
 *
 * Exit codes:
 *   0 — completed successfully
 *   1 — configuration or fatal error
 */

import type { AgentBenchmarkScenario, ScenarioTier } from './scenario.js';
import { AGENT_SCENARIOS } from './scenarios.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Recall@K cutoffs to compute. */
const RECALL_K1 = 1;
const RECALL_K3 = 3;
const RECALL_K5 = 5;

/** Maximum number of results to request from the search API. Also Recall@10 cutoff. */
const SEARCH_TOP_K = 10;

/** NDCG@N cutoff. */
const NDCG_CUTOFF = 5;

/** Graded relevance scores for NDCG computation. */
const RELEVANCE_EXACT = 3;
const RELEVANCE_PARTIAL = 1;
const RELEVANCE_NONE = 0;

/** Fetch timeout for individual search API calls (ms). */
const SEARCH_TIMEOUT_MS = 15_000;

/** Max error body preview length in per-call error strings. */
const ERROR_BODY_PREVIEW_LEN = 200;

/** Max query length in verbose per-scenario output. */
const VERBOSE_QUERY_PREVIEW_LEN = 60;

/** Number of top results shown in verbose mode. Also decimal places in fmt(). */
const VERBOSE_TOP_N = 3;

/** Decimal places for metric output formatting. */
const METRIC_DECIMAL_PLACES = 3;

/** Print progress marker every N scenarios in non-verbose mode. */
const PROGRESS_PRINT_INTERVAL = 50;

/** Max error message length in error summary report. */
const ERROR_SUMMARY_MAX_LEN = 120;

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

interface RetrievalCliArgs {
  readonly baseUrl: string;
  readonly limit?: number;
  readonly tierFilter?: ScenarioTier;
  readonly verbose: boolean;
  /** Forwarded from the agent runner's --profile flag; kept for compat. */
  readonly profile?: string;
}

function parseArgs(): RetrievalCliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const rawLimit = get('--limit');
  const limitParsed = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : undefined;
  const limit = limitParsed !== undefined && Number.isFinite(limitParsed) && limitParsed > 0
    ? limitParsed
    : undefined;

  const baseUrl =
    process.env['BENCHMARK_BASE_URL'] ??
    process.env['API_BASE_URL'] ??
    'http://localhost:3000';

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    limit,
    tierFilter: get('--tier') as ScenarioTier | undefined,
    verbose: has('--verbose'),
    profile: get('--profile'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search API types (validated at runtime)
// ─────────────────────────────────────────────────────────────────────────────

interface EntitySummary {
  entity_id: string;
  canonical_label: string;
  type: string;
  producer?: string;
  region?: string;
}

interface SearchResultItem {
  entity: EntitySummary;
  relevance_score: number;
}

interface SearchApiResponse {
  query_type: string;
  results: SearchResultItem[];
}

/**
 * Runtime guard for the search API response shape.
 * Only asserts the fields we actually use — extra fields are fine.
 */
function isSearchApiResponse(raw: unknown): raw is SearchApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['query_type'] !== 'string') return false;
  if (!Array.isArray(obj['results'])) return false;
  for (const item of obj['results'] as unknown[]) {
    if (typeof item !== 'object' || item === null) return false;
    const r = item as Record<string, unknown>;
    if (typeof r['entity'] !== 'object' || r['entity'] === null) return false;
    const e = r['entity'] as Record<string, unknown>;
    if (typeof e['entity_id'] !== 'string') return false;
    if (typeof e['canonical_label'] !== 'string') return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP search call
// ─────────────────────────────────────────────────────────────────────────────

interface SearchCallResult {
  readonly entityIds: readonly string[];
  readonly labels: readonly string[];
  readonly durationMs: number;
  readonly error?: string;
}

async function callSearchApi(
  baseUrl: string,
  query: string,
): Promise<SearchCallResult> {
  const startMs = Date.now();
  const url = `${baseUrl}/v1/search`;

  let raw: unknown;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      return {
        entityIds: [],
        labels: [],
        durationMs: Date.now() - startMs,
        error: `HTTP ${response.status}: ${body.slice(0, ERROR_BODY_PREVIEW_LEN)}`,
      };
    }

    raw = await response.json();
  } catch (err) {
    return {
      entityIds: [],
      labels: [],
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!isSearchApiResponse(raw)) {
    return {
      entityIds: [],
      labels: [],
      durationMs: Date.now() - startMs,
      error: 'Unexpected response shape from /v1/search',
    };
  }

  const entityIds = raw.results.slice(0, SEARCH_TOP_K).map((r) => r.entity.entity_id);
  const labels = raw.results.slice(0, SEARCH_TOP_K).map((r) => r.entity.canonical_label);

  return { entityIds, labels, durationMs: Date.now() - startMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the graded relevance of a result entity_id against golden IDs.
 * - RELEVANCE_EXACT   (3): exact string match
 * - RELEVANCE_PARTIAL (1): one ID is a substring of the other
 * - RELEVANCE_NONE    (0): no relation
 */
function gradedRelevance(resultId: string, goldens: readonly string[]): number {
  for (const golden of goldens) {
    if (resultId === golden) return RELEVANCE_EXACT;
    if (resultId.includes(golden) || golden.includes(resultId)) return RELEVANCE_PARTIAL;
  }
  return RELEVANCE_NONE;
}

/** Whether a result entity_id is a golden hit (exact or partial). */
function isGoldenHit(resultId: string, goldens: readonly string[]): boolean {
  return gradedRelevance(resultId, goldens) > RELEVANCE_NONE;
}

/** Recall@K: fraction of golden IDs found in top-K results. */
function recallAtK(resultIds: readonly string[], goldens: readonly string[], k: number): number {
  if (goldens.length === 0) return 0;
  const topK = resultIds.slice(0, k);
  let hits = 0;
  for (const golden of goldens) {
    for (const resultId of topK) {
      if (resultId === golden || resultId.includes(golden) || golden.includes(resultId)) {
        hits++;
        break;
      }
    }
  }
  return hits / goldens.length;
}

/**
 * MRR: reciprocal rank of first golden hit in results (top-10 window).
 * Returns 0 if no golden found.
 */
function computeMrr(resultIds: readonly string[], goldens: readonly string[]): number {
  if (goldens.length === 0) return 0;
  for (let i = 0; i < resultIds.length; i++) {
    const id = resultIds[i];
    if (id !== undefined && isGoldenHit(id, goldens)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Ideal DCG@N for a given set of golden IDs (all hits at top positions). */
function idealDcgAtN(goldens: readonly string[], n: number): number {
  let idcg = 0;
  const limit = Math.min(goldens.length, n);
  for (let i = 0; i < limit; i++) {
    // Each golden contributes RELEVANCE_EXACT at ideal rank i+1
    idcg += RELEVANCE_EXACT / Math.log2(i + 2);
  }
  return idcg;
}

/** NDCG@N using graded relevance. */
function computeNdcgAtN(resultIds: readonly string[], goldens: readonly string[], n: number): number {
  if (goldens.length === 0) return 0;
  const idcg = idealDcgAtN(goldens, n);
  if (idcg === 0) return 0;

  let dcg = 0;
  const limit = Math.min(resultIds.length, n);
  for (let i = 0; i < limit; i++) {
    const id = resultIds[i];
    if (id === undefined) continue;
    const rel = gradedRelevance(id, goldens);
    if (rel > 0) {
      dcg += rel / Math.log2(i + 2);
    }
  }
  return dcg / idcg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-scenario result
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioRetrievalResult {
  readonly scenarioId: number;
  readonly tier: ScenarioTier;
  readonly query: string;
  readonly goldenEntityIds: readonly string[];
  readonly hasGoldens: boolean;
  readonly resultEntityIds: readonly string[];
  readonly resultLabels: readonly string[];
  readonly durationMs: number;
  readonly error?: string;
  // Metrics — only meaningful when hasGoldens=true
  readonly recall1: number;
  readonly recall3: number;
  readonly recall5: number;
  readonly recall10: number;
  readonly mrr: number;
  readonly ndcg5: number;
  // Coverage — always meaningful
  readonly hasAnyResults: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ─────────────────────────────────────────────────────────────────────────────

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

function fmt(n: number): string {
  return n.toFixed(METRIC_DECIMAL_PLACES);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function runRetrievalBenchmark(): Promise<void> {
  const args = parseArgs();

  // ── Scenario selection ────────────────────────────────────────────────────
  let scenarios: readonly AgentBenchmarkScenario[] = AGENT_SCENARIOS.filter(
    (s) => s.skip === undefined,
  );

  if (args.tierFilter !== undefined) {
    scenarios = scenarios.filter((s) => s.tier === args.tierFilter);
  }

  if (args.limit !== undefined) {
    scenarios = scenarios.slice(0, args.limit);
  }

  const totalScenarios = scenarios.length;
  // Scenarios with golden entity IDs come from expectation.expectedEntityIds
  const scenariosWithGoldens = scenarios.filter(
    (s) => s.expectation.expectedEntityIds !== undefined &&
      s.expectation.expectedEntityIds.length > 0,
  );

  console.log('=== Retrieval Benchmark Runner ===');
  console.log(`Base URL:              ${args.baseUrl}`);
  console.log(`Scenarios total:       ${totalScenarios}`);
  console.log(`With golden IDs:       ${scenariosWithGoldens.length}`);
  if (args.tierFilter !== undefined) console.log(`Tier filter:           ${args.tierFilter}`);
  if (args.limit !== undefined) console.log(`Limit:                 ${args.limit}`);
  console.log('');

  // ── Run scenarios sequentially ────────────────────────────────────────────
  const results: ScenarioRetrievalResult[] = [];
  let done = 0;

  for (const scenario of scenarios) {
    const goldenEntityIds: readonly string[] =
      scenario.expectation.expectedEntityIds ?? [];
    const hasGoldens = goldenEntityIds.length > 0;

    const { entityIds, labels, durationMs, error } = await callSearchApi(
      args.baseUrl,
      scenario.query,
    );

    const recall1 = hasGoldens ? recallAtK(entityIds, goldenEntityIds, RECALL_K1) : 0;
    const recall3 = hasGoldens ? recallAtK(entityIds, goldenEntityIds, RECALL_K3) : 0;
    const recall5 = hasGoldens ? recallAtK(entityIds, goldenEntityIds, RECALL_K5) : 0;
    const recall10 = hasGoldens ? recallAtK(entityIds, goldenEntityIds, SEARCH_TOP_K) : 0;
    const mrr = hasGoldens ? computeMrr(entityIds, goldenEntityIds) : 0;
    const ndcg5 = hasGoldens ? computeNdcgAtN(entityIds, goldenEntityIds, NDCG_CUTOFF) : 0;
    const hasAnyResults = entityIds.length > 0;

    const result: ScenarioRetrievalResult = {
      scenarioId: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      goldenEntityIds,
      hasGoldens,
      resultEntityIds: entityIds,
      resultLabels: labels,
      durationMs,
      error,
      recall1,
      recall3,
      recall5,
      recall10,
      mrr,
      ndcg5,
      hasAnyResults,
    };
    results.push(result);
    done++;

    if (args.verbose) {
      const status = error !== undefined ? `ERROR: ${error}` : `${entityIds.length} results in ${durationMs}ms`;
      console.log(`[${done}/${totalScenarios}] #${scenario.id} [${scenario.tier}] ${scenario.query.slice(0, VERBOSE_QUERY_PREVIEW_LEN)}`);
      console.log(`  Status:  ${status}`);
      if (hasGoldens) {
        console.log(`  Goldens: ${goldenEntityIds.join(', ')}`);
        console.log(`  R@1=${fmt(recall1)}  R@3=${fmt(recall3)}  R@5=${fmt(recall5)}  MRR=${fmt(mrr)}  NDCG@5=${fmt(ndcg5)}`);
      }
      const top3Labels = labels.slice(0, VERBOSE_TOP_N);
      const top3Ids = entityIds.slice(0, VERBOSE_TOP_N);
      if (top3Ids.length > 0) {
        console.log('  Top-3:');
        for (let i = 0; i < top3Ids.length; i++) {
          console.log(`    ${i + 1}. [${top3Ids[i] ?? ''}] ${top3Labels[i] ?? ''}`);
        }
      }
      console.log('');
    } else {
      const mark = error !== undefined ? 'E' : hasAnyResults ? '.' : '0';
      process.stdout.write(mark);
      if (done % PROGRESS_PRINT_INTERVAL === 0) process.stdout.write(`  ${done}/${totalScenarios}\n`);
    }
  }

  if (!args.verbose) process.stdout.write('\n\n');

  // ── Aggregate overall metrics (golden-only) ───────────────────────────────
  const goldenResults = results.filter((r) => r.hasGoldens);

  const overallR1 = mean(goldenResults.map((r) => r.recall1));
  const overallR3 = mean(goldenResults.map((r) => r.recall3));
  const overallR5 = mean(goldenResults.map((r) => r.recall5));
  const overallR10 = mean(goldenResults.map((r) => r.recall10));
  const overallMrr = mean(goldenResults.map((r) => r.mrr));
  const overallNdcg5 = mean(goldenResults.map((r) => r.ndcg5));

  // ── Coverage (all scenarios) ──────────────────────────────────────────────
  const withResults = results.filter((r) => r.hasAnyResults).length;
  const withErrors = results.filter((r) => r.error !== undefined).length;

  console.log('=== Retrieval Benchmark Results ===');
  console.log(`Scenarios evaluated:       ${results.length}`);
  console.log(`Scenarios with goldenIDs:  ${goldenResults.length}`);
  console.log(`Scenarios with any result: ${withResults} / ${results.length}`);
  console.log(`Scenarios with errors:     ${withErrors}`);
  console.log('');

  if (goldenResults.length > 0) {
    console.log('Overall Metrics (golden-labeled scenarios):');
    console.log(`  Recall@1:  ${fmt(overallR1)}`);
    console.log(`  Recall@3:  ${fmt(overallR3)}`);
    console.log(`  Recall@5:  ${fmt(overallR5)}`);
    console.log(`  Recall@10: ${fmt(overallR10)}`);
    console.log(`  MRR:       ${fmt(overallMrr)}`);
    console.log(`  NDCG@5:    ${fmt(overallNdcg5)}`);
    console.log('');
  } else {
    console.log('No scenarios have golden entity IDs (expectedEntityIds).');
    console.log('Add expectedEntityIds to scenario expectations to enable retrieval metrics.');
    console.log('');
  }

  // ── Coverage for non-golden scenarios ────────────────────────────────────
  const nonGoldenResults = results.filter((r) => !r.hasGoldens);
  if (nonGoldenResults.length > 0) {
    const nonGoldenWithResults = nonGoldenResults.filter((r) => r.hasAnyResults).length;
    console.log(`Coverage (no golden IDs, ${nonGoldenResults.length} scenarios):`);
    console.log(`  Returned ≥1 result: ${nonGoldenWithResults} / ${nonGoldenResults.length}`);
    console.log('');
  }

  // ── Per-tier breakdown ────────────────────────────────────────────────────
  const tiers = [...new Set(results.map((r) => r.tier))].sort();

  if (goldenResults.length > 0) {
    console.log('Per-tier breakdown (golden-labeled only):');
    for (const tier of tiers) {
      const tierGolden = goldenResults.filter((r) => r.tier === tier);
      if (tierGolden.length === 0) continue;

      const tierR5 = mean(tierGolden.map((r) => r.recall5));
      const tierMrr = mean(tierGolden.map((r) => r.mrr));
      console.log(
        `  [${tier}]: Recall@5=${fmt(tierR5)}, MRR=${fmt(tierMrr)}, n=${tierGolden.length}`,
      );
    }
    console.log('');
  }

  // ── Per-tier coverage breakdown (all scenarios) ───────────────────────────
  console.log('Per-tier coverage (all scenarios):');
  for (const tier of tiers) {
    const tierAll = results.filter((r) => r.tier === tier);
    const tierWithResults = tierAll.filter((r) => r.hasAnyResults).length;
    const tierErrors = tierAll.filter((r) => r.error !== undefined).length;
    const tierGoldenCount = tierAll.filter((r) => r.hasGoldens).length;
    console.log(
      `  [${tier}]: coverage=${tierWithResults}/${tierAll.length}, errors=${tierErrors}, with_goldens=${tierGoldenCount}`,
    );
  }
  console.log('');

  // ── Error report ──────────────────────────────────────────────────────────
  if (withErrors > 0) {
    console.log(`Error summary (${withErrors} scenarios):`);
    for (const r of results) {
      if (r.error !== undefined) {
        console.log(`  #${r.scenarioId} [${r.tier}]: ${r.error.slice(0, ERROR_SUMMARY_MAX_LEN)}`);
      }
    }
    console.log('');
  }
}

runRetrievalBenchmark().catch((err: unknown) => {
  console.error('Fatal error in retrieval runner:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
