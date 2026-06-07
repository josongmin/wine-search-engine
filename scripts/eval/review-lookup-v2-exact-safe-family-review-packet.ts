import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeFamilyReviewPacketRow } from './export-lookup-v2-exact-safe-family-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupExactSafeFamilyReviewDecisionRow {
  readonly reviewScopeKey: string;
  readonly decision: 'approve' | 'reject';
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

function isLookupExactSafeFamilyReviewPacketRow(value: unknown): value is LookupExactSafeFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
  );
}

function parsePacketJsonl(filePath: string): readonly LookupExactSafeFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupExactSafeFamilyReviewPacketRow);
}

function isDecisionRow(value: unknown): value is LookupExactSafeFamilyReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && (row['decision'] === 'approve' || row['decision'] === 'reject')
    && typeof row['reviewedBy'] === 'string'
    && typeof row['decisionReason'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupExactSafeFamilyReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isDecisionRow);
}

export function applyLookupV2ExactSafeFamilyReviewDecisions(args: {
  readonly packetRows: readonly LookupExactSafeFamilyReviewPacketRow[];
  readonly decisionRows: readonly LookupExactSafeFamilyReviewDecisionRow[];
}): readonly LookupExactSafeFamilyReviewPacketRow[] {
  const packetByReviewScopeKey = new Map<string, LookupExactSafeFamilyReviewPacketRow>();
  for (const row of args.packetRows) {
    if (packetByReviewScopeKey.has(row.reviewScopeKey)) {
      throw new Error(`duplicate exact-safe family review packet row for reviewScopeKey=${row.reviewScopeKey}`);
    }
    packetByReviewScopeKey.set(row.reviewScopeKey, row);
  }

  const decisionByReviewScopeKey = new Map<string, LookupExactSafeFamilyReviewDecisionRow>();
  for (const row of args.decisionRows) {
    if (row.reviewedBy.trim().length === 0) {
      throw new Error(`exact-safe family review decision missing reviewedBy for reviewScopeKey=${row.reviewScopeKey}`);
    }
    if (row.decisionReason.trim().length === 0) {
      throw new Error(`exact-safe family review decision missing decisionReason for reviewScopeKey=${row.reviewScopeKey}`);
    }
    if (Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`exact-safe family review decision has invalid reviewedAt for reviewScopeKey=${row.reviewScopeKey}`);
    }
    if (decisionByReviewScopeKey.has(row.reviewScopeKey)) {
      throw new Error(`duplicate exact-safe family review decision for reviewScopeKey=${row.reviewScopeKey}`);
    }
    if (!packetByReviewScopeKey.has(row.reviewScopeKey)) {
      continue;
    }
    decisionByReviewScopeKey.set(row.reviewScopeKey, row);
  }

  return args.packetRows.map((row) => {
    const decision = decisionByReviewScopeKey.get(row.reviewScopeKey);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_review') {
      throw new Error(`cannot re-review exact-safe family packet row with status=${row.proposalStatus} for reviewScopeKey=${row.reviewScopeKey}`);
    }
    return {
      ...row,
      proposalStatus: decision.decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: decision.reviewedBy,
      decisionReason: decision.decisionReason,
      reviewedAt: decision.reviewedAt,
    };
  });
}

function serializeRows(rows: readonly LookupExactSafeFamilyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl' },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl');
  const decisionsPath = values.decisions !== undefined ? resolveCliDataPathArg(values.decisions) : undefined;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const reviewedRows = applyLookupV2ExactSafeFamilyReviewDecisions({ packetRows, decisionRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const approved = reviewedRows.filter((row) => row.proposalStatus === 'approved').length;
  const rejected = reviewedRows.filter((row) => row.proposalStatus === 'rejected').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_review').length;
  console.log(`[elv2-exact-safe-family-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-exact-safe-family-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-exact-safe-family-review] approved=${approved}`);
  console.log(`[elv2-exact-safe-family-review] rejected=${rejected}`);
  console.log(`[elv2-exact-safe-family-review] pending=${pending}`);
  console.log(`[elv2-exact-safe-family-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
