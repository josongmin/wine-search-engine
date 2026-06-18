import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ManualTargetOwnerEvidenceFamilyClusterRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly benchmarkGoldHintVariants: readonly string[];
  readonly runtimeEvidenceStatus: LookupV2ManualTargetFamilyReviewPacketRow['runtimeEvidenceStatus'];
  readonly familyReviewRowCount: number;
  readonly reviewScopeKeys: readonly string[];
  readonly scopeHoleClasses: readonly string[];
  readonly scopeSuggestedAliasTypes: readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeSuggestedAliasType'][];
  readonly scopeRisks: readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'][];
  readonly locales: readonly string[];
  readonly surfaces: readonly string[];
  readonly rowCount: number;
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly runtimeEvidenceEntityId?: string | undefined;
  readonly runtimeEvidenceEntityLabel?: string | undefined;
  readonly runtimeEvidenceWitnesses?: readonly LookupV2ManualTargetFamilyReviewPacketRow['runtimeEvidenceWitnesses'] | undefined;
  readonly runtimeCollisionEntityIds?: readonly string[] | undefined;
  readonly runtimeCollisionEntityLabels?: readonly string[] | undefined;
  readonly runtimeCollisionWitnesses?: readonly LookupV2ManualTargetFamilyReviewPacketRow['runtimeCollisionWitnesses'] | undefined;
  readonly runtimeGapReasons?: readonly LookupV2ManualTargetFamilyReviewPacketRow['runtimeGapReason'][] | undefined;
  readonly runtimeGapReasonSignature?: string | undefined;
  readonly runtimeGapEntityIds?: readonly string[] | undefined;
  readonly runtimeGapEntityLabels?: readonly string[] | undefined;
  readonly runtimeGapAvailableVintages?: readonly number[] | undefined;
  readonly runtimeGapAvailableLineKeys?: readonly string[] | undefined;
  readonly runtimeGapAvailableRegionKeys?: readonly string[] | undefined;
  readonly runtimeGapAvailableAppellationKeys?: readonly string[] | undefined;
  readonly runtimeClarificationAxes?: readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeClarificationAxes']>[number][] | undefined;
}

export interface LookupV2ManualTargetOwnerEvidenceFamilyClusterIndex {
  readonly sourcePacketPath: string;
  readonly generatedAt: string;
  readonly totalFamilies: number;
  readonly totalScopeRows: number;
  readonly candidateUniqueOwnerFamilies: number;
  readonly collisionCandidateFamilies: number;
  readonly missingRuntimeOwnerFamilies: number;
  readonly outputPaths: {
    readonly candidateUniqueOwnerFamilies: string;
    readonly collisionCandidateFamilies: string;
    readonly missingRuntimeOwnerFamilies: string;
    readonly gapReasonDir: string;
    readonly gapReasonIndexPath: string;
  };
  readonly gapReasonSignatureCounts: Readonly<Record<string, number>>;
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
    && typeof row['runtimeEvidenceStatus'] === 'string'
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

function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortUniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function buildGapReasonSignature(
  reasons: readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeGapReason']>[],
): string {
  return reasons.join('+');
}

function buildGapReasonFileStem(signature: string): string {
  return signature
    .replaceAll('+', '__')
    .replaceAll('_', '-');
}

function buildClusterRows(
  packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[],
): readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[] {
  const groups = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow[]>();
  for (const row of packetRows) {
    const existing = groups.get(row.normalizedBenchmarkGoldHint) ?? [];
    existing.push(row);
    groups.set(row.normalizedBenchmarkGoldHint, existing);
  }

  return [...groups.entries()]
    .map(([normalizedBenchmarkGoldHint, rows]) => {
      const exemplar = rows[0]!;
      for (const row of rows) {
        if (row.runtimeEvidenceStatus !== exemplar.runtimeEvidenceStatus) {
          throw new Error(`manual-target owner family cluster invariant mismatch for benchmarkGoldHint=${JSON.stringify(exemplar.benchmarkGoldHint)}`);
        }
      }
      return {
        benchmarkGoldHint: exemplar.benchmarkGoldHint,
        normalizedBenchmarkGoldHint,
        benchmarkGoldHintVariants: sortUnique(rows.flatMap((row) => row.benchmarkGoldHintVariants)),
        runtimeEvidenceStatus: exemplar.runtimeEvidenceStatus,
        familyReviewRowCount: rows.length,
        reviewScopeKeys: sortUnique(rows.map((row) => row.reviewScopeKey)),
        scopeHoleClasses: sortUnique(rows.map((row) => row.scopeHoleClass)),
        scopeSuggestedAliasTypes: sortUnique(rows.map((row) => row.scopeSuggestedAliasType)) as readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeSuggestedAliasType'][],
        scopeRisks: sortUnique(rows.map((row) => row.scopeRisk)) as readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'][],
        locales: sortUnique(rows.flatMap((row) => row.locales)),
        surfaces: sortUnique(rows.flatMap((row) => row.surfaces)),
        rowCount: rows.reduce((sum, row) => sum + row.rowCount, 0),
        sourceArtifacts: sortUnique(rows.flatMap((row) => row.sourceArtifacts)),
        sourceEvidenceSamples: sortUnique(rows.flatMap((row) => row.sourceEvidenceSamples)),
        ...(exemplar.runtimeEvidenceEntityId !== undefined ? { runtimeEvidenceEntityId: exemplar.runtimeEvidenceEntityId } : {}),
        ...(exemplar.runtimeEvidenceEntityLabel !== undefined ? { runtimeEvidenceEntityLabel: exemplar.runtimeEvidenceEntityLabel } : {}),
        ...(exemplar.runtimeEvidenceWitnesses !== undefined ? { runtimeEvidenceWitnesses: exemplar.runtimeEvidenceWitnesses } : {}),
        ...(exemplar.runtimeCollisionEntityIds !== undefined ? { runtimeCollisionEntityIds: exemplar.runtimeCollisionEntityIds } : {}),
        ...(exemplar.runtimeCollisionEntityLabels !== undefined ? { runtimeCollisionEntityLabels: exemplar.runtimeCollisionEntityLabels } : {}),
        ...(exemplar.runtimeCollisionWitnesses !== undefined ? { runtimeCollisionWitnesses: exemplar.runtimeCollisionWitnesses } : {}),
        ...(rows.some((row) => row.runtimeGapReason !== undefined)
          ? {
              runtimeGapReasons: sortUnique(
                rows
                  .map((row) => row.runtimeGapReason)
                  .filter((value): value is string => value !== undefined),
              ) as readonly LookupV2ManualTargetFamilyReviewPacketRow['runtimeGapReason'][],
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapEntityIds !== undefined && row.runtimeGapEntityIds.length > 0)
          ? {
              runtimeGapEntityIds: sortUnique(
                rows.flatMap((row) => row.runtimeGapEntityIds ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapEntityLabels !== undefined && row.runtimeGapEntityLabels.length > 0)
          ? {
              runtimeGapEntityLabels: sortUnique(
                rows.flatMap((row) => row.runtimeGapEntityLabels ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapAvailableVintages !== undefined && row.runtimeGapAvailableVintages.length > 0)
          ? {
              runtimeGapAvailableVintages: sortUniqueNumbers(
                rows.flatMap((row) => row.runtimeGapAvailableVintages ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapAvailableLineKeys !== undefined && row.runtimeGapAvailableLineKeys.length > 0)
          ? {
              runtimeGapAvailableLineKeys: sortUnique(
                rows.flatMap((row) => row.runtimeGapAvailableLineKeys ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapAvailableRegionKeys !== undefined && row.runtimeGapAvailableRegionKeys.length > 0)
          ? {
              runtimeGapAvailableRegionKeys: sortUnique(
                rows.flatMap((row) => row.runtimeGapAvailableRegionKeys ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeGapAvailableAppellationKeys !== undefined && row.runtimeGapAvailableAppellationKeys.length > 0)
          ? {
              runtimeGapAvailableAppellationKeys: sortUnique(
                rows.flatMap((row) => row.runtimeGapAvailableAppellationKeys ?? []),
              ),
            }
          : {}),
        ...(rows.some((row) => row.runtimeClarificationAxes !== undefined && row.runtimeClarificationAxes.length > 0)
          ? {
              runtimeClarificationAxes: sortUnique(
                rows.flatMap((row) => row.runtimeClarificationAxes ?? []),
              ) as readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeClarificationAxes']>[number][],
            }
          : {}),
      };
    })
    .map((row) => ({
      ...row,
      ...(row.runtimeGapReasons !== undefined && row.runtimeGapReasons.length > 0
        ? {
            runtimeGapReasonSignature: buildGapReasonSignature(
              row.runtimeGapReasons as readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeGapReason']>[],
            ),
          }
        : {}),
    }))
    .sort((left, right) => left.normalizedBenchmarkGoldHint.localeCompare(right.normalizedBenchmarkGoldHint));
}

export function writeLookupV2ManualTargetOwnerFamilyClusters(args: {
  readonly packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly sourcePacketPath: string;
  readonly outputDir: string;
  readonly generatedAt: string;
}): LookupV2ManualTargetOwnerEvidenceFamilyClusterIndex {
  const clusterRows = buildClusterRows(args.packetRows);
  const candidateUniqueOwnerFamilies = clusterRows.filter((row) => row.runtimeEvidenceStatus === 'candidate_unique_owner');
  const collisionCandidateFamilies = clusterRows.filter((row) => row.runtimeEvidenceStatus === 'collision_candidates');
  const missingRuntimeOwnerFamilies = clusterRows.filter((row) => row.runtimeEvidenceStatus === 'missing_runtime_owner');

  mkdirSync(args.outputDir, { recursive: true });
  const outputPaths = {
    candidateUniqueOwnerFamilies: path.join(args.outputDir, 'candidate-unique-owner-families.jsonl'),
    collisionCandidateFamilies: path.join(args.outputDir, 'collision-candidate-families.jsonl'),
    missingRuntimeOwnerFamilies: path.join(args.outputDir, 'missing-runtime-owner-families.jsonl'),
    gapReasonDir: path.join(args.outputDir, 'missing-runtime-owner-families-by-gap-reason'),
    gapReasonIndexPath: path.join(args.outputDir, 'missing-runtime-owner-families-by-gap-reason', 'gap-reason-index.json'),
  };

  writeFileSync(outputPaths.candidateUniqueOwnerFamilies, serializeJsonl(candidateUniqueOwnerFamilies), 'utf8');
  writeFileSync(outputPaths.collisionCandidateFamilies, serializeJsonl(collisionCandidateFamilies), 'utf8');
  writeFileSync(outputPaths.missingRuntimeOwnerFamilies, serializeJsonl(missingRuntimeOwnerFamilies), 'utf8');

  mkdirSync(outputPaths.gapReasonDir, { recursive: true });
  const gapReasonGroups = new Map<string, LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[]>();
  for (const row of missingRuntimeOwnerFamilies) {
    const signature = row.runtimeGapReasonSignature ?? 'unknown';
    const existing = gapReasonGroups.get(signature) ?? [];
    existing.push(row);
    gapReasonGroups.set(signature, existing);
  }
  const gapReasonSignatureCounts = Object.fromEntries(
    [...gapReasonGroups.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([signature, rows]) => [signature, rows.length]),
  ) as Readonly<Record<string, number>>;
  for (const [signature, rows] of gapReasonGroups.entries()) {
    writeFileSync(
      path.join(outputPaths.gapReasonDir, `${buildGapReasonFileStem(signature)}.jsonl`),
      serializeJsonl(rows),
      'utf8',
    );
  }
  writeFileSync(
    outputPaths.gapReasonIndexPath,
    JSON.stringify({
      sourcePacketPath: args.sourcePacketPath,
      generatedAt: args.generatedAt,
      totalFamilies: missingRuntimeOwnerFamilies.length,
      gapReasonSignatureCounts,
    }, null, 2) + '\n',
    'utf8',
  );

  const index: LookupV2ManualTargetOwnerEvidenceFamilyClusterIndex = {
    sourcePacketPath: args.sourcePacketPath,
    generatedAt: args.generatedAt,
    totalFamilies: clusterRows.length,
    totalScopeRows: args.packetRows.length,
    candidateUniqueOwnerFamilies: candidateUniqueOwnerFamilies.length,
    collisionCandidateFamilies: collisionCandidateFamilies.length,
    missingRuntimeOwnerFamilies: missingRuntimeOwnerFamilies.length,
    outputPaths,
    gapReasonSignatureCounts,
  };
  writeFileSync(path.join(args.outputDir, 'family-index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  return index;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl') },
      outputDir: { type: 'string', default: lookupV2DraftCliPath('manual-target-owner-evidence') },
      generatedAt: { type: 'string', default: new Date().toISOString() },
    },
  });

  const inputPath = resolveCliDataPathArg(
    values.input ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl'),
  );
  const outputDir = resolveCliDataPathArg(values.outputDir ?? lookupV2DraftCliPath('manual-target-owner-evidence'));
  const generatedAt = values.generatedAt ?? new Date().toISOString();
  const packetRows = parsePacketJsonl(inputPath);
  const index = writeLookupV2ManualTargetOwnerFamilyClusters({
    packetRows,
    sourcePacketPath: inputPath,
    outputDir,
    generatedAt,
  });

  console.log(`[elv2-manual-target-owner-family-clusters] total_families=${index.totalFamilies}`);
  console.log(`[elv2-manual-target-owner-family-clusters] candidate_unique_owner_families=${index.candidateUniqueOwnerFamilies}`);
  console.log(`[elv2-manual-target-owner-family-clusters] collision_candidate_families=${index.collisionCandidateFamilies}`);
  console.log(`[elv2-manual-target-owner-family-clusters] missing_runtime_owner_families=${index.missingRuntimeOwnerFamilies}`);
  console.log(`[elv2-manual-target-owner-family-clusters] output_dir=${outputDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
