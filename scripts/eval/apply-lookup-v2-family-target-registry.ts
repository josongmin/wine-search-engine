import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetRegistrySync,
  serializeLookupV2FamilyTargetRegistryRows,
  type LookupV2FamilyTargetRegistryRow,
} from './lookup-v2-family-target-registry.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

interface FamilyTargetRegistryApplyResult {
  readonly mergedRows: readonly LookupV2FamilyTargetRegistryRow[];
  readonly pendingRows: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly registryInsertedRows: number;
  readonly registrySkippedExistingRows: number;
  readonly registryConflictRows: number;
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

function buildRegistryRow(
  row: LookupV2ManualTargetFamilyReviewPacketRow,
): LookupV2FamilyTargetRegistryRow {
  if (row.reviewedAt === undefined || Number.isNaN(Date.parse(row.reviewedAt))) {
    throw new Error(`family-target reviewed row is missing reviewedAt for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (row.reviewedBy === undefined || row.reviewedBy.trim().length === 0) {
    throw new Error(`family-target reviewed row is missing reviewedBy for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (row.decisionReason === undefined || row.decisionReason.trim().length === 0) {
    throw new Error(`family-target reviewed row is missing decisionReason for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (row.proposalStatus === 'target_assigned') {
    if (row.targetEntityId === undefined || row.targetEntityId.trim().length === 0) {
      throw new Error(`family-target approved row is missing targetEntityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    return {
      benchmarkGoldHint: row.benchmarkGoldHint,
      normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
      entityId: row.targetEntityId,
      decisionStatus: 'approved',
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      decisionReason: row.decisionReason,
      evidenceClass: 'manual_target_family_review',
    };
  }
  return {
    benchmarkGoldHint: row.benchmarkGoldHint,
    normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
    decisionStatus: 'rejected',
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    decisionReason: row.decisionReason,
    evidenceClass: 'manual_target_family_review',
  };
}

function sameRegistryRow(
  left: LookupV2FamilyTargetRegistryRow,
  right: LookupV2FamilyTargetRegistryRow,
): boolean {
  return (
    left.normalizedBenchmarkGoldHint === right.normalizedBenchmarkGoldHint
    && left.decisionStatus === right.decisionStatus
    && (left.entityId ?? '') === (right.entityId ?? '')
  );
}

export function applyLookupV2FamilyTargetRegistry(args: {
  readonly familyRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly existingRegistryRows: readonly LookupV2FamilyTargetRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): FamilyTargetRegistryApplyResult {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const mergedRows = args.existingRegistryRows.slice();
  const existingByHint = new Map(
    args.existingRegistryRows.map((row) => [row.normalizedBenchmarkGoldHint, row] as const),
  );
  let pendingRows = 0;
  let approvedRows = 0;
  let rejectedRows = 0;
  let registryInsertedRows = 0;
  let registrySkippedExistingRows = 0;
  let registryConflictRows = 0;

  for (const row of args.familyRows) {
    if (row.proposalStatus === 'needs_target_review') {
      pendingRows += 1;
      continue;
    }
    const registryRow = buildRegistryRow(row);
    if (registryRow.entityId !== undefined && !knownEntityIds.has(registryRow.entityId)) {
      throw new Error(`family-target registry apply references unknown entityId=${JSON.stringify(registryRow.entityId)} for hint=${JSON.stringify(registryRow.benchmarkGoldHint)}`);
    }
    if (registryRow.decisionStatus === 'approved') {
      approvedRows += 1;
    } else {
      rejectedRows += 1;
    }

    const existing = existingByHint.get(registryRow.normalizedBenchmarkGoldHint);
    if (existing !== undefined) {
      if (sameRegistryRow(existing, registryRow)) {
        registrySkippedExistingRows += 1;
        continue;
      }
      registryConflictRows += 1;
      continue;
    }

    existingByHint.set(registryRow.normalizedBenchmarkGoldHint, registryRow);
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
      input: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-family-target-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-family-target-registry-merged.jsonl';
  const familyRows = parsePacketJsonl(inputPath).filter(isLookupV2ManualTargetFamilyReviewPacketRow);
  const existingRegistryRows = loadLookupV2FamilyTargetRegistrySync(registryPath);
  const result = applyLookupV2FamilyTargetRegistry({
    familyRows,
    existingRegistryRows,
  });

  const targetPath = values.write ? registryPath : outputPath;
  if (values.write && result.registryConflictRows > 0) {
    throw new Error(`family-target registry apply refused to write with registry_conflict_rows=${result.registryConflictRows}`);
  }
  writeFileSync(targetPath, serializeLookupV2FamilyTargetRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-family-target-registry-apply] pending_rows=${result.pendingRows}`);
  console.log(`[elv2-family-target-registry-apply] approved_rows=${result.approvedRows}`);
  console.log(`[elv2-family-target-registry-apply] rejected_rows=${result.rejectedRows}`);
  console.log(`[elv2-family-target-registry-apply] registry_inserted_rows=${result.registryInsertedRows}`);
  console.log(`[elv2-family-target-registry-apply] registry_skipped_existing_rows=${result.registrySkippedExistingRows}`);
  console.log(`[elv2-family-target-registry-apply] registry_conflict_rows=${result.registryConflictRows}`);
  console.log(`[elv2-family-target-registry-apply] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
