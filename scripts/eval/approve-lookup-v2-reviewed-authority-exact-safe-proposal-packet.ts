import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';

const REVIEWED_AUTHORITY_SOURCES = new Set([
  'fixture_exact',
  'policy_family_decision_registry',
] satisfies readonly LookupExactSafeProposalPacketRow['benchmarkGoldEntityIdSource'][]);

function isLookupExactSafeProposalPacketRow(value: unknown): value is LookupExactSafeProposalPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['entityId'] === 'string'
    && typeof row['candidatePromotionClass'] === 'string'
    && typeof row['locale'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && typeof row['suggestedAliasType'] === 'string'
    && typeof row['holeClass'] === 'string'
    && typeof row['benchmarkGoldEntityIdSource'] === 'string'
    && typeof row['sourceArtifact'] === 'string'
    && typeof row['sourceEvidence'] === 'string'
    && typeof row['proposedAt'] === 'string'
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

export function approveLookupV2ReviewedAuthorityExactSafeProposalPacket(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
  readonly reviewedAt: string;
  readonly reviewedBy: string;
  readonly decisionReason: string;
}): readonly LookupExactSafeProposalPacketRow[] {
  if (args.reviewedBy.trim().length === 0) {
    throw new Error('reviewed authority exact-safe approval requires reviewedBy');
  }
  if (args.decisionReason.trim().length === 0) {
    throw new Error('reviewed authority exact-safe approval requires decisionReason');
  }
  if (Number.isNaN(Date.parse(args.reviewedAt))) {
    throw new Error('reviewed authority exact-safe approval requires valid reviewedAt');
  }

  return args.packetRows.map((row) => {
    if (!REVIEWED_AUTHORITY_SOURCES.has(row.benchmarkGoldEntityIdSource)) {
      return row;
    }
    if (row.proposalStatus === 'rejected') {
      return row;
    }
    return {
      ...row,
      proposalStatus: 'approved',
      reviewedAt: args.reviewedAt,
      reviewedBy: args.reviewedBy,
      decisionReason: args.decisionReason,
    };
  });
}

function serializeRows(rows: readonly LookupExactSafeProposalPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-reviewed-authority-exact-safe-proposals-approved.jsonl' },
      reviewedBy: { type: 'string', default: 'registry:reviewed-authority' },
      reviewedAt: { type: 'string', default: new Date().toISOString() },
      decisionReason: { type: 'string', default: 'approved upstream reviewed authority source' },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-reviewed-authority-exact-safe-proposals-approved.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const approvedRows = approveLookupV2ReviewedAuthorityExactSafeProposalPacket({
    packetRows,
    reviewedBy: values.reviewedBy ?? 'registry:reviewed-authority',
    reviewedAt: values.reviewedAt ?? new Date().toISOString(),
    decisionReason: values.decisionReason ?? 'approved upstream reviewed authority source',
  });

  writeFileSync(outputPath, serializeRows(approvedRows), 'utf8');
  const approvedCount = approvedRows.filter((row) => row.proposalStatus === 'approved').length;
  const pendingCount = approvedRows.filter((row) => row.proposalStatus === 'needs_review').length;
  console.log(`[elv2-reviewed-authority-exact-safe-approve] packet_rows=${packetRows.length}`);
  console.log(`[elv2-reviewed-authority-exact-safe-approve] approved_rows=${approvedCount}`);
  console.log(`[elv2-reviewed-authority-exact-safe-approve] pending_rows=${pendingCount}`);
  console.log(`[elv2-reviewed-authority-exact-safe-approve] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
