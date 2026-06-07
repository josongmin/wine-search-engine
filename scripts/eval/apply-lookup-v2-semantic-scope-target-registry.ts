import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetRegistrySync,
  serializeLookupV2SemanticScopeTargetRegistryRows,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from './lookup-v2-runtime-semantic-descriptors.js';

interface SemanticScopeTargetRegistryApplyResult {
  readonly mergedRows: readonly LookupV2SemanticScopeTargetRegistryRow[];
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
    (typeof row['semanticScopeKey'] === 'string' || typeof row['reviewScopeKey'] === 'string')
    && typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['normalizedBenchmarkGoldHint'] === 'string'
    && typeof row['scopeAxis'] === 'string'
    && typeof row['familyKey'] === 'string'
    && typeof row['surfaceFormKind'] === 'string'
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
): LookupV2SemanticScopeTargetRegistryRow {
  const evidenceClass = row.reviewTarget === 'lookup_reviewed_collision_resolution_v1'
    ? 'reviewed_collision_family_review'
    : 'manual_target_family_review';
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
      semanticScopeKey: row.semanticScopeKey,
      benchmarkGoldHint: row.benchmarkGoldHint,
      normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
      scopeAxis: row.scopeAxis,
      familyKey: row.familyKey,
      ...(row.lineKey !== undefined ? { lineKey: row.lineKey } : {}),
      ...(row.regionKey !== undefined ? { regionKey: row.regionKey } : {}),
      ...(row.appellationKey !== undefined ? { appellationKey: row.appellationKey } : {}),
      ...(row.vintage !== undefined ? { vintage: row.vintage } : {}),
      surfaceFormKind: row.surfaceFormKind,
      locale: row.locales.includes('ko') ? 'ko' : 'global',
      entityId: row.targetEntityId,
      decisionStatus: 'approved',
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      decisionReason: row.decisionReason,
      evidenceClass,
    };
  }
  return {
    semanticScopeKey: row.semanticScopeKey,
    benchmarkGoldHint: row.benchmarkGoldHint,
    normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
    scopeAxis: row.scopeAxis,
    familyKey: row.familyKey,
    ...(row.lineKey !== undefined ? { lineKey: row.lineKey } : {}),
    ...(row.regionKey !== undefined ? { regionKey: row.regionKey } : {}),
    ...(row.appellationKey !== undefined ? { appellationKey: row.appellationKey } : {}),
    ...(row.vintage !== undefined ? { vintage: row.vintage } : {}),
    surfaceFormKind: row.surfaceFormKind,
    locale: row.locales.includes('ko') ? 'ko' : 'global',
    decisionStatus: 'rejected',
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    decisionReason: row.decisionReason,
    evidenceClass,
  };
}

function sameRegistryRow(
  left: LookupV2SemanticScopeTargetRegistryRow,
  right: LookupV2SemanticScopeTargetRegistryRow,
): boolean {
  return (
    left.semanticScopeKey === right.semanticScopeKey
    && left.decisionStatus === right.decisionStatus
    && (left.entityId ?? '') === (right.entityId ?? '')
  );
}

function registryRowMatchesDescriptor(args: {
  readonly registryRow: LookupV2SemanticScopeTargetRegistryRow;
  readonly descriptor: {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  };
}): boolean {
  return (
    args.registryRow.familyKey === args.descriptor.familyKey
    && (args.registryRow.lineKey === undefined || args.registryRow.lineKey === args.descriptor.lineKey)
    && (args.registryRow.regionKey === undefined || args.registryRow.regionKey === args.descriptor.regionKey)
    && (args.registryRow.appellationKey === undefined || args.registryRow.appellationKey === args.descriptor.appellationKey)
    && (args.registryRow.vintage === undefined || args.registryRow.vintage === args.descriptor.vintage)
  );
}

export function applyLookupV2SemanticScopeTargetRegistry(args: {
  readonly familyRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly existingRegistryRows: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
  readonly runtimeDescriptorMap?: ReadonlyMap<string, unknown>;
}): SemanticScopeTargetRegistryApplyResult {
  if (args.familyRows.length === 0) {
    return {
      mergedRows: args.existingRegistryRows.slice(),
      pendingRows: 0,
      approvedRows: 0,
      rejectedRows: 0,
      registryInsertedRows: 0,
      registrySkippedExistingRows: 0,
      registryConflictRows: 0,
    };
  }
  const runtimeDescriptorMap = args.runtimeDescriptorMap ?? loadLookupV2RuntimeSemanticDescriptorMapSync();
  const knownEntityIds = args.knownEntityIds
    ?? new Set<string>(runtimeDescriptorMap.keys());
  const mergedRows = args.existingRegistryRows.slice();
  const existingByHint = new Map(
    args.existingRegistryRows.map((row) => [row.semanticScopeKey, row] as const),
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
      throw new Error(`semantic-scope-target registry apply references unknown entityId=${JSON.stringify(registryRow.entityId)} for hint=${JSON.stringify(registryRow.benchmarkGoldHint)}`);
    }
    if (registryRow.entityId !== undefined) {
      const descriptor = runtimeDescriptorMap.get(registryRow.entityId);
      if (descriptor === undefined) {
        throw new Error(`semantic-scope-target registry apply missing runtime descriptor for entityId=${JSON.stringify(registryRow.entityId)} for hint=${JSON.stringify(registryRow.benchmarkGoldHint)}`);
      }
      if (!registryRowMatchesDescriptor({ registryRow, descriptor })) {
        registryConflictRows += 1;
        continue;
      }
    }
    if (registryRow.decisionStatus === 'approved') {
      approvedRows += 1;
    } else {
      rejectedRows += 1;
    }

    const existing = existingByHint.get(registryRow.semanticScopeKey);
    if (existing !== undefined) {
      if (sameRegistryRow(existing, registryRow)) {
        registrySkippedExistingRows += 1;
        continue;
      }
      registryConflictRows += 1;
      continue;
    }

    existingByHint.set(registryRow.semanticScopeKey, registryRow);
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
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-semantic-scope-target-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-semantic-scope-target-registry-merged.jsonl';
  const familyRows = parsePacketJsonl(inputPath).filter(isLookupV2ManualTargetFamilyReviewPacketRow);
  const existingRegistryRows = loadLookupV2SemanticScopeTargetRegistrySync(registryPath);
  const result = applyLookupV2SemanticScopeTargetRegistry({
    familyRows,
    existingRegistryRows,
  });

  const targetPath = values.write ? registryPath : outputPath;
  if (values.write && result.registryConflictRows > 0) {
    throw new Error(`semantic-scope-target registry apply refused to write with registry_conflict_rows=${result.registryConflictRows}`);
  }
  writeFileSync(targetPath, serializeLookupV2SemanticScopeTargetRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-semantic-scope-target-registry-apply] pending_rows=${result.pendingRows}`);
  console.log(`[elv2-semantic-scope-target-registry-apply] approved_rows=${result.approvedRows}`);
  console.log(`[elv2-semantic-scope-target-registry-apply] rejected_rows=${result.rejectedRows}`);
  console.log(`[elv2-semantic-scope-target-registry-apply] registry_inserted_rows=${result.registryInsertedRows}`);
  console.log(`[elv2-semantic-scope-target-registry-apply] registry_skipped_existing_rows=${result.registrySkippedExistingRows}`);
  console.log(`[elv2-semantic-scope-target-registry-apply] registry_conflict_rows=${result.registryConflictRows}`);
  console.log(`[elv2-family-target-registry-apply] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
