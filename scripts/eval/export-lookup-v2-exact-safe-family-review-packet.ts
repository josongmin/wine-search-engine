import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';

export interface LookupExactSafeFamilyReviewPacketRow {
  readonly entityId: string;
  readonly locale: 'ko' | 'global';
  readonly candidatePromotionClass: LookupExactSafeProposalPacketRow['candidatePromotionClass'];
  readonly benchmarkGoldEntityIdSources: readonly LookupExactSafeProposalPacketRow['benchmarkGoldEntityIdSource'][];
  readonly proposalStatus: LookupExactSafeProposalPacketRow['proposalStatus'];
  readonly reviewTarget: LookupExactSafeProposalPacketRow['reviewTarget'];
  readonly surfaces: readonly string[];
  readonly benchmarkGoldHints: readonly string[];
  readonly holeClasses: readonly string[];
  readonly suggestedAliasTypes: readonly LookupExactSafeProposalPacketRow['suggestedAliasType'][];
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

export function buildLookupV2ExactSafeFamilyReviewPacketRows(args: {
  readonly packetRows: readonly LookupExactSafeProposalPacketRow[];
}): readonly LookupExactSafeFamilyReviewPacketRow[] {
  const groups = new Map<string, LookupExactSafeProposalPacketRow[]>();

  for (const row of args.packetRows) {
    if (row.proposalStatus !== 'needs_review') {
      throw new Error(`exact-safe family review packet expects pending row status, got=${row.proposalStatus} surface=${JSON.stringify(row.surface)}`);
    }
    const existing = groups.get(row.entityId);
    if (existing === undefined) {
      groups.set(row.entityId, [row]);
      continue;
    }
    existing.push(row);
  }

  return [...groups.entries()]
    .map(([entityId, rows]) => {
      const exemplar = rows[0]!;
      for (const row of rows) {
        if (
          row.locale !== exemplar.locale
          || row.candidatePromotionClass !== exemplar.candidatePromotionClass
          || row.reviewTarget !== exemplar.reviewTarget
        ) {
          throw new Error(`exact-safe family review packet invariant mismatch for entityId=${entityId}`);
        }
      }
      const proposedAt = [...rows]
        .map((row) => row.proposedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? exemplar.proposedAt;
      return {
        entityId,
        locale: exemplar.locale,
        candidatePromotionClass: exemplar.candidatePromotionClass,
        benchmarkGoldEntityIdSources: sortUnique(rows.map((row) => row.benchmarkGoldEntityIdSource)) as readonly LookupExactSafeProposalPacketRow['benchmarkGoldEntityIdSource'][],
        proposalStatus: 'needs_review',
        reviewTarget: exemplar.reviewTarget,
        surfaces: sortUnique(rows.map((row) => row.surface)),
        benchmarkGoldHints: sortUnique(
          rows
            .map((row) => row.benchmarkGoldHint)
            .filter((value): value is string => value !== undefined),
        ),
        holeClasses: sortUnique(rows.map((row) => row.holeClass)),
        suggestedAliasTypes: sortUnique(rows.map((row) => row.suggestedAliasType)) as readonly LookupExactSafeProposalPacketRow['suggestedAliasType'][],
        rowCount: rows.length,
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        proposedAt,
      };
    })
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl' },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl';
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
