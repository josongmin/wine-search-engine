import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildLookupExactSafeProposalPacketRowsFromCandidates,
  type LookupExactSafeProposalCandidateRow,
  type LookupExactSafeProposalPacketRow,
} from './export-lookup-v2-exact-safe-proposal-packet.js';
import { loadLookupExactSafeRegistry } from '../etl/lookup-exact-safe-registry.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetRegistrySync,
  type LookupV2FamilyTargetRegistryRow,
} from './lookup-v2-family-target-registry.js';

interface ManualTargetFamilyApplyResult {
  readonly exactSafePacketRows: readonly LookupExactSafeProposalPacketRow[];
  readonly targetAssignedFamilies: number;
  readonly rejectedFamilies: number;
  readonly pendingFamilies: number;
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['locale'] === 'string'
    && typeof row['suggestedAliasType'] === 'string'
    && typeof row['holeClass'] === 'string'
    && typeof row['triageBucket'] === 'string'
    && typeof row['sourceArtifact'] === 'string'
    && typeof row['sourceEvidence'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
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

function buildExactSafePacketSourceEvidence(
  row: LookupV2CurationDraftRow,
  registryRow: LookupV2FamilyTargetRegistryRow,
  registryPath: string,
): string {
  const registryName = path.basename(registryPath);
  return `${row.sourceEvidence} [family_target_registry=${registryName} benchmark_gold_hint=${registryRow.benchmarkGoldHint} reviewedBy=${registryRow.reviewedBy} decision=${registryRow.decisionReason}]`;
}

export function applyLookupV2ManualTargetFamilyReviewPacket(args: {
  readonly familyRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly familyTargetRegistryRows: readonly LookupV2FamilyTargetRegistryRow[];
  readonly familyTargetRegistryPath: string;
  readonly existingRegistryRows?: readonly Awaited<ReturnType<typeof loadLookupExactSafeRegistry>>;
}): ManualTargetFamilyApplyResult {
  const familyByHint = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow>();
  const familyTargetRegistryByHint = new Map(
    args.familyTargetRegistryRows.map((row) => [normalizeForMatch(row.benchmarkGoldHint), row] as const),
  );
  let targetAssignedFamilies = 0;
  let rejectedFamilies = 0;
  let pendingFamilies = 0;

  for (const row of args.familyRows) {
    const key = normalizeForMatch(row.benchmarkGoldHint);
    if (familyByHint.has(key)) {
      throw new Error(`duplicate manual-target family review row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    familyByHint.set(key, row);
    if (row.proposalStatus === 'target_assigned') {
      if (row.targetEntityId === undefined || row.targetEntityId.trim().length === 0) {
        throw new Error(`target_assigned manual-target family row is missing targetEntityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      const registryRow = familyTargetRegistryByHint.get(key);
      if (registryRow === undefined) {
        throw new Error(`target_assigned manual-target family row has no family-target registry row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      if (registryRow.decisionStatus !== 'approved' || registryRow.entityId !== row.targetEntityId) {
        throw new Error(`target_assigned manual-target family row does not match reviewed family-target registry for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      targetAssignedFamilies += 1;
      continue;
    }
    if (row.proposalStatus === 'rejected') {
      const registryRow = familyTargetRegistryByHint.get(key);
      if (registryRow === undefined) {
        throw new Error(`rejected manual-target family row has no family-target registry row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      if (registryRow.decisionStatus !== 'rejected') {
        throw new Error(`rejected manual-target family row does not match reviewed family-target registry for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      rejectedFamilies += 1;
      continue;
    }
    pendingFamilies += 1;
  }

  const candidateRows: LookupExactSafeProposalCandidateRow[] = [];
  for (const row of args.draftRows) {
    if (row.triageBucket !== 'manual_target') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.benchmarkGoldHint.trim().length === 0) {
      throw new Error(`manual_target draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
    }
    const normalizedHint = normalizeForMatch(row.benchmarkGoldHint);
    const family = familyByHint.get(normalizedHint);
    if (family === undefined) {
      throw new Error(`manual_target draft row has no family review row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    const registryRow = familyTargetRegistryByHint.get(normalizedHint);
    if (family.proposalStatus === 'target_assigned' && registryRow === undefined) {
      throw new Error(`manual_target draft row has target_assigned family without reviewed family-target registry for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    if (registryRow?.decisionStatus !== 'approved' || registryRow.entityId === undefined) {
      continue;
    }
    candidateRows.push({
      surface: row.surface,
      entityId: registryRow.entityId,
      locale: row.locale,
      suggestedAliasType: row.suggestedAliasType,
      holeClass: row.holeClass,
      benchmarkGoldHint: row.benchmarkGoldHint,
      benchmarkGoldEntityIdSource: 'family_target_registry',
      sourceArtifact: row.sourceArtifact,
      sourceEvidence: buildExactSafePacketSourceEvidence(row, registryRow, args.familyTargetRegistryPath),
      proposedAt: registryRow.reviewedAt,
    });
  }

  return {
    exactSafePacketRows: buildLookupExactSafeProposalPacketRowsFromCandidates({
      candidateRows,
      existingRegistryRows: args.existingRegistryRows,
    }),
    targetAssignedFamilies,
    rejectedFamilies,
    pendingFamilies,
  };
}

function serializeRows(rows: readonly LookupExactSafeProposalPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      families: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl' },
      draft: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      familyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      registry: { type: 'string', default: undefined },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-approved-exact-safe-packet.jsonl' },
    },
  });

  const familiesPath = values.families ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const draftPath = values.draft ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl';
  const familyRegistryPath = values.familyRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-approved-exact-safe-packet.jsonl';
  const familyRows = parsePacketJsonl(familiesPath, isLookupV2ManualTargetFamilyReviewPacketRow);
  const draftRows = parsePacketJsonl(draftPath, isLookupV2CurationDraftRow);
  const familyTargetRegistryRows = loadLookupV2FamilyTargetRegistrySync(familyRegistryPath);
  const existingRegistryRows = await loadLookupExactSafeRegistry(values.registry);
  const result = applyLookupV2ManualTargetFamilyReviewPacket({
    familyRows,
    draftRows,
    familyTargetRegistryRows,
    familyTargetRegistryPath: familyRegistryPath,
    existingRegistryRows,
  });

  writeFileSync(outputPath, serializeRows(result.exactSafePacketRows), 'utf8');
  console.log(`[elv2-manual-target-family-apply] family_rows=${familyRows.length}`);
  console.log(`[elv2-manual-target-family-apply] target_assigned_families=${result.targetAssignedFamilies}`);
  console.log(`[elv2-manual-target-family-apply] rejected_families=${result.rejectedFamilies}`);
  console.log(`[elv2-manual-target-family-apply] pending_families=${result.pendingFamilies}`);
  console.log(`[elv2-manual-target-family-apply] exact_safe_packet_rows=${result.exactSafePacketRows.length}`);
  console.log(`[elv2-manual-target-family-apply] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
