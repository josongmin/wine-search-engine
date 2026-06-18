import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LookupExactSafeFamilyReviewPacketRow } from './export-lookup-v2-exact-safe-family-review-packet.js';
import {
  DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH,
  loadLookupV2ExactSafeScopeRegistrySync,
  serializeLookupV2ExactSafeScopeRegistryRows,
  type LookupV2ExactSafeScopeRegistryRow,
} from './lookup-v2-exact-safe-scope-registry.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

interface ExactSafeScopeRegistryApplyResult {
  readonly mergedRows: readonly LookupV2ExactSafeScopeRegistryRow[];
  readonly pendingRows: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly registryInsertedRows: number;
  readonly registrySkippedExistingRows: number;
  readonly registryConflictRows: number;
}

function isLookupExactSafeFamilyReviewPacketRow(value: unknown): value is LookupExactSafeFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['entityId'] === 'string'
    && typeof row['scopeHoleClass'] === 'string'
    && typeof row['scopeSuggestedAliasType'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
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

function buildRegistryRow(row: LookupExactSafeFamilyReviewPacketRow): LookupV2ExactSafeScopeRegistryRow {
  if (row.reviewedAt === undefined || Number.isNaN(Date.parse(row.reviewedAt))) {
    throw new Error(`exact-safe scope reviewed row is missing reviewedAt for reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`);
  }
  if (row.reviewedBy === undefined || row.reviewedBy.trim().length === 0) {
    throw new Error(`exact-safe scope reviewed row is missing reviewedBy for reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`);
  }
  if (row.decisionReason === undefined || row.decisionReason.trim().length === 0) {
    throw new Error(`exact-safe scope reviewed row is missing decisionReason for reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`);
  }
  return {
    reviewScopeKey: row.reviewScopeKey,
    entityId: row.entityId,
    scopeHoleClass: row.scopeHoleClass,
    scopeSuggestedAliasType: row.scopeSuggestedAliasType,
    decisionStatus: row.proposalStatus === 'approved' ? 'approved' : 'rejected',
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    decisionReason: row.decisionReason,
    evidenceClass: 'exact_safe_family_review',
  };
}

function sameRegistryRow(
  left: LookupV2ExactSafeScopeRegistryRow,
  right: LookupV2ExactSafeScopeRegistryRow,
): boolean {
  return (
    left.reviewScopeKey === right.reviewScopeKey
    && left.decisionStatus === right.decisionStatus
    && left.entityId === right.entityId
  );
}

export function applyLookupV2ExactSafeScopeRegistry(args: {
  readonly familyRows: readonly LookupExactSafeFamilyReviewPacketRow[];
  readonly existingRegistryRows: readonly LookupV2ExactSafeScopeRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): ExactSafeScopeRegistryApplyResult {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const mergedRows = args.existingRegistryRows.slice();
  const existingByScope = new Map(
    args.existingRegistryRows.map((row) => [row.reviewScopeKey, row] as const),
  );
  let pendingRows = 0;
  let approvedRows = 0;
  let rejectedRows = 0;
  let registryInsertedRows = 0;
  let registrySkippedExistingRows = 0;
  let registryConflictRows = 0;

  for (const row of args.familyRows) {
    if (row.proposalStatus === 'needs_review') {
      pendingRows += 1;
      continue;
    }
    const registryRow = buildRegistryRow(row);
    if (!knownEntityIds.has(registryRow.entityId)) {
      throw new Error(`exact-safe scope registry apply references unknown entityId=${JSON.stringify(registryRow.entityId)} for reviewScopeKey=${JSON.stringify(registryRow.reviewScopeKey)}`);
    }
    if (registryRow.decisionStatus === 'approved') {
      approvedRows += 1;
    } else {
      rejectedRows += 1;
    }
    const existing = existingByScope.get(registryRow.reviewScopeKey);
    if (existing !== undefined) {
      if (sameRegistryRow(existing, registryRow)) {
        registrySkippedExistingRows += 1;
        continue;
      }
      registryConflictRows += 1;
      continue;
    }
    existingByScope.set(registryRow.reviewScopeKey, registryRow);
    mergedRows.push(registryRow);
    registryInsertedRows += 1;
  }

  return {
    mergedRows,
    pendingRows,
    approvedRows,
    rejectedRows,
    registryInsertedRows,
    registrySkippedExistingRows,
    registryConflictRows,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-exact-safe-scope-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-exact-safe-scope-registry-merged.jsonl';
  const familyRows = parsePacketJsonl(inputPath);
  const existingRegistryRows = loadLookupV2ExactSafeScopeRegistrySync(registryPath);
  const result = applyLookupV2ExactSafeScopeRegistry({
    familyRows,
    existingRegistryRows,
  });

  const targetPath = values.write ? registryPath : outputPath;
  if (values.write && result.registryConflictRows > 0) {
    throw new Error(`exact-safe scope registry apply refused to write with registry_conflict_rows=${result.registryConflictRows}`);
  }
  writeFileSync(targetPath, serializeLookupV2ExactSafeScopeRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-exact-safe-scope-registry-apply] pending_rows=${result.pendingRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] approved_rows=${result.approvedRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] rejected_rows=${result.rejectedRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] registry_inserted_rows=${result.registryInsertedRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] registry_skipped_existing_rows=${result.registrySkippedExistingRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] registry_conflict_rows=${result.registryConflictRows}`);
  console.log(`[elv2-exact-safe-scope-registry-apply] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
