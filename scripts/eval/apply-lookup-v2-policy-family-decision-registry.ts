import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import {
  buildLookupV2SemanticPolicyRegistryKey,
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  loadLookupV2SemanticPolicyRegistrySync,
  serializeLookupV2SemanticPolicyRegistryRows,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';

interface PolicyFamilyDecisionRegistryApplyResult {
  readonly mergedRows: readonly LookupV2SemanticPolicyRegistryRow[];
  readonly pendingRows: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly registryInsertedRows: number;
  readonly registrySkippedExistingRows: number;
  readonly registryConflictRows: number;
}

function isLookupV2PolicyFamilyReviewPacketRow(value: unknown): value is LookupV2PolicyFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    (typeof row['semanticConflictKey'] === 'string' || typeof row['policyConflictSurface'] === 'string')
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
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

function buildRegistryRow(
  row: LookupV2PolicyFamilyReviewPacketRow,
): LookupV2SemanticPolicyRegistryRow {
  if (row.reviewedAt === undefined || Number.isNaN(Date.parse(row.reviewedAt))) {
    throw new Error(`policy-family reviewed row is missing reviewedAt for surface=${JSON.stringify(row.policyConflictSurface)}`);
  }
  if (row.reviewedBy === undefined || row.reviewedBy.trim().length === 0) {
    throw new Error(`policy-family reviewed row is missing reviewedBy for surface=${JSON.stringify(row.policyConflictSurface)}`);
  }
  if (row.decisionReason === undefined || row.decisionReason.trim().length === 0) {
    throw new Error(`policy-family reviewed row is missing decisionReason for surface=${JSON.stringify(row.policyConflictSurface)}`);
  }
  const decision = row.proposalStatus === 'approved_exact_safe'
    ? 'promote_exact_safe'
    : row.proposalStatus === 'kept_ambiguous'
      ? 'keep_ambiguous'
      : 'needs_scope_target';
  return {
    semanticConflictKey: row.semanticConflictKey ?? row.policyConflictSurface,
    conflictClass: row.policyConflictType,
    entityId: row.benchmarkGoldEntityId,
    decision,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    decisionReason: row.decisionReason,
  };
}

function sameRegistryRow(
  left: LookupV2SemanticPolicyRegistryRow,
  right: LookupV2SemanticPolicyRegistryRow,
): boolean {
  return (
    left.semanticConflictKey === right.semanticConflictKey
    && left.entityId === right.entityId
    && left.decision === right.decision
  );
}

export function applyLookupV2PolicyFamilyDecisionRegistry(args: {
  readonly familyRows: readonly LookupV2PolicyFamilyReviewPacketRow[];
  readonly existingRegistryRows: readonly LookupV2SemanticPolicyRegistryRow[];
}): PolicyFamilyDecisionRegistryApplyResult {
  const mergedRows = args.existingRegistryRows.slice();
  const existingByKey = new Map(
    args.existingRegistryRows.map((row) => [
      buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.entityId),
      row,
    ] as const),
  );
  let pendingRows = 0;
  let approvedRows = 0;
  let rejectedRows = 0;
  let registryInsertedRows = 0;
  let registrySkippedExistingRows = 0;
  let registryConflictRows = 0;

  for (const row of args.familyRows) {
    if (row.proposalStatus === 'needs_policy_review') {
      pendingRows += 1;
      continue;
    }
    approvedRows += 1;
    const registryRow = buildRegistryRow(row);
    const key = buildLookupV2SemanticPolicyRegistryKey(registryRow.semanticConflictKey, registryRow.entityId);
    const existing = existingByKey.get(key);
    if (existing !== undefined) {
      if (sameRegistryRow(existing, registryRow)) {
        registrySkippedExistingRows += 1;
        continue;
      }
      registryConflictRows += 1;
      continue;
    }
    existingByKey.set(key, registryRow);
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
      input: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-semantic-policy-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-semantic-policy-registry-merged.jsonl';
  const familyRows = parsePacketJsonl(inputPath);
  const existingRegistryRows = loadLookupV2SemanticPolicyRegistrySync(registryPath);
  const result = applyLookupV2PolicyFamilyDecisionRegistry({
    familyRows,
    existingRegistryRows,
  });

  const targetPath = values.write ? registryPath : outputPath;
  if (values.write && result.registryConflictRows > 0) {
    throw new Error(`policy-family decision registry apply refused to write with registry_conflict_rows=${result.registryConflictRows}`);
  }
  writeFileSync(targetPath, serializeLookupV2SemanticPolicyRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-policy-family-decision-registry-apply] pending_rows=${result.pendingRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] approved_rows=${result.approvedRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] rejected_rows=${result.rejectedRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] registry_inserted_rows=${result.registryInsertedRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] registry_skipped_existing_rows=${result.registrySkippedExistingRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] registry_conflict_rows=${result.registryConflictRows}`);
  console.log(`[elv2-policy-family-decision-registry-apply] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
