#!/usr/bin/env tsx
/**
 * Validates embedding quality by comparing old vs new embedding metrics.
 *
 * Workflow:
 * 1. Load 100 queries from golden-queries-bronze.jsonl
 * 2. For each query:
 *    - Run sparse search (BM25) to get baseline results
 *    - Measure Recall@100, NDCG@10 with baseline results
 * 3. Compare with baseline evaluation metrics
 * 4. Print improvement: new_recall - baseline_recall
 * 5. Verify no regression: NDCG@10 should stay same or improve
 *
 * Inputs:
 * - data/golden-queries-bronze.jsonl (500 queries, sample 100)
 * - data/eval-baseline-bronze.json (baseline metrics)
 * - Running search API (SEARCH_API_URL)
 *
 * Outputs:
 * - Recall@100 comparison
 * - NDCG@10 comparison
 * - Regression check
 *
 * Usage:
 *   npx tsx scripts/ltr/validate-embedding.ts [--sample 100] [--tier bronze]
 */

import 'dotenv/config';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  requireFixtureCorpusPath,
} from '../eval/fixture-corpus-paths.js';
import {
  ndcg,
  recall,
  type RankedHit,
  type RelevanceMap,
} from '../eval/metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GoldenQuery {
  qid: string;
  query: string;
  retrieval_labels: {
    relevant: Array<{
      entity_id: string;
      grade: number;
    }>;
  };
}

interface BaselineMetrics {
  recall_at_100: number;
  ndcg_at_10: number;
}

interface ComparisonResult {
  recall_at_100: {
    baseline: number;
    new: number;
    improvement: number;
  };
  ndcg_at_10: {
    baseline: number;
    new: number;
    improvement: number;
  };
  regression_detected: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASELINE = resolveDataPath('data/eval-baseline-bronze.json');
const DEFAULT_SAMPLE_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  input: string;
  baseline: string;
  sample: number;
  tier: string;
}

function parseArgs(argv: string[]): Args {
  const defaultInput = requireFixtureCorpusPath(
    OFFLINE_EVAL_SILVER_CORPUS,
    'validate-embedding default input resolution',
  );
  const out: Args = {
    input: defaultInput,
    baseline: DEFAULT_BASELINE,
    sample: DEFAULT_SAMPLE_SIZE,
    tier: 'bronze',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? defaultInput;
    else if (a === '--baseline' || a === '-b') out.baseline = argv[++i] ?? DEFAULT_BASELINE;
    else if (a === '--sample' || a === '-s') {
      const s = argv[++i];
      out.sample = s ? parseInt(s, 10) : DEFAULT_SAMPLE_SIZE;
    } else if (a === '--tier') {
      out.tier = argv[++i] ?? 'bronze';
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads an NDJSON file and returns all parsed items.
 */
async function loadNdjson<T>(filePath: string): Promise<T[]> {
  const items: T[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        items.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed lines
      }
    }
  }

  return items;
}

/**
 * Loads JSON file.
 */
async function loadJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Executes search query against running API.
 */
async function executeSearch(query: string, timeoutMs: number = 30_000): Promise<RankedHit[]> {
  const apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';

  try {
    const response = await fetch(`${apiUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      results?: { entity?: { entity_id?: string }; relevance_score?: number }[];
    };

    const ranked: RankedHit[] = (data.results ?? []).map((r) => ({
      entity_id: r.entity?.entity_id ?? '',
      score: r.relevance_score ?? 0,
    }));

    return ranked;
  } catch (error) {
    console.warn(`⚠️  Search failed for query "${query.substring(0, 50)}": ${String(error)}`);
    return [];
  }
}

/**
 * Builds relevance map from golden query labels.
 */
function buildRelevanceMap(query: GoldenQuery): RelevanceMap {
  const judgments = new Map<string, number>();
  for (const j of query.retrieval_labels.relevant) {
    judgments.set(j.entity_id, j.grade);
  }
  return { judgments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates embedding by comparing metrics with baseline.
 */
async function validateEmbedding(
  queries: readonly GoldenQuery[],
  baseline: BaselineMetrics,
  sampleSize: number,
): Promise<ComparisonResult> {
  console.log(`📊 Validating embedding on ${sampleSize} queries...\n`);

  // Sample queries
  const sampled = [...queries]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(sampleSize, queries.length));

  const recalls: number[] = [];
  const ndcgs: number[] = [];

  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < sampled.length; i++) {
    const query = sampled[i]!;
    process.stdout.write(
      `\r⏳ Progress: ${i + 1}/${sampled.length} queries ` +
      `(${successCount} succeeded, ${failureCount} failed)   `,
    );

    // Execute search
    const ranked = await executeSearch(query.query);

    if (ranked.length === 0) {
      failureCount++;
      continue;
    }

    // Compute metrics
    const relevance = buildRelevanceMap(query);
    const rec = recall(ranked, relevance, 100, 1);
    const ndcg_val = ndcg(ranked, relevance, 10);

    recalls.push(rec);
    ndcgs.push(ndcg_val);
    successCount++;
  }

  console.log(''); // newline after progress bar

  if (successCount === 0) {
    throw new Error('❌ All queries failed. Is the search API running?');
  }

  // Compute averages
  const avgRecall = recalls.reduce((a, b) => a + b, 0) / recalls.length;
  const avgNdcg = ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length;

  return {
    recall_at_100: {
      baseline: baseline.recall_at_100,
      new: avgRecall,
      improvement: avgRecall - baseline.recall_at_100,
    },
    ndcg_at_10: {
      baseline: baseline.ndcg_at_10,
      new: avgNdcg,
      improvement: avgNdcg - baseline.ndcg_at_10,
    },
    regression_detected: avgNdcg < baseline.ndcg_at_10 - 0.02, // Allow small variance
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

function formatMetric(baseline: number, new_val: number, improvement: number): string {
  const baselineStr = baseline.toFixed(4);
  const newStr = new_val.toFixed(4);
  const improvementStr = improvement >= 0
    ? `+${improvement.toFixed(4)}`
    : `${improvement.toFixed(4)}`;

  const improvementEmoji = improvement >= 0 ? '📈' : '📉';

  return `Baseline: ${baselineStr} → New: ${newStr} (${improvementEmoji} ${improvementStr})`;
}

function printResults(result: ComparisonResult): void {
  console.log('\n' + '='.repeat(80));
  console.log('📊 EMBEDDING VALIDATION RESULTS');
  console.log('='.repeat(80) + '\n');

  console.log('📌 Recall@100 (Primary metric — target: ≥ +0.03):');
  console.log(
    `   ${formatMetric(result.recall_at_100.baseline, result.recall_at_100.new, result.recall_at_100.improvement)}`,
  );

  const recallTargetMet = result.recall_at_100.improvement >= 0.03;
  console.log(`   Target: ${recallTargetMet ? '✅ MET' : '⚠️  NOT MET'}\n`);

  console.log('📌 NDCG@10 (Ranking quality — should not regress):');
  console.log(
    `   ${formatMetric(result.ndcg_at_10.baseline, result.ndcg_at_10.new, result.ndcg_at_10.improvement)}`,
  );

  const ndcgRegressed = result.regression_detected;
  console.log(`   Regression: ${ndcgRegressed ? '❌ DETECTED' : '✅ NONE'}\n`);

  console.log('='.repeat(80));

  if (recallTargetMet && !ndcgRegressed) {
    console.log('🎉 VALIDATION PASSED: Embedding improvement meets targets!');
  } else {
    console.log('⚠️  VALIDATION WARNINGS:');
    if (!recallTargetMet) {
      console.log(
        `   - Recall@100 improvement is only +${result.recall_at_100.improvement.toFixed(4)}, ` +
        'target is +0.03',
      );
    }
    if (ndcgRegressed) {
      console.log(
        `   - NDCG@10 regressed by ${Math.abs(result.ndcg_at_10.improvement).toFixed(4)}`,
      );
    }
  }

  console.log('='.repeat(80) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  try {
    // Load queries
    console.log(`📖 Loading queries from ${args.input}...`);
    const queries = await loadNdjson<GoldenQuery>(args.input);
    console.log(`✅ Loaded ${queries.length} queries\n`);

    // Load baseline
    console.log(`📊 Loading baseline metrics from ${args.baseline}...`);
    const allBaseline = await loadJson<Record<string, unknown>>(args.baseline);

    // Extract baseline metrics
    const baseline: BaselineMetrics = {
      recall_at_100: allBaseline.recall_at_100 ?? 0.5132,
      ndcg_at_10: allBaseline.ndcg_at_10 ?? 0.3902,
    };

    console.log(
      `✅ Baseline: Recall@100=${baseline.recall_at_100.toFixed(4)}, ` +
      `NDCG@10=${baseline.ndcg_at_10.toFixed(4)}\n`,
    );

    // Validate
    const result = await validateEmbedding(queries, baseline, args.sample);

    // Print results
    printResults(result);

    // Exit with appropriate code
    process.exit(result.regression_detected ? 1 : 0);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
