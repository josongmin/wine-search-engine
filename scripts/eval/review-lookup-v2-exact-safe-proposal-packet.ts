import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';

export interface LookupExactSafeProposalReviewDecisionRow {
  readonly surface: string;
  readonly entityId: string;
  readonly decision: 'approve' | 'reject';
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

function isLookupExactSafeProposalPacketRow(value: unknown): value is LookupExactSafeProposalPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string' &&
    typeof row['entityId'] === 'string' &&
    typeof row['candidatePromotionClass'] === 'string' &&
    typeof row['locale'] === 'string' &&
    typeof row['proposalStatus'] === 'string' &&
    typeof row['reviewTarget'] === 'string' &&
    typeof row['suggestedAliasType'] === 'string'
  );
}

function parsePacketJsonl(filePath: string): readonly LookupExactSafeProposalPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupExactSafeProposalPacketRow);
}

function isReviewDecisionRow(value: unknown): value is LookupExactSafeProposalReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string' &&
    typeof row['entityId'] === 'string' &&
    (row['decision'] === 'approve' || row['decision'] === 'reject') &&
    typeof row['reviewedBy'] === 'string' &&
    typeof row['decisionReason'] === 'string' &&
    typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupExactSafeProposalReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isReviewDecisionRow);
}

function packetKey(surface: string, entityId: string): string {
  return `${normalizeForMatch(surface)}::${entityId}`;
}

export function applyLookupExactSafeProposalReviewDecisions(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
  readonly decisionRows: readonly LookupExactSafeProposalReviewDecisionRow[];
}): readonly LookupExactSafeProposalPacketRow[] {
  const packetByKey = new Map<string, LookupExactSafeProposalPacketRow>();
  for (const row of args.packetRows) {
    const key = packetKey(row.surface, row.entityId);
    if (packetByKey.has(key)) {
      throw new Error(`duplicate exact-safe packet row for surface=${JSON.stringify(row.surface)} entityId=${row.entityId}`);
    }
    packetByKey.set(key, row);
  }

  const decisionByKey = new Map<string, LookupExactSafeProposalReviewDecisionRow>();
  for (const row of args.decisionRows) {
    if (row.reviewedBy.trim().length === 0) {
      throw new Error(`review decision missing reviewedBy for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.decisionReason.trim().length === 0) {
      throw new Error(`review decision missing decisionReason for surface=${JSON.stringify(row.surface)}`);
    }
    if (Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`review decision has invalid reviewedAt for surface=${JSON.stringify(row.surface)}`);
    }
    const key = packetKey(row.surface, row.entityId);
    if (decisionByKey.has(key)) {
      throw new Error(`duplicate review decision for surface=${JSON.stringify(row.surface)} entityId=${row.entityId}`);
    }
    if (!packetByKey.has(key)) {
      throw new Error(`review decision references unknown packet row for surface=${JSON.stringify(row.surface)} entityId=${row.entityId}`);
    }
    decisionByKey.set(key, row);
  }

  return args.packetRows.map((row) => {
    const key = packetKey(row.surface, row.entityId);
    const decision = decisionByKey.get(key);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_review') {
      throw new Error(`cannot re-review exact-safe packet row with status=${row.proposalStatus} for surface=${JSON.stringify(row.surface)}`);
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

function serializePacketRows(rows: readonly LookupExactSafeProposalPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl' },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed.jsonl' },
    },
    allowPositionals: false,
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl';
  const decisionsPath = values.decisions;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const reviewedRows = applyLookupExactSafeProposalReviewDecisions({
    packetRows,
    decisionRows,
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializePacketRows(reviewedRows), 'utf8');

  const approved = reviewedRows.filter((row) => row.proposalStatus === 'approved').length;
  const rejected = reviewedRows.filter((row) => row.proposalStatus === 'rejected').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_review').length;
  console.log(`[elv2-exact-safe-proposal-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-exact-safe-proposal-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-exact-safe-proposal-review] approved=${approved}`);
  console.log(`[elv2-exact-safe-proposal-review] rejected=${rejected}`);
  console.log(`[elv2-exact-safe-proposal-review] pending=${pending}`);
  console.log(`[elv2-exact-safe-proposal-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
