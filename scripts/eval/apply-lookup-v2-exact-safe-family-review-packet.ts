import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';
import type { LookupExactSafeFamilyReviewPacketRow } from './export-lookup-v2-exact-safe-family-review-packet.js';

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
  );
}

function isLookupExactSafeFamilyReviewPacketRow(value: unknown): value is LookupExactSafeFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['entityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
  );
}

function parsePacketJsonl<T>(
  filePath: string,
  predicate: (value: unknown) => value is T,
): readonly T[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(predicate);
}

export function applyLookupV2ExactSafeFamilyReviewPacket(args: {
  readonly familyRows: readonly LookupExactSafeFamilyReviewPacketRow[];
  readonly rowPacketRows: readonly LookupExactSafeProposalPacketRow[];
}): readonly LookupExactSafeProposalPacketRow[] {
  const familyByEntityId = new Map<string, LookupExactSafeFamilyReviewPacketRow>();
  for (const row of args.familyRows) {
    if (familyByEntityId.has(row.entityId)) {
      throw new Error(`duplicate exact-safe family review row for entityId=${row.entityId}`);
    }
    familyByEntityId.set(row.entityId, row);
  }

  return args.rowPacketRows.map((row) => {
    const family = familyByEntityId.get(row.entityId);
    if (family === undefined) {
      throw new Error(`exact-safe row packet has no family review row for entityId=${row.entityId}`);
    }
    if (family.proposalStatus === 'needs_review') {
      return row;
    }
    return {
      ...row,
      proposalStatus: family.proposalStatus,
      reviewedAt: family.reviewedAt,
      reviewedBy: family.reviewedBy,
      decisionReason: family.decisionReason,
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
      families: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl' },
      rows: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed-from-family.jsonl' },
    },
  });

  const familiesPath = values.families ?? '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl';
  const rowsPath = values.rows ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed-from-family.jsonl';
  const familyRows = parsePacketJsonl(familiesPath, isLookupExactSafeFamilyReviewPacketRow);
  const rowPacketRows = parsePacketJsonl(rowsPath, isLookupExactSafeProposalPacketRow);
  const reviewedRows = applyLookupV2ExactSafeFamilyReviewPacket({ familyRows, rowPacketRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const approved = reviewedRows.filter((row) => row.proposalStatus === 'approved').length;
  const rejected = reviewedRows.filter((row) => row.proposalStatus === 'rejected').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_review').length;
  console.log(`[elv2-exact-safe-family-apply] family_rows=${familyRows.length}`);
  console.log(`[elv2-exact-safe-family-apply] row_packet_rows=${rowPacketRows.length}`);
  console.log(`[elv2-exact-safe-family-apply] approved_rows=${approved}`);
  console.log(`[elv2-exact-safe-family-apply] rejected_rows=${rejected}`);
  console.log(`[elv2-exact-safe-family-apply] pending_rows=${pending}`);
  console.log(`[elv2-exact-safe-family-apply] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
