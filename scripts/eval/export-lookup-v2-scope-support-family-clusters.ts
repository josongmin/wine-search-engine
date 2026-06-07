import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ScopeSupportFamilyClusterRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly supportStatus: 'active_entity_absent' | 'vintage_anchor_absent' | 'secondary_line_only';
  readonly familyScopeRows: number;
  readonly locales: readonly LookupV2CurationDraftRow['locale'][];
  readonly suggestedAliasTypes: readonly LookupV2CurationDraftRow['suggestedAliasType'][];
  readonly holeClasses: readonly string[];
  readonly surfaces: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
}

export interface LookupV2ScopeSupportFamilyClusterIndex {
  readonly sourceDraftPath: string;
  readonly generatedAt: string;
  readonly totalRows: number;
  readonly totalFamilies: number;
  readonly outputPath: string;
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['triageBucket'] === 'string'
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

function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export function writeLookupV2ScopeSupportFamilyClusters(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly sourceDraftPath: string;
  readonly outputPath: string;
  readonly generatedAt: string;
}): LookupV2ScopeSupportFamilyClusterIndex {
  const groups = new Map<string, LookupV2CurationDraftRow[]>();
  for (const row of args.draftRows) {
    if (row.triageBucket !== 'catalog_support_review') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.supportStatus === undefined) {
      throw new Error(`catalog_support_review draft row is missing support metadata for surface=${JSON.stringify(row.surface)}`);
    }
    const key = row.benchmarkGoldHint;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const clusterRows: readonly LookupV2ScopeSupportFamilyClusterRow[] = [...groups.entries()]
    .map(([benchmarkGoldHint, rows]) => ({
      benchmarkGoldHint,
      normalizedBenchmarkGoldHint: normalizeForMatch(benchmarkGoldHint),
      supportStatus: rows[0]!.supportStatus!,
      familyScopeRows: rows.length,
      locales: sortUnique(rows.map((row) => row.locale)) as readonly LookupV2CurationDraftRow['locale'][],
      suggestedAliasTypes: sortUnique(rows.map((row) => row.suggestedAliasType)) as readonly LookupV2CurationDraftRow['suggestedAliasType'][],
      holeClasses: sortUnique(rows.map((row) => row.holeClass)),
      surfaces: sortUnique(rows.map((row) => row.surface)),
      sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
      sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
    }))
    .sort((left, right) => left.benchmarkGoldHint.localeCompare(right.benchmarkGoldHint));

  mkdirSync(path.dirname(args.outputPath), { recursive: true });
  writeFileSync(args.outputPath, serializeJsonl(clusterRows), 'utf8');

  return {
    sourceDraftPath: args.sourceDraftPath,
    generatedAt: args.generatedAt,
    totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
    totalFamilies: clusterRows.length,
    outputPath: args.outputPath,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-scope-support-family-clusters.jsonl' },
      generatedAt: { type: 'string', default: new Date().toISOString() },
    },
  });

  const inputPath = resolveCliDataPathArg(
    values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl',
  );
  const outputPath = resolveCliDataPathArg(
    values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-scope-support-family-clusters.jsonl',
  );
  const generatedAt = values.generatedAt ?? new Date().toISOString();
  const draftRows = parseDraftJsonl(inputPath);
  const index = writeLookupV2ScopeSupportFamilyClusters({
    draftRows,
    sourceDraftPath: inputPath,
    outputPath,
    generatedAt,
  });

  console.log(`[elv2-scope-support-family-clusters] total_rows=${index.totalRows}`);
  console.log(`[elv2-scope-support-family-clusters] total_families=${index.totalFamilies}`);
  console.log(`[elv2-scope-support-family-clusters] output=${index.outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
