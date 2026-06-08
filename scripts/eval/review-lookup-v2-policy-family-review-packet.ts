import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2PolicyFamilyReviewDecisionRow {
  readonly semanticConflictKey: string;
  readonly policyConflictSurface: string;
  readonly benchmarkGoldEntityId: string;
  readonly decision: 'promote_exact_safe' | 'keep_ambiguous' | 'needs_scope_target';
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

function isLookupV2PolicyFamilyReviewPacketRow(value: unknown): value is LookupV2PolicyFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['policyConflictSurface'] === 'string'
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['benchmarkGoldHints'])
    && Array.isArray(row['sampleSurfaces'])
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2PolicyFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2PolicyFamilyReviewPacketRow);
}

function isDecisionRow(value: unknown): value is LookupV2PolicyFamilyReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['semanticConflictKey'] === 'string'
    && typeof row['policyConflictSurface'] === 'string'
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && (row['decision'] === 'promote_exact_safe'
      || row['decision'] === 'keep_ambiguous'
      || row['decision'] === 'needs_scope_target')
    && typeof row['reviewedBy'] === 'string'
    && typeof row['decisionReason'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupV2PolicyFamilyReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isDecisionRow);
}

function packetKey(semanticConflictKey: string, benchmarkGoldEntityId: string): string {
  return `${semanticConflictKey}::${benchmarkGoldEntityId}`;
}

export function applyLookupV2PolicyFamilyReviewDecisions(args: {
  readonly packetRows: readonly LookupV2PolicyFamilyReviewPacketRow[];
  readonly decisionRows: readonly LookupV2PolicyFamilyReviewDecisionRow[];
}): readonly LookupV2PolicyFamilyReviewPacketRow[] {
  const packetByKey = new Map<string, LookupV2PolicyFamilyReviewPacketRow>();
  for (const row of args.packetRows) {
    const key = packetKey(row.semanticConflictKey, row.benchmarkGoldEntityId);
    if (packetByKey.has(key)) {
      throw new Error(`duplicate family policy-review packet row for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    packetByKey.set(key, row);
  }

  const decisionByKey = new Map<string, LookupV2PolicyFamilyReviewDecisionRow>();
  for (const row of args.decisionRows) {
    if (row.reviewedBy.trim().length === 0) {
      throw new Error(`family policy-review decision missing reviewedBy for surface=${JSON.stringify(row.policyConflictSurface)}`);
    }
    if (row.decisionReason.trim().length === 0) {
      throw new Error(`family policy-review decision missing decisionReason for surface=${JSON.stringify(row.policyConflictSurface)}`);
    }
    if (Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`family policy-review decision has invalid reviewedAt for surface=${JSON.stringify(row.policyConflictSurface)}`);
    }
    const key = packetKey(row.semanticConflictKey, row.benchmarkGoldEntityId);
    if (decisionByKey.has(key)) {
      throw new Error(`duplicate family policy-review decision for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    if (!packetByKey.has(key)) {
      continue;
    }
    decisionByKey.set(key, row);
  }

  return args.packetRows.map((row) => {
    const key = packetKey(row.semanticConflictKey, row.benchmarkGoldEntityId);
    const decision = decisionByKey.get(key);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_policy_review') {
      throw new Error(`cannot re-review family policy-review packet row with status=${row.proposalStatus} for surface=${JSON.stringify(row.policyConflictSurface)}`);
    }
    return {
      ...row,
      proposalStatus: decision.decision === 'promote_exact_safe'
        ? 'approved_exact_safe'
        : decision.decision === 'keep_ambiguous'
          ? 'kept_ambiguous'
          : 'needs_scope_target',
      reviewedBy: decision.reviewedBy,
      decisionReason: decision.decisionReason,
      reviewedAt: decision.reviewedAt,
    };
  });
}

function serializeRows(rows: readonly LookupV2PolicyFamilyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl') },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl'));
  const decisionsPath = values.decisions !== undefined ? resolveCliDataPathArg(values.decisions) : undefined;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const reviewedRows = applyLookupV2PolicyFamilyReviewDecisions({ packetRows, decisionRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const approved = reviewedRows.filter((row) => row.proposalStatus === 'approved_exact_safe').length;
  const kept = reviewedRows.filter((row) => row.proposalStatus === 'kept_ambiguous').length;
  const needsTarget = reviewedRows.filter((row) => row.proposalStatus === 'needs_scope_target').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_policy_review').length;
  console.log(`[elv2-policy-family-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-policy-family-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-policy-family-review] approved_exact_safe=${approved}`);
  console.log(`[elv2-policy-family-review] kept_ambiguous=${kept}`);
  console.log(`[elv2-policy-family-review] needs_scope_target=${needsTarget}`);
  console.log(`[elv2-policy-family-review] pending=${pending}`);
  console.log(`[elv2-policy-family-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
