import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2PolicyReviewPacketRow } from './export-lookup-v2-policy-review-packet.js';

export interface LookupV2PolicyReviewDecisionRow {
  readonly surface: string;
  readonly benchmarkGoldHint: string;
  readonly decision: 'promote_exact_safe' | 'keep_policy_conflict' | 'needs_target';
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

function isLookupV2PolicyReviewPacketRow(value: unknown): value is LookupV2PolicyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['policyConflictSurface'] === 'string'
    && typeof row['policyConflictType'] === 'string'
    && typeof row['authorityStatus'] === 'string'
    && typeof row['stretchExpectedStatus'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && typeof row['sourceArtifact'] === 'string'
    && typeof row['sourceEvidence'] === 'string'
    && typeof row['proposedAt'] === 'string'
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2PolicyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2PolicyReviewPacketRow);
}

function isReviewDecisionRow(value: unknown): value is LookupV2PolicyReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
    && (row['decision'] === 'promote_exact_safe'
      || row['decision'] === 'keep_policy_conflict'
      || row['decision'] === 'needs_target')
    && typeof row['reviewedBy'] === 'string'
    && typeof row['decisionReason'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupV2PolicyReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isReviewDecisionRow);
}

function packetKey(surface: string, benchmarkGoldHint: string): string {
  return `${normalizeForMatch(surface)}::${normalizeForMatch(benchmarkGoldHint)}`;
}

export function applyLookupV2PolicyReviewDecisions(args: {
  readonly packetRows: readonly LookupV2PolicyReviewPacketRow[];
  readonly decisionRows: readonly LookupV2PolicyReviewDecisionRow[];
}): readonly LookupV2PolicyReviewPacketRow[] {
  const packetByKey = new Map<string, LookupV2PolicyReviewPacketRow>();
  for (const row of args.packetRows) {
    const key = packetKey(row.surface, row.benchmarkGoldHint);
    if (packetByKey.has(key)) {
      throw new Error(`duplicate policy-review packet row for surface=${JSON.stringify(row.surface)} benchmarkGoldHint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    packetByKey.set(key, row);
  }

  const decisionByKey = new Map<string, LookupV2PolicyReviewDecisionRow>();
  for (const row of args.decisionRows) {
    if (row.reviewedBy.trim().length === 0) {
      throw new Error(`policy-review decision missing reviewedBy for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.decisionReason.trim().length === 0) {
      throw new Error(`policy-review decision missing decisionReason for surface=${JSON.stringify(row.surface)}`);
    }
    if (Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`policy-review decision has invalid reviewedAt for surface=${JSON.stringify(row.surface)}`);
    }
    const key = packetKey(row.surface, row.benchmarkGoldHint);
    if (decisionByKey.has(key)) {
      throw new Error(`duplicate policy-review decision for surface=${JSON.stringify(row.surface)} benchmarkGoldHint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (!packetByKey.has(key)) {
      throw new Error(`policy-review decision references unknown packet row for surface=${JSON.stringify(row.surface)} benchmarkGoldHint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    decisionByKey.set(key, row);
  }

  return args.packetRows.map((row) => {
    const key = packetKey(row.surface, row.benchmarkGoldHint);
    const decision = decisionByKey.get(key);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_policy_review') {
      throw new Error(`cannot re-review policy-review packet row with status=${row.proposalStatus} for surface=${JSON.stringify(row.surface)}`);
    }
    return {
      ...row,
      proposalStatus: decision.decision === 'promote_exact_safe'
        ? 'approved_exact_safe'
        : decision.decision === 'keep_policy_conflict'
          ? 'kept_policy_conflict'
          : 'needs_target',
      reviewedBy: decision.reviewedBy,
      decisionReason: decision.decisionReason,
      reviewedAt: decision.reviewedAt,
    };
  });
}

function serializePacketRows(rows: readonly LookupV2PolicyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl' },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed.jsonl' },
    },
    allowPositionals: false,
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl';
  const decisionsPath = values.decisions;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const reviewedRows = applyLookupV2PolicyReviewDecisions({
    packetRows,
    decisionRows,
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializePacketRows(reviewedRows), 'utf8');

  const approvedExactSafe = reviewedRows.filter((row) => row.proposalStatus === 'approved_exact_safe').length;
  const keptPolicyConflict = reviewedRows.filter((row) => row.proposalStatus === 'kept_policy_conflict').length;
  const needsTarget = reviewedRows.filter((row) => row.proposalStatus === 'needs_target').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_policy_review').length;
  console.log(`[elv2-policy-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-policy-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-policy-review] approved_exact_safe=${approvedExactSafe}`);
  console.log(`[elv2-policy-review] kept_policy_conflict=${keptPolicyConflict}`);
  console.log(`[elv2-policy-review] needs_target=${needsTarget}`);
  console.log(`[elv2-policy-review] pending=${pending}`);
  console.log(`[elv2-policy-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
