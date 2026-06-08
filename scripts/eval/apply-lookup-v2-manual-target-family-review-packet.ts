import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildLookupExactSafeProposalPacketRowsFromCandidates,
  type LookupExactSafeProposalCandidateRow,
  type LookupExactSafeProposalPacketRow,
} from './export-lookup-v2-exact-safe-proposal-packet.js';
import { loadLookupExactSafeRegistry } from '../etl/lookup-exact-safe-registry.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetRegistrySync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

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
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
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
  registryRow: LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string },
  registryPath: string,
): string {
  const registryName = path.basename(registryPath);
  return `${row.sourceEvidence} [semantic_scope_target_registry=${registryName} semantic_scope=${registryRow.semanticScopeKey} reviewedBy=${registryRow.reviewedBy} decision=${registryRow.decisionReason}]`;
}

export function applyLookupV2ManualTargetFamilyReviewPacket(args: {
  readonly familyRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly familyTargetRegistryRows: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly familyTargetRegistryPath: string;
  readonly existingRegistryRows?: readonly Awaited<ReturnType<typeof loadLookupExactSafeRegistry>>;
}): ManualTargetFamilyApplyResult {
  const familyByScope = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow>();
  const familyTargetRegistryByScope = new Map(
    args.familyTargetRegistryRows
      .map((row) => [
        row.semanticScopeKey
        ?? (row as LookupV2SemanticScopeTargetRegistryRow & { readonly reviewScopeKey?: string }).reviewScopeKey,
        row,
      ] as const)
      .filter((entry): entry is readonly [string, LookupV2SemanticScopeTargetRegistryRow] => typeof entry[0] === 'string'),
  );
  let targetAssignedFamilies = 0;
  let rejectedFamilies = 0;
  let pendingFamilies = 0;

  for (const row of args.familyRows) {
    const key = row.semanticScopeKey ?? row.reviewScopeKey;
    if (familyByScope.has(key)) {
      throw new Error(`duplicate manual-target family review row for semanticScopeKey=${JSON.stringify(key)}`);
    }
    familyByScope.set(key, row);
    if (row.proposalStatus === 'target_assigned') {
      if (row.targetEntityId === undefined || row.targetEntityId.trim().length === 0) {
        throw new Error(`target_assigned manual-target family row is missing targetEntityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      const registryRow = familyTargetRegistryByScope.get(key);
      if (registryRow === undefined) {
        throw new Error(`target_assigned manual-target family row has no semantic target registry row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      if (registryRow.decisionStatus !== 'approved' || registryRow.entityId !== row.targetEntityId) {
        throw new Error(`target_assigned manual-target family row does not match reviewed semantic target registry for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      targetAssignedFamilies += 1;
      continue;
    }
    if (row.proposalStatus === 'rejected') {
      const registryRow = familyTargetRegistryByScope.get(key);
      if (registryRow === undefined) {
        throw new Error(`rejected manual-target family row has no semantic target registry row for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      if (registryRow.decisionStatus !== 'rejected') {
        throw new Error(`rejected manual-target family row does not match reviewed semantic target registry for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
      }
      rejectedFamilies += 1;
      continue;
    }
    pendingFamilies += 1;
  }

  const candidateRows: LookupExactSafeProposalCandidateRow[] = [];
  for (const row of args.draftRows) {
    if (row.triageBucket !== 'scope_target_review') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.benchmarkGoldHint.trim().length === 0) {
      throw new Error(`scope_target_review draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
    }
    const reviewScopeKey = row.semanticScopeKey;
    const family = familyByScope.get(reviewScopeKey);
    if (family === undefined) {
      throw new Error(`scope_target_review draft row has no family review row for semanticScopeKey=${JSON.stringify(reviewScopeKey)}`);
    }
    const registryRow = familyTargetRegistryByScope.get(reviewScopeKey);
    if (family.proposalStatus === 'target_assigned' && registryRow === undefined) {
      throw new Error(`scope_target_review draft row has target_assigned family without reviewed semantic target registry for semanticScopeKey=${JSON.stringify(reviewScopeKey)}`);
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
      benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
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
      draft: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl') },
      familyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      registry: { type: 'string', default: undefined },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-approved-exact-safe-packet.jsonl' },
    },
  });

  const familiesPath = values.families ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const draftPath = resolveCliDataPathArg(
    values.draft ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl'),
  );
  const familyRegistryPath = values.familyRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-approved-exact-safe-packet.jsonl';
  const familyRows = parsePacketJsonl(familiesPath, isLookupV2ManualTargetFamilyReviewPacketRow);
  const draftRows = parsePacketJsonl(draftPath, isLookupV2CurationDraftRow);
  const familyTargetRegistryRows = loadLookupV2SemanticScopeTargetRegistrySync(familyRegistryPath);
  const existingRegistryRows = await loadLookupExactSafeRegistry(values.registry);
  const result = applyLookupV2ManualTargetFamilyReviewPacket({
    familyRows,
    draftRows,
    familyTargetRegistryRows,
    familyTargetRegistryPath: familyRegistryPath,
    existingRegistryRows,
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
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
