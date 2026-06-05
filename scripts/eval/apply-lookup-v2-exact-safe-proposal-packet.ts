import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertLookupExactSafeRegistryRowsValid,
  DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
  loadLookupExactSafeRegistry,
  serializeLookupExactSafeRegistryRows,
  type LookupExactSafeRegistryRow,
} from '../etl/lookup-exact-safe-registry.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';

interface ApplyResult {
  readonly mergedRows: readonly LookupExactSafeRegistryRow[];
  readonly approvedRows: number;
  readonly insertedRows: number;
  readonly skippedExistingRows: number;
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
    typeof row['suggestedAliasType'] === 'string' &&
    typeof row['holeClass'] === 'string' &&
    typeof row['benchmarkGoldEntityIdSource'] === 'string' &&
    typeof row['sourceArtifact'] === 'string' &&
    typeof row['sourceEvidence'] === 'string' &&
    typeof row['proposedAt'] === 'string'
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

function buildRegistrySourceEvidence(row: LookupExactSafeProposalPacketRow, packetPath: string): string {
  const packetName = path.basename(packetPath);
  const decision = row.decisionReason !== undefined ? ` decision=${row.decisionReason}` : '';
  const reviewer = row.reviewedBy !== undefined ? ` reviewedBy=${row.reviewedBy}` : '';
  return `${row.sourceEvidence} [packet=${packetName}${reviewer}${decision}]`;
}

export function applyLookupExactSafeProposalPacket(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
  readonly existingRegistryRows: readonly LookupExactSafeRegistryRow[];
  readonly packetPath: string;
}): ApplyResult {
  const mergedRows = args.existingRegistryRows.slice();
  const normalizedOwnerMap = new Map<string, string>();
  const normalizedExistingKeys = new Set<string>();

  for (const row of args.existingRegistryRows) {
    const normalized = normalizeForMatch(row.surface);
    normalizedOwnerMap.set(normalized, row.entityId);
    normalizedExistingKeys.add(`${normalized}::${row.entityId}`);
  }

  let approvedRows = 0;
  let insertedRows = 0;
  let skippedExistingRows = 0;

  for (const row of args.packetRows) {
    if (row.reviewTarget !== 'lookup_exact_safe_registry_v1') {
      throw new Error(`unsupported reviewTarget=${JSON.stringify(row.reviewTarget)} for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.proposalStatus === 'rejected' || row.proposalStatus === 'needs_review') {
      continue;
    }

    approvedRows += 1;
    if (row.reviewedAt === undefined || Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`approved exact-safe proposal is missing reviewedAt for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.reviewedBy === undefined || row.reviewedBy.trim().length === 0) {
      throw new Error(`approved exact-safe proposal is missing reviewedBy for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.decisionReason === undefined || row.decisionReason.trim().length === 0) {
      throw new Error(`approved exact-safe proposal is missing decisionReason for surface=${JSON.stringify(row.surface)}`);
    }

    const normalized = normalizeForMatch(row.surface);
    if (normalized.length === 0) {
      throw new Error(`approved exact-safe proposal normalizes to empty for surface=${JSON.stringify(row.surface)}`);
    }

    const existingOwner = normalizedOwnerMap.get(normalized);
    if (existingOwner !== undefined && existingOwner !== row.entityId) {
      throw new Error(
        `approved exact-safe proposal conflicts with existing owner on surface=${JSON.stringify(row.surface)} existing=${existingOwner} proposed=${row.entityId}`,
      );
    }
    const existingKey = `${normalized}::${row.entityId}`;
    if (normalizedExistingKeys.has(existingKey)) {
      skippedExistingRows += 1;
      continue;
    }

    mergedRows.push({
      surface: row.surface,
      entityId: row.entityId,
      promotionClass: row.candidatePromotionClass,
      locale: row.locale,
      sourceEvidence: buildRegistrySourceEvidence(row, args.packetPath),
      reviewedAt: row.reviewedAt,
    });
    normalizedOwnerMap.set(normalized, row.entityId);
    normalizedExistingKeys.add(existingKey);
    insertedRows += 1;
  }

  assertLookupExactSafeRegistryRowsValid(mergedRows);
  return {
    mergedRows,
    approvedRows,
    insertedRows,
    skippedExistingRows,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/korean-exact-safe-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/korean-exact-safe-registry-merged.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const existingRegistryRows = await loadLookupExactSafeRegistry(registryPath);
  const result = applyLookupExactSafeProposalPacket({
    packetRows,
    existingRegistryRows,
    packetPath: inputPath,
  });

  const targetPath = values.write ? registryPath : outputPath;
  writeFileSync(targetPath, serializeLookupExactSafeRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-exact-safe-proposal-apply] approved_rows=${result.approvedRows}`);
  console.log(`[elv2-exact-safe-proposal-apply] inserted_rows=${result.insertedRows}`);
  console.log(`[elv2-exact-safe-proposal-apply] skipped_existing_rows=${result.skippedExistingRows}`);
  console.log(`[elv2-exact-safe-proposal-apply] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
