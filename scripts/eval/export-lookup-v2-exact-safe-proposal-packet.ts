import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafePromotionClass, LookupExactSafeRegistryRow } from '../etl/lookup-exact-safe-registry.js';
import { loadLookupExactSafeRegistry } from '../etl/lookup-exact-safe-registry.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import {
  DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH,
  loadLookupV2ExactSafeScopeRegistryMapSync,
  type LookupV2ExactSafeScopeRegistryRow,
} from './lookup-v2-exact-safe-scope-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetApprovedMapSync,
  lookupV2SemanticScopeTargetRowAllowsDetachedVintageAuthority,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

export type LookupExactSafeProposalEntityIdSource =
  | 'fixture_exact'
  | 'semantic_scope_target_registry'
  | 'hint_resolution'
  | 'semantic_policy_registry'
  | 'policy_registry_authority'
  | 'runtime_identity_safe_alias'
  | 'manual_family_review_target';

export interface LookupExactSafeProposalCandidateRow {
  readonly surface: string;
  readonly entityId: string;
  readonly locale: 'ko' | 'global';
  readonly suggestedAliasType: LookupV2CurationDraftRow['suggestedAliasType'];
  readonly holeClass: string;
  readonly semanticScopeKey?: string | undefined;
  readonly benchmarkGoldHint?: string | undefined;
  readonly benchmarkGoldEntityIdSource: LookupExactSafeProposalEntityIdSource;
  readonly sourceArtifact: string;
  readonly sourceEvidence: string;
  readonly proposedAt: string;
}

export interface LookupExactSafeProposalPacketRow {
  readonly surface: string;
  readonly entityId: string;
  readonly candidatePromotionClass: LookupExactSafePromotionClass;
  readonly locale: 'ko' | 'global';
  readonly proposalStatus: 'needs_review' | 'approved' | 'rejected';
  readonly reviewTarget: 'lookup_exact_safe_registry_v1';
  readonly suggestedAliasType: LookupV2CurationDraftRow['suggestedAliasType'];
  readonly holeClass: string;
  readonly benchmarkGoldHint?: string | undefined;
  readonly benchmarkGoldEntityIdSource: LookupExactSafeProposalEntityIdSource;
  readonly sourceArtifact: string;
  readonly sourceEvidence: string;
  readonly proposedAt: string;
  readonly reviewedAt?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly decisionReason?: string | undefined;
}

function candidateRowPromotesExactSafeFromSemanticScopeTarget(args: {
  readonly row: LookupExactSafeProposalCandidateRow;
  readonly semanticScopeTargetApprovedMap?: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
}): boolean {
  if (args.row.benchmarkGoldEntityIdSource !== 'semantic_scope_target_registry') {
    return true;
  }
  if (args.row.semanticScopeKey === undefined || args.row.semanticScopeKey.trim().length === 0) {
    throw new Error(`semantic-scope-target exact-safe proposal is missing semanticScopeKey for surface=${JSON.stringify(args.row.surface)}`);
  }
  if (args.semanticScopeTargetApprovedMap === undefined) {
    throw new Error(`semantic-scope-target exact-safe proposal requires approved semantic scope target map for semanticScopeKey=${JSON.stringify(args.row.semanticScopeKey)}`);
  }
  const registryRow = args.semanticScopeTargetApprovedMap.get(args.row.semanticScopeKey);
  if (registryRow === undefined) {
    throw new Error(`semantic-scope-target exact-safe proposal has no approved semantic scope target for semanticScopeKey=${JSON.stringify(args.row.semanticScopeKey)}`);
  }
  if (registryRow.entityId !== args.row.entityId) {
    throw new Error(
      `semantic-scope-target exact-safe proposal entity mismatch for semanticScopeKey=${JSON.stringify(args.row.semanticScopeKey)} approved=${JSON.stringify(registryRow.entityId)} proposed=${JSON.stringify(args.row.entityId)}`,
    );
  }
  return !lookupV2SemanticScopeTargetRowAllowsDetachedVintageAuthority(registryRow);
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string' &&
    typeof row['locale'] === 'string' &&
    typeof row['suggestedAliasType'] === 'string' &&
    typeof row['holeClass'] === 'string' &&
    typeof row['observedStatus'] === 'string' &&
    typeof row['triageBucket'] === 'string' &&
    typeof row['sourceArtifact'] === 'string' &&
    typeof row['sourceEvidence'] === 'string' &&
    typeof row['reviewedAt'] === 'string'
  );
}

function parseDraftJsonl(filePath: string): readonly LookupV2CurationDraftRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2CurationDraftRow);
}

function buildExistingRegistryOwnerMap(
  rows: readonly LookupExactSafeRegistryRow[],
): ReadonlyMap<string, string> {
  const byNormalizedSurface = new Map<string, string>();
  for (const row of rows) {
    byNormalizedSurface.set(normalizeForMatch(row.surface), row.entityId);
  }
  return byNormalizedSurface;
}

function buildLookupV2ExactSafeReviewScopeKey(args: {
  readonly entityId: string;
  readonly holeClass: LookupExactSafeProposalCandidateRow['holeClass'];
  readonly suggestedAliasType: LookupExactSafeProposalCandidateRow['suggestedAliasType'];
}): string {
  return `${args.entityId}::${args.suggestedAliasType}::${args.holeClass}`;
}

export function applyLookupV2ExactSafeScopeRegistryToProposalPacketRows(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
  readonly exactSafeScopeRegistryMap: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
}): readonly LookupExactSafeProposalPacketRow[] {
  return args.packetRows.map((row) => {
    const registryRow = args.exactSafeScopeRegistryMap.get(buildLookupV2ExactSafeReviewScopeKey({
      entityId: row.entityId,
      holeClass: row.holeClass,
      suggestedAliasType: row.suggestedAliasType,
    }));
    if (registryRow === undefined) {
      return row;
    }
    return {
      ...row,
      proposalStatus: registryRow.decisionStatus === 'approved' ? 'approved' : 'rejected',
      reviewedAt: registryRow.reviewedAt,
      reviewedBy: registryRow.reviewedBy,
      decisionReason: registryRow.decisionReason,
    };
  });
}

export function buildLookupExactSafeProposalPacketRowsFromCandidates(args: {
  readonly candidateRows: readonly LookupExactSafeProposalCandidateRow[];
  readonly existingRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly exactSafeScopeRegistryMap?: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
  readonly semanticScopeTargetApprovedMap?: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
}): readonly LookupExactSafeProposalPacketRow[] {
  const existingOwnerByNormalizedSurface = buildExistingRegistryOwnerMap(args.existingRegistryRows ?? []);
  const packetRows: LookupExactSafeProposalPacketRow[] = [];
  const packetOwnerByNormalizedSurface = new Map<string, string>();

  for (const row of args.candidateRows) {
    if (!candidateRowPromotesExactSafeFromSemanticScopeTarget({
      row,
      semanticScopeTargetApprovedMap: args.semanticScopeTargetApprovedMap,
    })) {
      continue;
    }
    if (row.suggestedAliasType !== 'canonical' && row.suggestedAliasType !== 'translation') {
      throw new Error(
        `unsupported exact-safe proposal alias type=${JSON.stringify(row.suggestedAliasType)} for surface=${JSON.stringify(row.surface)}`,
      );
    }

    const normalizedSurface = normalizeForMatch(row.surface);
    if (normalizedSurface.length === 0) {
      throw new Error(`exact-safe proposal surface normalizes to empty: ${JSON.stringify(row.surface)}`);
    }

    const existingOwner = existingOwnerByNormalizedSurface.get(normalizedSurface);
    if (existingOwner !== undefined) {
      if (existingOwner !== row.entityId) {
        throw new Error(
          `exact-safe proposal conflicts with existing registry owner on surface=${JSON.stringify(row.surface)} existing=${existingOwner} proposed=${row.entityId}`,
        );
      }
      continue;
    }

    const packetOwner = packetOwnerByNormalizedSurface.get(normalizedSurface);
    if (packetOwner !== undefined) {
      if (packetOwner !== row.entityId) {
        throw new Error(
          `exact-safe proposal packet collision on surface=${JSON.stringify(row.surface)} between ${packetOwner} and ${row.entityId}`,
        );
      }
      continue;
    }
    packetOwnerByNormalizedSurface.set(normalizedSurface, row.entityId);

    packetRows.push({
      surface: row.surface,
      entityId: row.entityId,
      candidatePromotionClass: 'exact_safe',
      locale: row.locale,
      proposalStatus: 'needs_review',
      reviewTarget: 'lookup_exact_safe_registry_v1',
      suggestedAliasType: row.suggestedAliasType,
      holeClass: row.holeClass,
      ...(row.benchmarkGoldHint !== undefined ? { benchmarkGoldHint: row.benchmarkGoldHint } : {}),
      benchmarkGoldEntityIdSource: row.benchmarkGoldEntityIdSource,
      sourceArtifact: row.sourceArtifact,
      sourceEvidence: row.sourceEvidence,
      proposedAt: row.proposedAt,
    });
  }

  const sortedPacketRows = packetRows.sort((left, right) =>
    left.locale.localeCompare(right.locale)
    || left.surface.localeCompare(right.surface)
    || left.entityId.localeCompare(right.entityId),
  );
  if (args.exactSafeScopeRegistryMap === undefined || args.exactSafeScopeRegistryMap.size === 0) {
    return sortedPacketRows;
  }
  return applyLookupV2ExactSafeScopeRegistryToProposalPacketRows({
    packetRows: sortedPacketRows,
    exactSafeScopeRegistryMap: args.exactSafeScopeRegistryMap,
  });
}

export function buildLookupExactSafeProposalPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly existingRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly exactSafeScopeRegistryMap?: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
  readonly semanticScopeTargetApprovedMap?: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
}): readonly LookupExactSafeProposalPacketRow[] {
  const candidateRows: LookupExactSafeProposalCandidateRow[] = [];

  for (const row of args.draftRows) {
    if (row.triageBucket !== 'auto_targetable') {
      continue;
    }
    if (row.benchmarkGoldEntityId === undefined) {
      throw new Error(`auto_targetable draft row is missing benchmarkGoldEntityId for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.benchmarkGoldEntityIdSource === undefined) {
      throw new Error(`auto_targetable draft row is missing benchmarkGoldEntityIdSource for surface=${JSON.stringify(row.surface)}`);
    }
    candidateRows.push({
      surface: row.surface,
      entityId: row.benchmarkGoldEntityId,
      locale: row.locale,
      suggestedAliasType: row.suggestedAliasType,
      holeClass: row.holeClass,
      semanticScopeKey: row.semanticScopeKey,
      ...(row.benchmarkGoldHint !== undefined ? { benchmarkGoldHint: row.benchmarkGoldHint } : {}),
      benchmarkGoldEntityIdSource: row.benchmarkGoldEntityIdSource,
      sourceArtifact: row.sourceArtifact,
      sourceEvidence: row.sourceEvidence,
      proposedAt: row.reviewedAt,
    });
  }

  return buildLookupExactSafeProposalPacketRowsFromCandidates({
    candidateRows,
    existingRegistryRows: args.existingRegistryRows,
    exactSafeScopeRegistryMap: args.exactSafeScopeRegistryMap,
    semanticScopeTargetApprovedMap: args.semanticScopeTargetApprovedMap,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl') },
      output: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl') },
      registry: { type: 'string', default: undefined },
      exactSafeScopeRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH },
      semanticScopeTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
    },
    allowPositionals: false,
  });

  const inputPath = resolveCliDataPathArg(values.input ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl'));
  const outputPath = resolveCliDataPathArg(values.output ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl'));
  const draftRows = parseDraftJsonl(inputPath);
  const existingRegistryRows = await loadLookupExactSafeRegistry(values.registry);
  const exactSafeScopeRegistryPath = values.exactSafeScopeRegistry ?? DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH;
  const semanticScopeTargetRegistryPath =
    values.semanticScopeTargetRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const packetRows = buildLookupExactSafeProposalPacketRows({
    draftRows,
    existingRegistryRows,
    exactSafeScopeRegistryMap: loadLookupV2ExactSafeScopeRegistryMapSync(exactSafeScopeRegistryPath),
    semanticScopeTargetApprovedMap: loadLookupV2SemanticScopeTargetApprovedMapSync(semanticScopeTargetRegistryPath),
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    packetRows.map((row) => JSON.stringify(row)).join('\n') + (packetRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  const countsByClass = new Map<string, number>();
  for (const row of packetRows) {
    countsByClass.set(row.holeClass, (countsByClass.get(row.holeClass) ?? 0) + 1);
  }

  console.log(`[elv2-exact-safe-proposal-packet] input_rows=${draftRows.length}`);
  console.log(`[elv2-exact-safe-proposal-packet] packet_rows=${packetRows.length}`);
  console.log(`[elv2-exact-safe-proposal-packet] output=${outputPath}`);
  console.log(`[elv2-exact-safe-proposal-packet] counts_by_class=${JSON.stringify(Object.fromEntries([...countsByClass.entries()].sort((a, b) => a[0].localeCompare(b[0]))))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
