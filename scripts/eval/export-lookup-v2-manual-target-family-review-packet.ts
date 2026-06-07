import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type {
  LookupV2RuntimeSurfaceOwnerEvidence,
  LookupV2RuntimeSurfaceOwnerWitness,
} from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';
import {
  loadLookupV2RuntimeSemanticDescriptorMapSync,
  type LookupV2RuntimeSemanticDescriptor,
} from './lookup-v2-runtime-semantic-descriptors.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ManualTargetFamilyReviewPacketRow {
  readonly semanticScopeKey: string;
  readonly scopeAxis: LookupV2CurationDraftRow['scopeAxis'];
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
  readonly surfaceFormKind: LookupV2CurationDraftRow['surfaceFormKind'];
  readonly reviewScopeKey: string;
  readonly legacyReviewScopeKeys: readonly string[];
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly benchmarkGoldHintVariants: readonly string[];
  readonly proposalStatus: 'needs_target_review' | 'target_assigned' | 'rejected';
  readonly reviewTarget: 'lookup_manual_target_resolution_v1' | 'lookup_reviewed_collision_resolution_v1';
  readonly scopeHoleClass: LookupV2CurationDraftRow['holeClass'];
  readonly scopeSuggestedAliasType: LookupV2CurationDraftRow['suggestedAliasType'];
  readonly scopeRisk: 'family_only' | 'mixed_vintage_family';
  readonly locales: readonly LookupV2CurationDraftRow['locale'][];
  readonly surfaces: readonly string[];
  readonly holeClasses: readonly string[];
  readonly suggestedAliasTypes: readonly LookupV2CurationDraftRow['suggestedAliasType'][];
  readonly rowCount: number;
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly runtimeEvidenceStatus: 'candidate_unique_owner' | 'collision_candidates' | 'missing_runtime_owner';
  readonly runtimeEvidenceEntityId?: string | undefined;
  readonly runtimeEvidenceEntityLabel?: string | undefined;
  readonly runtimeEvidenceWitnesses?: readonly LookupV2RuntimeSurfaceOwnerWitness[] | undefined;
  readonly runtimeCollisionEntityIds?: readonly string[] | undefined;
  readonly runtimeCollisionEntityLabels?: readonly string[] | undefined;
  readonly runtimeCollisionWitnesses?: readonly LookupV2RuntimeSurfaceOwnerWitness[] | undefined;
  readonly proposedAt: string;
  readonly targetEntityId?: string | undefined;
  readonly reviewedAt?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly decisionReason?: string | undefined;
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

function parseDraftJsonl(filePath: string): readonly LookupV2CurationDraftRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2CurationDraftRow);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeBenchmarkHint(value: string): string {
  return normalizeForMatch(value);
}

function buildLegacyReviewScopeKey(row: LookupV2CurationDraftRow): string {
  if (row.benchmarkGoldHint === undefined || row.benchmarkGoldHint.trim().length === 0) {
    throw new Error(`manual_target draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
  }
  return `${normalizeBenchmarkHint(row.benchmarkGoldHint)}::${row.suggestedAliasType}::${row.holeClass}`;
}

function inferFamilyScopeRisk(rows: readonly LookupV2CurationDraftRow[]): LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'] {
  return rows.some((row) => row.vintage !== undefined)
    ? 'mixed_vintage_family'
    : 'family_only';
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function sameOptionalNumber(left: number | undefined, right: number | undefined): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function runtimeDescriptorMatchesScope(args: {
  readonly row: LookupV2CurationDraftRow;
  readonly descriptor: LookupV2RuntimeSemanticDescriptor | undefined;
}): boolean {
  const { row, descriptor } = args;
  if (descriptor === undefined) {
    return false;
  }
  return (
    descriptor.familyKey === row.familyKey
    && sameOptionalString(descriptor.lineKey, row.lineKey)
    && sameOptionalString(descriptor.regionKey, row.regionKey)
    && sameOptionalString(descriptor.appellationKey, row.appellationKey)
    && sameOptionalNumber(descriptor.vintage, row.vintage)
  );
}

function resolveRuntimeEvidenceStatus(args: {
  readonly exemplar: LookupV2CurationDraftRow;
  readonly familyScopeRisk: LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'];
  readonly uniqueOwner: string | undefined;
  readonly collidingOwners: readonly string[] | undefined;
  readonly runtimeDescriptorMap: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
}): LookupV2ManualTargetFamilyReviewPacketRow['runtimeEvidenceStatus'] {
  const { exemplar, familyScopeRisk, uniqueOwner, collidingOwners, runtimeDescriptorMap } = args;
  if (uniqueOwner !== undefined) {
    if (familyScopeRisk === 'family_only') {
      return runtimeDescriptorMatchesScope({
        row: exemplar,
        descriptor: runtimeDescriptorMap.get(uniqueOwner),
      })
        ? 'candidate_unique_owner'
        : 'missing_runtime_owner';
    }
    if (
      exemplar.scopeAxis === 'line'
      && exemplar.vintage !== undefined
      && runtimeDescriptorMatchesScope({
        row: exemplar,
        descriptor: runtimeDescriptorMap.get(uniqueOwner),
      })
    ) {
      return 'candidate_unique_owner';
    }
    return 'missing_runtime_owner';
  }
  if (collidingOwners !== undefined) {
    return 'collision_candidates';
  }
  return 'missing_runtime_owner';
}

function buildLookupV2FamilyTargetReviewPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly triageBucket: LookupV2CurationDraftRow['triageBucket'];
  readonly reviewTarget: LookupV2ManualTargetFamilyReviewPacketRow['reviewTarget'];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly runtimeDescriptorMap?: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
}): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const runtimeDescriptorMap = args.runtimeDescriptorMap ?? loadLookupV2RuntimeSemanticDescriptorMapSync();
  const familyRowsByHint = new Map<string, LookupV2CurationDraftRow[]>();
  const groups = new Map<string, LookupV2CurationDraftRow[]>();
  const hintVariantsByScope = new Map<string, Set<string>>();

  for (const row of args.draftRows) {
    if (row.triageBucket !== args.triageBucket) {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.benchmarkGoldHint.trim().length === 0) {
      throw new Error(`manual_target draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
    }
    const reviewScopeKey = row.semanticScopeKey;
    const normalizedHint = normalizeBenchmarkHint(row.benchmarkGoldHint);
    const hintVariants = hintVariantsByScope.get(reviewScopeKey) ?? new Set<string>();
    hintVariants.add(row.benchmarkGoldHint);
    hintVariantsByScope.set(reviewScopeKey, hintVariants);

    const familyRows = familyRowsByHint.get(normalizedHint);
    if (familyRows === undefined) {
      familyRowsByHint.set(normalizedHint, [row]);
    } else {
      familyRows.push(row);
    }

    const existing = groups.get(reviewScopeKey);
    if (existing === undefined) {
      groups.set(reviewScopeKey, [row]);
      continue;
    }
    existing.push(row);
  }

  return [...groups.entries()]
    .map(([reviewScopeKey, rows]) => {
      const exemplar = rows[0]!;
      const benchmarkGoldHintVariants = sortUnique([...(hintVariantsByScope.get(reviewScopeKey) ?? [])]);
      const benchmarkGoldHint = benchmarkGoldHintVariants[0];
      const holeClasses = sortUnique(rows.map((row) => row.holeClass));
      const suggestedAliasTypes = sortUnique(
        rows.map((row) => row.suggestedAliasType),
      ) as readonly LookupV2CurationDraftRow['suggestedAliasType'][];
      const scopeHoleClass = holeClasses[0];
      const scopeSuggestedAliasType = suggestedAliasTypes[0];
      if (benchmarkGoldHint === undefined) {
        throw new Error(`manual_target family review packet missing hint variant for reviewScopeKey=${reviewScopeKey}`);
      }
      const normalizedBenchmarkGoldHint = normalizeBenchmarkHint(benchmarkGoldHint);
      const legacyReviewScopeKeys = sortUnique(rows.map((row) => buildLegacyReviewScopeKey(row)));
      if (normalizedBenchmarkGoldHint.length === 0) {
        throw new Error(`manual_target family review packet missing normalized hint for reviewScopeKey=${reviewScopeKey}`);
      }
      if (legacyReviewScopeKeys.length === 0) {
        throw new Error(`manual_target family review packet missing legacy review scope keys for reviewScopeKey=${reviewScopeKey}`);
      }
      if (scopeHoleClass === undefined) {
        throw new Error(`manual_target family review packet missing hole classes for reviewScopeKey=${reviewScopeKey}`);
      }
      if (scopeSuggestedAliasType === undefined) {
        throw new Error(`manual_target family review packet missing suggested alias types for reviewScopeKey=${reviewScopeKey}`);
      }
      for (const row of rows) {
        if (
          row.scopeAxis !== exemplar.scopeAxis
          || row.familyKey !== exemplar.familyKey
          || !sameOptionalString(row.lineKey, exemplar.lineKey)
          || !sameOptionalString(row.regionKey, exemplar.regionKey)
          || !sameOptionalString(row.appellationKey, exemplar.appellationKey)
          || !sameOptionalNumber(row.vintage, exemplar.vintage)
          || row.surfaceFormKind !== exemplar.surfaceFormKind
          || row.locale !== exemplar.locale
        ) {
          throw new Error(`manual_target family semantic scope mismatch for reviewScopeKey=${reviewScopeKey}`);
        }
      }
      const familyScopeRisk = inferFamilyScopeRisk(familyRowsByHint.get(normalizedBenchmarkGoldHint) ?? rows);
      const uniqueOwner = runtimeOwnerEvidence.uniqueOwners.get(normalizedBenchmarkGoldHint);
      const collidingOwners = runtimeOwnerEvidence.collidingOwners.get(normalizedBenchmarkGoldHint);
      const uniqueOwnerWitnesses = runtimeOwnerEvidence.uniqueOwnerWitnesses.get(normalizedBenchmarkGoldHint);
      const collidingOwnerWitnesses = runtimeOwnerEvidence.collidingOwnerWitnesses.get(normalizedBenchmarkGoldHint);
      const runtimeEvidenceStatus = resolveRuntimeEvidenceStatus({
        exemplar,
        familyScopeRisk,
        uniqueOwner,
        collidingOwners,
        runtimeDescriptorMap,
      });
      const proposedAt = [...rows]
        .map((row) => row.reviewedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? rows[0]!.reviewedAt;
      return {
        semanticScopeKey: reviewScopeKey,
        scopeAxis: exemplar.scopeAxis,
        familyKey: exemplar.familyKey,
        ...(exemplar.lineKey !== undefined ? { lineKey: exemplar.lineKey } : {}),
        ...(exemplar.regionKey !== undefined ? { regionKey: exemplar.regionKey } : {}),
        ...(exemplar.appellationKey !== undefined ? { appellationKey: exemplar.appellationKey } : {}),
        ...(exemplar.vintage !== undefined ? { vintage: exemplar.vintage } : {}),
        surfaceFormKind: exemplar.surfaceFormKind,
        reviewScopeKey,
        legacyReviewScopeKeys,
        benchmarkGoldHint,
        normalizedBenchmarkGoldHint,
        benchmarkGoldHintVariants,
        proposalStatus: 'needs_target_review',
        reviewTarget: args.reviewTarget,
        scopeHoleClass,
        scopeSuggestedAliasType,
        scopeRisk: familyScopeRisk,
        locales: sortUnique(rows.map((row) => row.locale)) as readonly LookupV2CurationDraftRow['locale'][],
        surfaces: sortUnique(rows.map((row) => row.surface)),
        holeClasses,
        suggestedAliasTypes,
        rowCount: rows.length,
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        runtimeEvidenceStatus,
        ...(runtimeEvidenceStatus === 'candidate_unique_owner' && uniqueOwner !== undefined
          ? { runtimeEvidenceEntityId: uniqueOwner }
          : {}),
        ...(runtimeEvidenceStatus === 'candidate_unique_owner'
          && uniqueOwner !== undefined
          && runtimeOwnerEvidence.entityLabels.get(uniqueOwner) !== undefined
          ? { runtimeEvidenceEntityLabel: runtimeOwnerEvidence.entityLabels.get(uniqueOwner)! }
          : {}),
        ...(runtimeEvidenceStatus === 'candidate_unique_owner'
          && uniqueOwnerWitnesses !== undefined
          && uniqueOwnerWitnesses.length > 0
          ? { runtimeEvidenceWitnesses: uniqueOwnerWitnesses }
          : {}),
        ...(runtimeEvidenceStatus === 'collision_candidates' && collidingOwners !== undefined
          ? { runtimeCollisionEntityIds: collidingOwners }
          : {}),
        ...(runtimeEvidenceStatus === 'collision_candidates' && collidingOwners !== undefined
          ? {
              runtimeCollisionEntityLabels: collidingOwners.map((entityId) =>
                runtimeOwnerEvidence.entityLabels.get(entityId) ?? entityId,
              ),
            }
          : {}),
        ...(runtimeEvidenceStatus === 'collision_candidates'
          && collidingOwnerWitnesses !== undefined
          && collidingOwnerWitnesses.length > 0
          ? { runtimeCollisionWitnesses: collidingOwnerWitnesses }
          : {}),
        proposedAt,
      };
    })
    .sort((left, right) => left.reviewScopeKey.localeCompare(right.reviewScopeKey));
}

export function buildLookupV2ManualTargetFamilyReviewPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly runtimeDescriptorMap?: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
}): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  return buildLookupV2FamilyTargetReviewPacketRows({
    ...args,
    triageBucket: 'scope_target_review',
    reviewTarget: 'lookup_manual_target_resolution_v1',
  });
}

export function buildLookupV2ReviewedCollisionFamilyReviewPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly runtimeDescriptorMap?: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
}): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  return buildLookupV2FamilyTargetReviewPacketRows({
    ...args,
    triageBucket: 'reviewed_collision',
    reviewTarget: 'lookup_reviewed_collision_resolution_v1',
  });
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl');
  const draftRows = parseDraftJsonl(inputPath);
  const familyRows = buildLookupV2ManualTargetFamilyReviewPacketRows({ draftRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    familyRows.map((row) => JSON.stringify(row)).join('\n') + (familyRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-manual-target-family-review-packet] input_rows=${draftRows.filter((row) => row.triageBucket === 'scope_target_review').length}`);
  console.log(`[elv2-manual-target-family-review-packet] family_rows=${familyRows.length}`);
  console.log(`[elv2-manual-target-family-review-packet] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
