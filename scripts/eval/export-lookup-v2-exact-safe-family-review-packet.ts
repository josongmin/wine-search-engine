import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';
import type { LookupV2ExactSafeScopeRegistryRow } from './lookup-v2-exact-safe-scope-registry.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupExactSafeFamilyReviewPacketRow {
  readonly reviewScopeKey: string;
  readonly entityId: string;
  readonly locale: 'ko' | 'global';
  readonly candidatePromotionClass: LookupExactSafeProposalPacketRow['candidatePromotionClass'];
  readonly benchmarkGoldEntityIdSources: readonly LookupExactSafeProposalPacketRow['benchmarkGoldEntityIdSource'][];
  readonly proposalStatus: LookupExactSafeProposalPacketRow['proposalStatus'];
  readonly reviewTarget: LookupExactSafeProposalPacketRow['reviewTarget'];
  readonly scopeHoleClass: LookupExactSafeProposalPacketRow['holeClass'];
  readonly scopeSuggestedAliasType: LookupExactSafeProposalPacketRow['suggestedAliasType'];
  readonly surfaces: readonly string[];
  readonly benchmarkGoldHints: readonly string[];
  readonly rowCount: number;
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly proposedAt: string;
  readonly reviewedAt?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly decisionReason?: string | undefined;
}

function isLookupExactSafeProposalPacketRow(value: unknown): value is LookupExactSafeProposalPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['entityId'] === 'string'
    && typeof row['candidatePromotionClass'] === 'string'
    && typeof row['locale'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && typeof row['suggestedAliasType'] === 'string'
    && typeof row['holeClass'] === 'string'
    && typeof row['benchmarkGoldEntityIdSource'] === 'string'
    && typeof row['sourceArtifact'] === 'string'
    && typeof row['sourceEvidence'] === 'string'
    && typeof row['proposedAt'] === 'string'
  );
}

function parsePacketJsonl(filePath: string): readonly LookupExactSafeProposalPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupExactSafeProposalPacketRow);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function buildLookupV2ExactSafeReviewScopeKey(args: {
  readonly entityId: string;
  readonly holeClass: LookupExactSafeProposalPacketRow['holeClass'];
  readonly suggestedAliasType: LookupExactSafeProposalPacketRow['suggestedAliasType'];
}): string {
  return `${args.entityId}::${args.suggestedAliasType}::${args.holeClass}`;
}

export function buildLookupV2ExactSafeFamilyReviewPacketRows(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
}): readonly LookupExactSafeFamilyReviewPacketRow[] {
  const groups = new Map<string, LookupExactSafeProposalPacketRow[]>();

  for (const row of args.packetRows) {
    const groupKey = buildLookupV2ExactSafeReviewScopeKey({
      entityId: row.entityId,
      holeClass: row.holeClass,
      suggestedAliasType: row.suggestedAliasType,
    });
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, [row]);
      continue;
    }
    existing.push(row);
  }

  return [...groups.entries()]
    .map(([reviewScopeKey, rows]) => {
      const exemplar = rows[0]!;
      for (const row of rows) {
        if (
          row.locale !== exemplar.locale
          || row.candidatePromotionClass !== exemplar.candidatePromotionClass
          || row.reviewTarget !== exemplar.reviewTarget
          || row.holeClass !== exemplar.holeClass
          || row.suggestedAliasType !== exemplar.suggestedAliasType
        ) {
          throw new Error(`exact-safe family review packet invariant mismatch for reviewScopeKey=${reviewScopeKey}`);
        }
      }
      const proposalStatuses = sortUnique(rows.map((row) => row.proposalStatus));
      if (proposalStatuses.length !== 1) {
        throw new Error(`exact-safe family review packet status mismatch for reviewScopeKey=${reviewScopeKey}`);
      }
      const proposalStatus = proposalStatuses[0] as LookupExactSafeProposalPacketRow['proposalStatus'];
      const proposedAt = [...rows]
        .map((row) => row.proposedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? exemplar.proposedAt;
      const reviewedAts = sortUnique(
        rows
          .map((row) => row.reviewedAt)
          .filter((value): value is string => value !== undefined),
      );
      const reviewedBys = sortUnique(
        rows
          .map((row) => row.reviewedBy)
          .filter((value): value is string => value !== undefined),
      );
      const decisionReasons = sortUnique(
        rows
          .map((row) => row.decisionReason)
          .filter((value): value is string => value !== undefined),
      );
      if (proposalStatus !== 'needs_review') {
        if (reviewedAts.length !== 1 || reviewedBys.length !== 1 || decisionReasons.length !== 1) {
          throw new Error(`exact-safe family review packet reviewed metadata mismatch for reviewScopeKey=${reviewScopeKey}`);
        }
      }
      return {
        reviewScopeKey,
        entityId: exemplar.entityId,
        locale: exemplar.locale,
        candidatePromotionClass: exemplar.candidatePromotionClass,
        benchmarkGoldEntityIdSources: sortUnique(rows.map((row) => row.benchmarkGoldEntityIdSource)) as readonly LookupExactSafeProposalPacketRow['benchmarkGoldEntityIdSource'][],
        proposalStatus,
        reviewTarget: exemplar.reviewTarget,
        scopeHoleClass: exemplar.holeClass,
        scopeSuggestedAliasType: exemplar.suggestedAliasType,
        surfaces: sortUnique(rows.map((row) => row.surface)),
        benchmarkGoldHints: sortUnique(
          rows
            .map((row) => row.benchmarkGoldHint)
            .filter((value): value is string => value !== undefined),
        ),
        rowCount: rows.length,
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        proposedAt,
        ...(proposalStatus !== 'needs_review' ? { reviewedAt: reviewedAts[0]! } : {}),
        ...(proposalStatus !== 'needs_review' ? { reviewedBy: reviewedBys[0]! } : {}),
        ...(proposalStatus !== 'needs_review' ? { decisionReason: decisionReasons[0]! } : {}),
      };
    })
    .sort((left, right) => left.reviewScopeKey.localeCompare(right.reviewScopeKey));
}

export function applyLookupV2ExactSafeScopeRegistryToFamilyReviewPacketRows(args: {
  readonly familyRows: readonly LookupExactSafeFamilyReviewPacketRow[];
  readonly scopeRegistryMap: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
}): readonly LookupExactSafeFamilyReviewPacketRow[] {
  return args.familyRows.map((row) => {
    const registryRow = args.scopeRegistryMap.get(row.reviewScopeKey);
    if (registryRow === undefined) {
      return row;
    }
    return {
      ...row,
      proposalStatus: registryRow.decisionStatus === 'approved' ? 'approved' : 'rejected',
      reviewedBy: registryRow.reviewedBy,
      reviewedAt: registryRow.reviewedAt,
      decisionReason: registryRow.decisionReason,
    };
  });
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl') },
      output: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl') },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl'));
  const outputPath = resolveCliDataPathArg(values.output ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl'));
  const packetRows = parsePacketJsonl(inputPath);
  const familyRows = buildLookupV2ExactSafeFamilyReviewPacketRows({ packetRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    familyRows.map((row) => JSON.stringify(row)).join('\n') + (familyRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-exact-safe-family-review-packet] input_rows=${packetRows.length}`);
  console.log(`[elv2-exact-safe-family-review-packet] family_rows=${familyRows.length}`);
  console.log(`[elv2-exact-safe-family-review-packet] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
