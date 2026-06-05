import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';

export interface LookupV2ManualTargetFamilyReviewDecisionRow {
  readonly benchmarkGoldHint: string;
  readonly decision: 'assign_target' | 'reject';
  readonly entityId?: string | undefined;
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

function isLookupV2ManualTargetFamilyReviewPacketRow(value: unknown): value is LookupV2ManualTargetFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['normalizedBenchmarkGoldHint'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2ManualTargetFamilyReviewPacketRow);
}

function isDecisionRow(value: unknown): value is LookupV2ManualTargetFamilyReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['benchmarkGoldHint'] === 'string'
    && (row['decision'] === 'assign_target' || row['decision'] === 'reject')
    && (row['entityId'] === undefined || typeof row['entityId'] === 'string')
    && typeof row['reviewedBy'] === 'string'
    && typeof row['decisionReason'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupV2ManualTargetFamilyReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isDecisionRow);
}

function packetKey(benchmarkGoldHint: string): string {
  return normalizeForMatch(benchmarkGoldHint);
}

export function applyLookupV2ManualTargetFamilyReviewDecisions(args: {
  readonly packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly decisionRows: readonly LookupV2ManualTargetFamilyReviewDecisionRow[];
}): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  const packetByKey = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow>();
  for (const row of args.packetRows) {
    const key = packetKey(row.benchmarkGoldHint);
    if (packetByKey.has(key)) {
      throw new Error(`duplicate manual-target family packet row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    packetByKey.set(key, row);
  }

  const decisionByKey = new Map<string, LookupV2ManualTargetFamilyReviewDecisionRow>();
  for (const row of args.decisionRows) {
    if (row.reviewedBy.trim().length === 0) {
      throw new Error(`manual-target family decision missing reviewedBy for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (row.decisionReason.trim().length === 0) {
      throw new Error(`manual-target family decision missing decisionReason for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`manual-target family decision has invalid reviewedAt for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (row.decision === 'assign_target') {
      if (row.entityId === undefined || row.entityId.trim().length === 0) {
        throw new Error(`manual-target family assign_target decision is missing entityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
    } else if (row.entityId !== undefined && row.entityId.trim().length > 0) {
      throw new Error(`manual-target family reject decision must not carry entityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    const key = packetKey(row.benchmarkGoldHint);
    if (decisionByKey.has(key)) {
      throw new Error(`duplicate manual-target family decision for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (!packetByKey.has(key)) {
      throw new Error(`manual-target family decision references unknown packet row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    decisionByKey.set(key, row);
  }

  return args.packetRows.map((row) => {
    const key = packetKey(row.benchmarkGoldHint);
    const decision = decisionByKey.get(key);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_target_review') {
      throw new Error(`cannot re-review manual-target family row with status=${row.proposalStatus} for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    return {
      ...row,
      proposalStatus: decision.decision === 'assign_target' ? 'target_assigned' : 'rejected',
      ...(decision.decision === 'assign_target' ? { targetEntityId: decision.entityId } : {}),
      reviewedBy: decision.reviewedBy,
      decisionReason: decision.decisionReason,
      reviewedAt: decision.reviewedAt,
    };
  });
}

function serializeRows(rows: readonly LookupV2ManualTargetFamilyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl' },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl';
  const decisionsPath = values.decisions;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const reviewedRows = applyLookupV2ManualTargetFamilyReviewDecisions({ packetRows, decisionRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const assigned = reviewedRows.filter((row) => row.proposalStatus === 'target_assigned').length;
  const rejected = reviewedRows.filter((row) => row.proposalStatus === 'rejected').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_target_review').length;
  console.log(`[elv2-manual-target-family-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-manual-target-family-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-manual-target-family-review] target_assigned=${assigned}`);
  console.log(`[elv2-manual-target-family-review] rejected=${rejected}`);
  console.log(`[elv2-manual-target-family-review] pending=${pending}`);
  console.log(`[elv2-manual-target-family-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
