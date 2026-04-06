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
 *   npx tsx scripts/eval/run-offline-eval.ts --verify-splits   # run split integrity first (RFC-017 §2.5)
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseNdjson } from '../etl/ndjson.js';
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
  setDiversityScore,
  anchorPreservationScore,
  producerVariety,
  setCoverage,
  browseLineDiversityAtK,
  grapeVarietyAtK,
  prestigeMeanAtK,
  type RankedHit,
  type DecisionOutcome,
  type GroundTruth,
  type EvalResult,
  type ScenarioSlice,
  type RetrievalMode,
  type ModeMetrics,
  type EntityTargetType,
  type EntityTypeMetrics,
} from './metrics.js';
import {
  inferEntityTargetType as inferEntityTargetTypeFromQuery,
  inferResolvedEntityType,
} from './entity-type.js';
import { verifyDefaultGoldenSplits } from './split-integrity.js';

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

/**
 * Release gates for retrieval modes (Epic 11, advisory in phase 1).
 * Optional keys (handled when present): `prestige_mean_at_10_min` — opt-in when eval hits
 * include stable `producer_prestige`; otherwise omit to avoid noisy advisories.
 */
const MODE_RELEASE_GATES: Record<RetrievalMode, Record<string, number>> = {
  entity_lookup: {
    wrong_top1_rate_max: 0.02,
    ndcg_at_10_min: 0.50,
  },
  entity_resolution: {
    wrong_top1_rate_max: 0.05,
    ndcg_at_10_min: 0.40,
  },
  attribute_search: {
    ndcg_at_10_min: 0.45,
    recall_at_10_min: 0.60,
  },
  constraint_filter: {
    recall_at_10_min: 0.70,
  },
  producer_browse: {
    set_coverage_min: 0.50,
    producer_variety_min: 0.60,
    /** Distinct browse-line keys in top-10 / 10 (see `browseLineDiversityAtK`). */
    browse_line_diversity_at_10_min: 0.35,
  },
  region_browse: {
    set_coverage_min: 0.55,
    diversity_min: 0.60,
    browse_line_diversity_at_10_min: 0.35,
    /** Distinct primary grapes / hits with grape metadata in top-10. */
    grape_variety_at_10_min: 0.25,
  },
  compare_candidates: {
    attribute_coverage_min: 0.70,
    ndcg_at_10_min: 0.50,
  },
  recommendation: {
    ndcg_at_10_min: 0.45,
  },
  similar_items: {
    anchor_preservation_min: 0.60,
    seed_exclusion_min: 0.95,
  },
  no_match_detection: {
    wrong_top1_rate_max: 0.05,
  },
} as const;

const ALL_RETRIEVAL_MODES: RetrievalMode[] = [
  'entity_lookup',
  'entity_resolution',
  'attribute_search',
  'constraint_filter',
  'producer_browse',
  'region_browse',
  'compare_candidates',
  'recommendation',
  'similar_items',
  'no_match_detection',
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  tier: 'bronze' | 'silver' | 'gate';
  /** When true, run `verify-splits` logic before any search (fail-fast on leakage). */
  verifySplits: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    tier: 'bronze',
    verifySplits: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--tier') {
      const t = argv[++i];
      if (t === 'bronze' || t === 'silver' || t === 'gate') out.tier = t;
    } else if (a === '--verify-splits') {
      out.verifySplits = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search execution (calls the running engine)
// ---------------------------------------------------------------------------

function evalSearchTimeoutMs(): number {
  const raw = process.env['EVAL_SEARCH_TIMEOUT_MS'];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1000) return 60_000;
  return n;
}

function evalSearchConcurrency(): number {
  const raw = process.env['EVAL_SEARCH_CONCURRENCY'];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(64, n);
}

function shouldSkipEmbeddingValidation(): boolean {
  return process.env['EVAL_SKIP_EMBEDDING_VALIDATION'] === 'true';
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

interface SearchResult {
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
}

interface EvalSearchRequestBody {
  readonly query: string;
  readonly options: {
    readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
    readonly explain: false;
    readonly clarification: false;
  };
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
}

export function buildEvalSearchRequestBody(query: GoldenQuery): EvalSearchRequestBody {
  const mode = query.retrieval_mode === 'similar_items' ? 'mixed' : 'hybrid';

  return {
    query: query.query,
    options: {
      mode,
      explain: false as const,
      clarification: false as const,
    },
    // Golden-query retrieval modes are internal evaluation labels, not a
    // 1:1 match for the public API's top-level route override. The public
    // eval harness executes the closest route family the search endpoint can
    // express: similar-items rows use `mixed`, everything else uses the
    // ranked-search family (`hybrid`).
    retrieval_mode: mode,
  };
}

async function executeSearch(goldenQuery: GoldenQuery, timeoutMs: number): Promise<SearchResult> {
  // Call the running search API
  const apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  const requestBody = buildEvalSearchRequestBody(goldenQuery);

  try {
    const response = await fetch(`${apiUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
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

    // Parse response — robust to both camelCase (internal/direct) and
    // snake_case (HTTP API with preSerialization hook) field naming.
    // Root cause: if the snake-case hook is misconfigured or the eval script
    // is pointed at a different endpoint, entity_id silently becomes '' for
    // every hit, collapsing Recall@100 to near-zero.
    const raw = (await response.json()) as Record<string, unknown>;

    // Accept both engine_decision (snake) and engineDecision (camel)
    const engineDecision = (raw['engine_decision'] ?? raw['engineDecision'] ?? {}) as Record<string, unknown>;
    const rawResults = (raw['results'] ?? []) as Record<string, unknown>[];

    const ranked: RankedHit[] = rawResults.map((r) => {
      const entity = (r['entity'] ?? {}) as Record<string, unknown>;
      // Accept both entity_id (snake) and entityId (camel)
      const entityId = (entity['entity_id'] ?? entity['entityId'] ?? '') as string;
      const score = (r['relevance_score'] ?? r['relevanceScore'] ?? 0) as number;
      const entityType = entity['type'];
      const producer = entity['producer'];
      const region = entity['region'];
      const appellation = entity['appellation'];
      const prestigeRaw = entity['producer_prestige'] ?? entity['producerPrestige'];
      const grapes = entity['grapes'];
      const producer_prestige =
        typeof prestigeRaw === 'number' && Number.isFinite(prestigeRaw) ? prestigeRaw : undefined;
      return {
        entity_id: String(entityId),
        score,
        ...(typeof entityType === 'string' ? { entity_type: entityType } : {}),
        ...(typeof producer === 'string' ? { producer } : {}),
        ...(typeof region === 'string' ? { region } : {}),
        ...(typeof appellation === 'string' ? { appellation } : {}),
        ...(producer_prestige !== undefined ? { producer_prestige } : {}),
        ...(Array.isArray(grapes)
          ? { grapes: grapes.filter((value): value is string => typeof value === 'string') }
          : {}),
      };
    });

    const decisionStatus = (engineDecision['decision_status'] ?? engineDecision['decisionStatus'] ?? 'failed') as string;
    const decisionConfidence = (engineDecision['decision_confidence'] ?? engineDecision['decisionConfidence'] ?? 0) as number;

    const decision: DecisionOutcome = {
      decision_status: decisionStatus as 'resolved' | 'ambiguous' | 'failed',
      top_entity_id: ranked[0]?.entity_id ?? null,
      decision_confidence: decisionConfidence,
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
// Mode-specific metrics (Epic 11)
// ---------------------------------------------------------------------------

function computeModeMetrics(
  results: readonly { ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth }[],
  mode: RetrievalMode,
): ModeMetrics {
  if (results.length === 0) {
    return {
      retrieval_mode: mode,
      query_count: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      recall_at_10: 0,
      wrong_top1_rate: 0,
      decision_utility: 0,
    };
  }

  const ndcgValues = results.map((r) => ndcg(r.ranked, r.truth.relevant, 10));
  const mrrValues = results.map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10));
  const recallValues = results.map((r) => recall(r.ranked, r.truth.relevant, 10));
  const decisions = results.map((r) => r.decision);
  const truths = results.map((r) => r.truth);

  const baseMetrics = {
    retrieval_mode: mode,
    query_count: results.length,
    ndcg_at_10: ndcgValues.reduce((a, b) => a + b, 0) / ndcgValues.length,
    mrr_at_10: mrrValues.reduce((a, b) => a + b, 0) / mrrValues.length,
    recall_at_10: recallValues.reduce((a, b) => a + b, 0) / recallValues.length,
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    decision_utility:
      decisions.reduce((sum, d, i) => sum + queryUtility(d, truths[i]!), 0) /
      decisions.length,
  };

  // Build mode-specific metrics conditionally
  const metrics: ModeMetrics = { ...baseMetrics };

  if (mode === 'producer_browse' || mode === 'region_browse') {
    const diversityScores = results.map((r) => setDiversityScore(r.ranked));
    metrics.diversity_score = diversityScores.reduce((a, b) => a + b, 0) / diversityScores.length;
    const varietyScores = results.map((r) => producerVariety(r.ranked));
    metrics.producer_variety = varietyScores.reduce((a, b) => a + b, 0) / varietyScores.length;

    const coverageScores = results.map((r) =>
      setCoverage(
        new Set(r.ranked.slice(0, 10).map((h) => h.entity_id)),
        r.truth.relevant,
        2,
      ),
    );
    metrics.set_coverage =
      coverageScores.reduce((a, b) => a + b, 0) / coverageScores.length;

    const lineScores = results.map((r) => browseLineDiversityAtK(r.ranked, 10));
    metrics.browse_line_diversity_at_10 =
      lineScores.reduce((a, b) => a + b, 0) / lineScores.length;

    const prestigeScores = results.map((r) => prestigeMeanAtK(r.ranked, 10));
    metrics.prestige_mean_at_10 =
      prestigeScores.reduce((a, b) => a + b, 0) / prestigeScores.length;

    if (mode === 'region_browse') {
      const grapeScores = results.map((r) => grapeVarietyAtK(r.ranked, 10));
      metrics.grape_variety_at_10 =
        grapeScores.reduce((a, b) => a + b, 0) / grapeScores.length;
    }
  }

  if (mode === 'similar_items') {
    metrics.anchor_preservation_score = results.length > 0
      ? results
        .map((r) => anchorPreservationScore(r.truth.expected_entity_id ?? '', r.ranked))
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
    metrics.seed_exclusion_rate = results.length > 0
      ? results
        .map((r) => {
          const anchorId = r.truth.expected_entity_id;
          if (anchorId === undefined || r.ranked.length === 0) {
            return 1;
          }
          return r.ranked.some((hit) => hit.entity_id === anchorId) ? 0 : 1;
        })
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
  }

  if (mode === 'compare_candidates') {
    metrics.attribute_coverage = results.length > 0
      ? results
        .map((r) => {
          if (r.ranked.length === 0) {
            return 0;
          }
          const covered = r.ranked.filter(
            (hit) => hit.producer !== undefined || hit.region !== undefined || (hit.grapes?.length ?? 0) > 0,
          ).length;
          return covered / r.ranked.length;
        })
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
  }

  return metrics;
}

/**
 * Compute entity type confusion matrix for a result set.
 * Tracks what target type results actually resolved to.
 */
function computeEntityTypeMetrics(
  results: readonly { query: GoldenQuery; ranked: RankedHit[]; decision: DecisionOutcome }[],
  targetType: EntityTargetType,
): EntityTypeMetrics {
  if (results.length === 0) {
    return {
      target_type: targetType,
      query_count: 0,
      correct_type_rate: 0,
      confusion_matrix: {
        wine: 0,
        producer: 0,
        region: 0,
        unknown: 0,
      },
    };
  }

  const confusion: Record<EntityTargetType, number> = {
    wine: 0,
    producer: 0,
    region: 0,
    unknown: 0,
  };

  let correctCount = 0;
  for (const r of results) {
    const resolvedType = r.decision.decision_status === 'resolved'
      ? inferResolvedEntityType(r.ranked[0])
      : 'unknown';
    if (resolvedType === targetType) {
      correctCount++;
    }

    confusion[resolvedType]++;
  }

  return {
    target_type: targetType,
    query_count: results.length,
    correct_type_rate: correctCount / results.length,
    confusion_matrix: confusion,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.verifySplits) {
    console.log('Running split integrity check (RFC-017 §2.5) …');
    const splitResult = await verifyDefaultGoldenSplits();
    if (
      splitResult.stats.train === 0 &&
      splitResult.stats.val === 0 &&
      splitResult.stats.gate === 0
    ) {
      console.error(
        '  verify-splits: no split files (data/splits/*.jsonl). Run build-splits or omit --verify-splits.',
      );
      process.exit(1);
    }
    if (!splitResult.valid) {
      console.error(
        `  Split integrity FAILED (${splitResult.violations.length} violations). First: ${splitResult.violations[0] ?? 'unknown'}`,
      );
      process.exit(1);
    }
    console.log(
      `  Split integrity OK (train=${splitResult.stats.train}, val=${splitResult.stats.val}, gate=${splitResult.stats.gate})\n`,
    );
  }

  console.log(`Loading golden queries from ${args.input} (tier: ${args.tier}) …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records: allQueries } = parseNdjson<GoldenQuery>(content, args.input);

  // Filter by tier
  const queries = allQueries.filter((q) => q.annotation_tier === args.tier);
  console.log(`  Queries for tier "${args.tier}": ${queries.length} / ${allQueries.length}`);

  if (queries.length === 0) {
    console.log('  No queries found for this tier. Using all queries.');
  }
  const evalQueries = queries.length > 0 ? queries : allQueries;

  const timeoutMs = evalSearchTimeoutMs();
  const concurrency = evalSearchConcurrency();
  console.log(
    `\nExecuting ${evalQueries.length} searches (concurrency=${concurrency}, timeoutMs=${timeoutMs}) …`,
  );

  let lastLogged = 0;
  const allResults = await mapPool(
    evalQueries,
    concurrency,
    async (q) => {
      const { ranked, decision } = await executeSearch(q, timeoutMs);
      const truth = queryToGroundTruth(q);
      return { query: q, ranked, decision, truth };
    },
    (done, total) => {
      if (done % 50 === 0 || done === total) {
        if (done !== lastLogged) {
          lastLogged = done;
          console.log(`  Progress: ${done}/${total}`);
        }
      }
    },
  );

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
  const globalRecallAt3 = allResults
    .map((r) => recall(r.ranked, r.truth.relevant, 3))
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

  // Epic 11: Mode-specific slices
  const byModeEntries: [RetrievalMode, ModeMetrics][] = [];
  const modeGroups = new Map<RetrievalMode, typeof allResults>();
  for (const r of allResults) {
    const mode = r.query.retrieval_mode ?? 'entity_lookup';
    const existing = modeGroups.get(mode);
    if (existing) {
      existing.push(r);
    } else {
      modeGroups.set(mode, [r]);
    }
  }
  for (const mode of ALL_RETRIEVAL_MODES) {
    const group = modeGroups.get(mode);
    if (group && group.length > 0) {
      byModeEntries.push([mode, computeModeMetrics(group, mode)]);
    }
  }
  const byMode = Object.fromEntries(byModeEntries) as Record<RetrievalMode, ModeMetrics>;

  // Epic 11: Entity target type slices
  const byTargetTypeEntries: [EntityTargetType, EntityTypeMetrics][] = [];
  const typeGroups = new Map<EntityTargetType, typeof allResults>();
  for (const r of allResults) {
    const targetType = inferEntityTargetTypeFromQuery({
      retrieval_mode: r.query.retrieval_mode,
      query_class: r.query.query_class,
      scenario: r.query.scenario,
    });
    const existing = typeGroups.get(targetType);
    if (existing) {
      existing.push(r);
    } else {
      typeGroups.set(targetType, [r]);
    }
  }
  for (const [targetType, group] of typeGroups) {
    byTargetTypeEntries.push([targetType, computeEntityTypeMetrics(group, targetType)]);
  }
  const byTargetType = Object.fromEntries(byTargetTypeEntries) as Record<EntityTargetType, EntityTypeMetrics>;

  const evalResult: EvalResult = {
    dataset_tier: args.tier,
    query_count: allResults.length,
    ndcg_at_10: globalNdcg,
    mrr_at_10: globalMrr,
    recall_at_3: globalRecallAt3,
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

  // Add optional Epic 11 fields if present
  if (Object.keys(byMode).length > 0) {
    evalResult.by_mode = byMode;
  }
  if (Object.keys(byTargetType).length > 0) {
    evalResult.by_target_type = byTargetType;
  }

  // Print summary
  console.log('\n=== EVAL RESULTS ===');
  console.log(`  Queries:          ${evalResult.query_count}`);
  console.log(`  NDCG@10:          ${evalResult.ndcg_at_10.toFixed(4)}`);
  console.log(`  MRR@10:           ${evalResult.mrr_at_10.toFixed(4)}`);
  console.log(`  Recall@3:         ${evalResult.recall_at_3.toFixed(4)}`);
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
  const gateViolations: string[] = [];
  if (args.tier === 'gate') {
    console.log('\n=== RELEASE GATE ===');

    // Global metric gates
    if (evalResult.wrong_top1_rate > RELEASE_GATES.wrong_top1_rate_max) {
      gateViolations.push(`wrong_top1_rate ${evalResult.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.wrong_top1_rate_max}`);
    }
    if (evalResult.recall_at_100 < RELEASE_GATES.recall_at_100_min) {
      gateViolations.push(`recall_at_100 ${evalResult.recall_at_100.toFixed(4)} < ${RELEASE_GATES.recall_at_100_min}`);
    }
    if (evalResult.ece > 0.10) {
      gateViolations.push(`ece ${evalResult.ece.toFixed(4)} > 0.10 (calibration degraded)`);
    }

    // Scenario-specific gates
    const entitySlices = ['A', 'B', 'H'];
    for (const s of entitySlices) {
      const slice = evalResult.by_scenario[s];
      if (slice && slice.wrong_top1_rate > RELEASE_GATES.entity_resolve_wrong_top1_max) {
        gateViolations.push(`scenario ${s} wrong_top1_rate ${slice.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.entity_resolve_wrong_top1_max}`);
      }
    }

    const setSlices = ['E', 'F', 'G'];
    for (const s of setSlices) {
      const slice = evalResult.by_scenario[s];
      if (slice && slice.ndcg_at_10 < RELEASE_GATES.set_retrieval_recall_at_10_min) {
        gateViolations.push(`scenario ${s} ndcg_at_10 ${slice.ndcg_at_10.toFixed(4)} < ${RELEASE_GATES.set_retrieval_recall_at_10_min}`);
      }
    }

    const noMatchSlice = evalResult.by_scenario['no_match'];
    if (noMatchSlice && noMatchSlice.wrong_top1_rate > RELEASE_GATES.no_match_false_resolve_max) {
      gateViolations.push(`no_match false_resolve ${noMatchSlice.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.no_match_false_resolve_max}`);
    }

    // Epic 11: Mode-specific release gates (advisory, non-blocking in phase 1)
    if (evalResult.by_mode) {
      for (const [mode, metrics] of Object.entries(evalResult.by_mode)) {
        const gates = (MODE_RELEASE_GATES as Record<string, Record<string, number>>)[mode];
        if (!gates) continue;

        // Advisory gates: log but don't block
        const modeViolations: string[] = [];
        if (gates.wrong_top1_rate_max !== undefined && metrics.wrong_top1_rate > gates.wrong_top1_rate_max) {
          modeViolations.push(`${mode} wrong_top1_rate ${metrics.wrong_top1_rate.toFixed(4)} > ${gates.wrong_top1_rate_max}`);
        }
        if (gates.ndcg_at_10_min !== undefined && metrics.ndcg_at_10 < gates.ndcg_at_10_min) {
          modeViolations.push(`${mode} ndcg_at_10 ${metrics.ndcg_at_10.toFixed(4)} < ${gates.ndcg_at_10_min}`);
        }
        if (gates.recall_at_10_min !== undefined && metrics.recall_at_10 < gates.recall_at_10_min) {
          modeViolations.push(`${mode} recall_at_10 ${metrics.recall_at_10.toFixed(4)} < ${gates.recall_at_10_min}`);
        }
        if (
          gates.set_coverage_min !== undefined &&
          metrics.set_coverage !== undefined &&
          metrics.set_coverage < gates.set_coverage_min
        ) {
          modeViolations.push(
            `${mode} set_coverage ${metrics.set_coverage.toFixed(4)} < ${gates.set_coverage_min}`,
          );
        }
        if (
          gates.diversity_min !== undefined &&
          metrics.diversity_score !== undefined &&
          metrics.diversity_score < gates.diversity_min
        ) {
          modeViolations.push(
            `${mode} diversity_score ${metrics.diversity_score.toFixed(4)} < ${gates.diversity_min}`,
          );
        }
        if (
          gates.producer_variety_min !== undefined &&
          metrics.producer_variety !== undefined &&
          metrics.producer_variety < gates.producer_variety_min
        ) {
          modeViolations.push(
            `${mode} producer_variety ${metrics.producer_variety.toFixed(4)} < ${gates.producer_variety_min}`,
          );
        }
        if (
          gates.browse_line_diversity_at_10_min !== undefined &&
          metrics.browse_line_diversity_at_10 !== undefined &&
          metrics.browse_line_diversity_at_10 < gates.browse_line_diversity_at_10_min
        ) {
          modeViolations.push(
            `${mode} browse_line_diversity_at_10 ${metrics.browse_line_diversity_at_10.toFixed(4)} < ${gates.browse_line_diversity_at_10_min}`,
          );
        }
        if (
          gates.grape_variety_at_10_min !== undefined &&
          metrics.grape_variety_at_10 !== undefined &&
          metrics.grape_variety_at_10 < gates.grape_variety_at_10_min
        ) {
          modeViolations.push(
            `${mode} grape_variety_at_10 ${metrics.grape_variety_at_10.toFixed(4)} < ${gates.grape_variety_at_10_min}`,
          );
        }
        if (
          gates.prestige_mean_at_10_min !== undefined &&
          metrics.prestige_mean_at_10 !== undefined &&
          metrics.prestige_mean_at_10 < gates.prestige_mean_at_10_min
        ) {
          modeViolations.push(
            `${mode} prestige_mean_at_10 ${metrics.prestige_mean_at_10.toFixed(4)} < ${gates.prestige_mean_at_10_min}`,
          );
        }
        if (
          gates.attribute_coverage_min !== undefined &&
          metrics.attribute_coverage !== undefined &&
          metrics.attribute_coverage < gates.attribute_coverage_min
        ) {
          modeViolations.push(
            `${mode} attribute_coverage ${metrics.attribute_coverage.toFixed(4)} < ${gates.attribute_coverage_min}`,
          );
        }
        if (
          gates.anchor_preservation_min !== undefined &&
          metrics.anchor_preservation_score !== undefined &&
          metrics.anchor_preservation_score < gates.anchor_preservation_min
        ) {
          modeViolations.push(
            `${mode} anchor_preservation_score ${metrics.anchor_preservation_score.toFixed(4)} < ${gates.anchor_preservation_min}`,
          );
        }
        if (
          gates.seed_exclusion_min !== undefined &&
          metrics.seed_exclusion_rate !== undefined &&
          metrics.seed_exclusion_rate < gates.seed_exclusion_min
        ) {
          modeViolations.push(
            `${mode} seed_exclusion_rate ${metrics.seed_exclusion_rate.toFixed(4)} < ${gates.seed_exclusion_min}`,
          );
        }
        if (modeViolations.length > 0) {
          console.log(`  [ADVISORY] Mode ${mode}:`);
          for (const v of modeViolations) {
            console.log(`    - ${v}`);
          }
        }
      }
    }

    // Epic 11: Entity target type gates (advisory)
    if (evalResult.by_target_type) {
      const entityTypeGate = 0.10; // max confusion rate
      for (const [targetType, metrics] of Object.entries(evalResult.by_target_type)) {
        const confusionRate = 1 - metrics.correct_type_rate;
        if (confusionRate > entityTypeGate) {
          console.log(`  [ADVISORY] Entity type ${targetType} confusion_rate ${confusionRate.toFixed(4)} > ${entityTypeGate}`);
        }
      }
    }

    // Final verdict
    if (gateViolations.length === 0) {
      console.log('  ✅ RELEASE GATE PASSED');
    } else {
      console.log('  ❌ RELEASE GATE FAILED:');
      for (const v of gateViolations) {
        console.log(`    - ${v}`);
      }
    }

    // Add gate verdict to result
    const verdict: { passed: boolean; failures: readonly string[] } = {
      passed: gateViolations.length === 0,
      failures: gateViolations,
    };
    evalResult.release_gate_verdict = verdict;
  }

  // Write results (after gate verdict is added if applicable)
  await fs.writeFile(args.output, JSON.stringify(evalResult, null, 2) + '\n', 'utf8');

  console.log(`\n  Results written to: ${args.output}`);

  // Epic 6: Run embedding validation if available
  console.log('\n=== EMBEDDING VALIDATION (Epic 6) ===');
  if (shouldSkipEmbeddingValidation()) {
    console.log('⏭️  Skipped (EVAL_SKIP_EMBEDDING_VALIDATION=true)');
    return;
  }
  try {
    const validateEmbeddingPath = new URL('../ltr/validate-embedding.ts', import.meta.url).pathname;
    const fs_exists = await import('node:fs/promises').then((m) =>
      m.access(validateEmbeddingPath).then(() => true).catch(() => false)
    );

    if (fs_exists) {
      console.log('📊 Running embedding validation...');
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);

      try {
        const sampleSize = Math.min(100, evalQueries.length);
        const { stdout } = await execAsync(
          `npx tsx scripts/ltr/validate-embedding.ts --sample ${sampleSize} --tier ${args.tier}`,
          { cwd: process.cwd(), timeout: 300_000 },
        );
        console.log(stdout);
      } catch (execError) {
        const msg = execError instanceof Error ? execError.message : String(execError);
        console.warn(`⚠️  Embedding validation failed: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Could not run embedding validation: ${msg}`);
  }
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
