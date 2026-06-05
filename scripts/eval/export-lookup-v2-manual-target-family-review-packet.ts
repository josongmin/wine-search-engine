import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';

export interface LookupV2ManualTargetFamilyReviewPacketRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly benchmarkGoldHintVariants: readonly string[];
  readonly proposalStatus: 'needs_target_review' | 'target_assigned' | 'rejected';
  readonly reviewTarget: 'lookup_manual_target_resolution_v1';
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
  readonly runtimeCollisionEntityIds?: readonly string[] | undefined;
  readonly runtimeCollisionEntityLabels?: readonly string[] | undefined;
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

export function buildLookupV2ManualTargetFamilyReviewPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
}): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const groups = new Map<string, LookupV2CurationDraftRow[]>();
  const hintVariantsByNormalized = new Map<string, Set<string>>();

  for (const row of args.draftRows) {
    if (row.triageBucket !== 'manual_target') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.benchmarkGoldHint.trim().length === 0) {
      throw new Error(`manual_target draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
    }
    const normalizedHint = normalizeForMatch(row.benchmarkGoldHint);
    if (normalizedHint.length === 0) {
      throw new Error(`manual_target benchmarkGoldHint normalizes to empty for surface=${JSON.stringify(row.surface)}`);
    }
    const hintVariants = hintVariantsByNormalized.get(normalizedHint) ?? new Set<string>();
    hintVariants.add(row.benchmarkGoldHint);
    hintVariantsByNormalized.set(normalizedHint, hintVariants);

    const existing = groups.get(normalizedHint);
    if (existing === undefined) {
      groups.set(normalizedHint, [row]);
      continue;
    }
    existing.push(row);
  }

  return [...groups.entries()]
    .map(([normalizedBenchmarkGoldHint, rows]) => {
      const benchmarkGoldHintVariants = sortUnique([...(hintVariantsByNormalized.get(normalizedBenchmarkGoldHint) ?? [])]);
      const benchmarkGoldHint = benchmarkGoldHintVariants[0];
      if (benchmarkGoldHint === undefined) {
        throw new Error(`manual_target family review packet missing hint variant for normalized hint=${normalizedBenchmarkGoldHint}`);
      }
      const uniqueOwner = runtimeOwnerEvidence.uniqueOwners.get(normalizedBenchmarkGoldHint);
      const collidingOwners = runtimeOwnerEvidence.collidingOwners.get(normalizedBenchmarkGoldHint);
      const proposedAt = [...rows]
        .map((row) => row.reviewedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? rows[0]!.reviewedAt;
      return {
        benchmarkGoldHint,
        normalizedBenchmarkGoldHint,
        benchmarkGoldHintVariants,
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        locales: sortUnique(rows.map((row) => row.locale)) as readonly LookupV2CurationDraftRow['locale'][],
        surfaces: sortUnique(rows.map((row) => row.surface)),
        holeClasses: sortUnique(rows.map((row) => row.holeClass)),
        suggestedAliasTypes: sortUnique(rows.map((row) => row.suggestedAliasType)) as readonly LookupV2CurationDraftRow['suggestedAliasType'][],
        rowCount: rows.length,
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        runtimeEvidenceStatus: uniqueOwner !== undefined
          ? 'candidate_unique_owner'
          : collidingOwners !== undefined
            ? 'collision_candidates'
            : 'missing_runtime_owner',
        ...(uniqueOwner !== undefined ? { runtimeEvidenceEntityId: uniqueOwner } : {}),
        ...(uniqueOwner !== undefined && runtimeOwnerEvidence.entityLabels.get(uniqueOwner) !== undefined
          ? { runtimeEvidenceEntityLabel: runtimeOwnerEvidence.entityLabels.get(uniqueOwner)! }
          : {}),
        ...(collidingOwners !== undefined ? { runtimeCollisionEntityIds: collidingOwners } : {}),
        ...(collidingOwners !== undefined
          ? {
              runtimeCollisionEntityLabels: collidingOwners.map((entityId) =>
                runtimeOwnerEvidence.entityLabels.get(entityId) ?? entityId,
              ),
            }
          : {}),
        proposedAt,
      };
    })
    .sort((left, right) => left.normalizedBenchmarkGoldHint.localeCompare(right.normalizedBenchmarkGoldHint));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl';
  const draftRows = parseDraftJsonl(inputPath);
  const familyRows = buildLookupV2ManualTargetFamilyReviewPacketRows({ draftRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    familyRows.map((row) => JSON.stringify(row)).join('\n') + (familyRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-manual-target-family-review-packet] input_rows=${draftRows.filter((row) => row.triageBucket === 'manual_target').length}`);
  console.log(`[elv2-manual-target-family-review-packet] family_rows=${familyRows.length}`);
  console.log(`[elv2-manual-target-family-review-packet] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
