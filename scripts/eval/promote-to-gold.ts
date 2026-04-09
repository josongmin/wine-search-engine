#!/usr/bin/env tsx
/**
 * Promote silver LLM labels to gold based on labeler confidence.
 *
 * Reads a silver NDJSON file, bucketises each judgment by confidence:
 *
 *   confidence >= HIGH_CONFIDENCE_THRESHOLD (0.85) → gold (auto-promoted)
 *   AUDIT_LOWER_BOUND (0.5) <= confidence < 0.85   → audit queue (borderline)
 *   confidence < 0.5                               → rejected
 *
 * All buckets retain `source: 'llm_silver'`. A later human audit step
 * rewrites audit-queue entries to `source: 'human_gold'` and appends them
 * to the gold-labels file.
 *
 * Usage:
 *   npx tsx scripts/eval/promote-to-gold.ts \
 *     --input data/relevance/silver-labels-2026-04-09.ndjson \
 *     --gold data/relevance/gold-labels.ndjson \
 *     --audit data/relevance/audit-queue.ndjson \
 *     --rejected data/relevance/rejected.ndjson
 *
 *   npx tsx scripts/eval/promote-to-gold.ts --help
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootstrapLogger } from '../../src/config/bootstrap-logger.js';
import { loadRelevanceJudgments } from '../../src/domain/evaluation/service/relevance-judgment-loader.js';
import type { RelevanceJudgment } from '../../src/domain/evaluation/model/relevance-judgment.js';

// ── Named constants ────────────────────────────────────────────────────────

/** Confidence at/above which an LLM silver label is auto-promoted to gold. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;

/** Lower bound for the human-audit queue; below this a label is rejected. */
export const AUDIT_LOWER_BOUND = 0.5;

const DEFAULT_GOLD = 'data/relevance/gold-labels.ndjson';
const DEFAULT_AUDIT = 'data/relevance/audit-queue.ndjson';
const DEFAULT_REJECTED = 'data/relevance/rejected.ndjson';

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly input: string;
  readonly gold: string;
  readonly audit: string;
  readonly rejected: string;
  readonly help: boolean;
}

function printHelp(): void {
  process.stderr.write(`
promote-to-gold — bucket silver labels by confidence

Usage:
  npx tsx scripts/eval/promote-to-gold.ts --input <silver.ndjson> [options]

Options:
  --input <path>         Input silver NDJSON file (required).
  --gold <path>          Output path for auto-promoted gold labels.
                         Default: ${DEFAULT_GOLD}
  --audit <path>         Output path for borderline judgments needing review.
                         Default: ${DEFAULT_AUDIT}
  --rejected <path>      Output path for low-confidence rejected labels.
                         Default: ${DEFAULT_REJECTED}
  --help, -h             Show this help and exit.

Thresholds:
  confidence >= ${HIGH_CONFIDENCE_THRESHOLD}       → gold
  ${AUDIT_LOWER_BOUND} <= confidence < ${HIGH_CONFIDENCE_THRESHOLD}  → audit queue
  confidence < ${AUDIT_LOWER_BOUND}        → rejected
`);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let input = '';
  let gold = DEFAULT_GOLD;
  let audit = DEFAULT_AUDIT;
  let rejected = DEFAULT_REJECTED;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--input':
        if (next) { input = next; i++; }
        break;
      case '--gold':
        if (next) { gold = next; i++; }
        break;
      case '--audit':
        if (next) { audit = next; i++; }
        break;
      case '--rejected':
        if (next) { rejected = next; i++; }
        break;
      default:
        break;
    }
  }

  return { input, gold, audit, rejected, help };
}

// ── Bucketing ──────────────────────────────────────────────────────────────

export type PromotionBucket = 'gold' | 'audit' | 'rejected';

export function bucketize(confidence: number): PromotionBucket {
  if (!Number.isFinite(confidence)) return 'rejected';
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return 'gold';
  if (confidence >= AUDIT_LOWER_BOUND) return 'audit';
  return 'rejected';
}

// ── Writer ─────────────────────────────────────────────────────────────────

async function writeNdjson(
  filePath: string,
  judgments: readonly RelevanceJudgment[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = judgments.map((j) => JSON.stringify(j)).join('\n') + (judgments.length ? '\n' : '');
  await fs.writeFile(filePath, body, 'utf8');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.input) {
    process.stderr.write('promote-to-gold: --input is required (use --help for usage)\n');
    process.exit(2);
  }

  const silver = await loadRelevanceJudgments(args.input);
  if (silver.length === 0) {
    process.stderr.write(
      `promote-to-gold: no judgments loaded from ${args.input} (missing file or all lines skipped)\n`,
    );
    return;
  }

  const gold: RelevanceJudgment[] = [];
  const audit: RelevanceJudgment[] = [];
  const rejected: RelevanceJudgment[] = [];

  for (const j of silver) {
    switch (bucketize(j.confidence)) {
      case 'gold':
        gold.push(j);
        break;
      case 'audit':
        audit.push(j);
        break;
      case 'rejected':
        rejected.push(j);
        break;
    }
  }

  try {
    await writeNdjson(args.gold, gold);
    await writeNdjson(args.audit, audit);
    await writeNdjson(args.rejected, rejected);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    bootstrapLogger.error({ error: msg }, 'promote-to-gold: failed to write output');
    process.exit(1);
  }

  const total = silver.length;
  process.stderr.write(`promote-to-gold: processed ${total} silver judgments from ${args.input}\n`);
  process.stderr.write(
    `  gold     → ${gold.length} (${((gold.length / total) * 100).toFixed(1)}%) → ${args.gold}\n`,
  );
  process.stderr.write(
    `  audit    → ${audit.length} (${((audit.length / total) * 100).toFixed(1)}%) → ${args.audit}\n`,
  );
  process.stderr.write(
    `  rejected → ${rejected.length} (${((rejected.length / total) * 100).toFixed(1)}%) → ${args.rejected}\n`,
  );
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`promote-to-gold: fatal: ${msg}\n`);
    process.exit(1);
  });
}
