import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2PolicyReviewPacketRow } from './export-lookup-v2-policy-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2PolicyFamilyReviewPacketRow {
  readonly semanticConflictKey: string;
  readonly policyConflictSurface: string;
  readonly locale: 'ko' | 'global';
  readonly policyConflictType: LookupV2PolicyReviewPacketRow['policyConflictType'];
  readonly authorityStatus: LookupV2PolicyReviewPacketRow['authorityStatus'];
  readonly stretchExpectedStatus: LookupV2PolicyReviewPacketRow['stretchExpectedStatus'];
  readonly benchmarkGoldEntityId: string;
  readonly benchmarkGoldEntityIdSources: readonly NonNullable<LookupV2PolicyReviewPacketRow['benchmarkGoldEntityIdSource']>[];
  readonly proposalStatus: LookupV2PolicyReviewPacketRow['proposalStatus'];
  readonly reviewTarget: LookupV2PolicyReviewPacketRow['reviewTarget'];
  readonly benchmarkGoldHints: readonly string[];
  readonly sampleSurfaces: readonly string[];
  readonly holeClasses: readonly string[];
  readonly suggestedAliasTypes: readonly LookupV2PolicyReviewPacketRow['suggestedAliasType'][];
  readonly rowCount: number;
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly proposedAt: string;
  readonly reviewedAt?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly decisionReason?: string | undefined;
}

interface LookupV2PolicyReviewPacketGroup {
  readonly key: string;
  readonly exemplar: LookupV2PolicyReviewPacketRow;
  readonly rows: LookupV2PolicyReviewPacketRow[];
}

function isLookupV2PolicyReviewPacketRow(value: unknown): value is LookupV2PolicyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['semanticConflictKey'] === 'string'
    && typeof row['policyConflictSurface'] === 'string'
    && typeof row['policyConflictType'] === 'string'
    && typeof row['authorityStatus'] === 'string'
    && typeof row['stretchExpectedStatus'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && typeof row['sourceArtifact'] === 'string'
    && typeof row['sourceEvidence'] === 'string'
    && typeof row['proposedAt'] === 'string'
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2PolicyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2PolicyReviewPacketRow);
}

function familyKey(row: LookupV2PolicyReviewPacketRow): string {
  if (row.benchmarkGoldEntityId === undefined) {
    throw new Error(`policy-review row is missing benchmarkGoldEntityId for family packet surface=${JSON.stringify(row.surface)}`);
  }
  return JSON.stringify([
    row.semanticConflictKey,
    row.policyConflictSurface,
    row.benchmarkGoldEntityId,
    row.policyConflictType,
    row.authorityStatus,
    row.stretchExpectedStatus,
  ]);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function buildLookupV2PolicyFamilyReviewPacketRows(args: {
  readonly packetRows: readonly LookupV2PolicyReviewPacketRow[];
}): readonly LookupV2PolicyFamilyReviewPacketRow[] {
  const groups = new Map<string, LookupV2PolicyReviewPacketGroup>();

  for (const row of args.packetRows) {
    if (row.proposalStatus !== 'needs_policy_review') {
      throw new Error(`policy family review packet expects pending row status, got=${row.proposalStatus} surface=${JSON.stringify(row.surface)}`);
    }
    const key = familyKey(row);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        exemplar: row,
        rows: [row],
      });
      continue;
    }
    if (
      existing.exemplar.locale !== row.locale
      || existing.exemplar.reviewTarget !== row.reviewTarget
      || existing.exemplar.policyConflictSurface !== row.policyConflictSurface
      || existing.exemplar.policyConflictType !== row.policyConflictType
      || existing.exemplar.authorityStatus !== row.authorityStatus
      || existing.exemplar.stretchExpectedStatus !== row.stretchExpectedStatus
      || existing.exemplar.benchmarkGoldEntityId !== row.benchmarkGoldEntityId
    ) {
      throw new Error(`policy family review packet invariant mismatch for surface=${JSON.stringify(row.policyConflictSurface)}`);
    }
    existing.rows.push(row);
  }

  return [...groups.values()]
    .map((group) => {
      const rows = group.rows;
      const benchmarkGoldEntityIdSources = sortUnique(
        rows
          .map((row) => row.benchmarkGoldEntityIdSource)
          .filter((value): value is NonNullable<LookupV2PolicyReviewPacketRow['benchmarkGoldEntityIdSource']> => value !== undefined),
      );
      const proposedAt = [...rows]
        .map((row) => row.proposedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? group.exemplar.proposedAt;
      return {
        semanticConflictKey: group.exemplar.semanticConflictKey,
        policyConflictSurface: group.exemplar.policyConflictSurface,
        locale: group.exemplar.locale,
        policyConflictType: group.exemplar.policyConflictType,
        authorityStatus: group.exemplar.authorityStatus,
        stretchExpectedStatus: group.exemplar.stretchExpectedStatus,
        benchmarkGoldEntityId: group.exemplar.benchmarkGoldEntityId!,
        benchmarkGoldEntityIdSources,
        proposalStatus: 'needs_policy_review',
        reviewTarget: group.exemplar.reviewTarget,
        benchmarkGoldHints: sortUnique(rows.map((row) => row.benchmarkGoldHint)),
        sampleSurfaces: sortUnique(rows.map((row) => row.surface)),
        holeClasses: sortUnique(rows.map((row) => row.holeClass)),
        suggestedAliasTypes: sortUnique(rows.map((row) => row.suggestedAliasType)) as readonly LookupV2PolicyReviewPacketRow['suggestedAliasType'][],
        rowCount: rows.length,
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        proposedAt,
      };
    })
    .sort((left, right) =>
      left.semanticConflictKey.localeCompare(right.semanticConflictKey)
      || left.policyConflictSurface.localeCompare(right.policyConflictSurface)
      || left.benchmarkGoldEntityId.localeCompare(right.benchmarkGoldEntityId),
    );
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl');
  const packetRows = parsePacketJsonl(inputPath);
  const familyRows = buildLookupV2PolicyFamilyReviewPacketRows({ packetRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    familyRows.map((row) => JSON.stringify(row)).join('\n') + (familyRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-policy-family-review-packet] input_rows=${packetRows.length}`);
  console.log(`[elv2-policy-family-review-packet] family_rows=${familyRows.length}`);
  console.log(`[elv2-policy-family-review-packet] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
