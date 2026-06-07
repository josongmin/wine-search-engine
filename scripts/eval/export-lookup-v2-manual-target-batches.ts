import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ManualTargetBatchIndexEntry {
  readonly holeClass: string;
  readonly rowCount: number;
  readonly outputPath: string;
}

export interface LookupV2ManualTargetBatchIndex {
  readonly sourceDraftPath: string;
  readonly generatedAt: string;
  readonly totalRows: number;
  readonly batches: readonly LookupV2ManualTargetBatchIndexEntry[];
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string' &&
    typeof row['holeClass'] === 'string' &&
    typeof row['triageBucket'] === 'string'
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

function slugifyHoleClass(holeClass: string): string {
  return holeClass.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export function buildLookupV2ManualTargetBatches(
  draftRows: readonly LookupV2CurationDraftRow[],
): ReadonlyMap<string, readonly LookupV2CurationDraftRow[]> {
  const byClass = new Map<string, LookupV2CurationDraftRow[]>();
  for (const row of draftRows) {
    if (row.triageBucket !== 'scope_target_review') {
      continue;
    }
    const next = byClass.get(row.holeClass) ?? [];
    next.push(row);
    byClass.set(row.holeClass, next);
  }

  return new Map(
    [...byClass.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([holeClass, rows]) => [
        holeClass,
        rows.slice().sort((left, right) =>
          left.surface.localeCompare(right.surface)
          || left.sourceArtifact.localeCompare(right.sourceArtifact)
          || left.sourceEvidence.localeCompare(right.sourceEvidence),
        ),
      ]),
  );
}

export function writeLookupV2ManualTargetBatches(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly sourceDraftPath: string;
  readonly outputDir: string;
  readonly generatedAt: string;
}): LookupV2ManualTargetBatchIndex {
  const batches = buildLookupV2ManualTargetBatches(args.draftRows);
  mkdirSync(args.outputDir, { recursive: true });

  const indexEntries: LookupV2ManualTargetBatchIndexEntry[] = [];
  let totalRows = 0;

  for (const [holeClass, rows] of batches) {
    const outputPath = path.join(args.outputDir, `${slugifyHoleClass(holeClass)}.jsonl`);
    writeFileSync(
      outputPath,
      rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
      'utf8',
    );
    totalRows += rows.length;
    indexEntries.push({
      holeClass,
      rowCount: rows.length,
      outputPath,
    });
  }

  const index: LookupV2ManualTargetBatchIndex = {
    sourceDraftPath: args.sourceDraftPath,
    generatedAt: args.generatedAt,
    totalRows,
    batches: indexEntries,
  };
  writeFileSync(
    path.join(args.outputDir, 'index.json'),
    JSON.stringify(index, null, 2) + '\n',
    'utf8',
  );
  return index;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      outputDir: { type: 'string', default: 'data/lookup-v2/drafts/manual-target-batches' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl');
  const outputDir = resolveCliDataPathArg(values.outputDir ?? 'data/lookup-v2/drafts/manual-target-batches');
  const draftRows = parseDraftJsonl(inputPath);
  const generatedAt = new Date().toISOString();
  const index = writeLookupV2ManualTargetBatches({
    draftRows,
    sourceDraftPath: inputPath,
    outputDir,
    generatedAt,
  });

  console.log(`[elv2-manual-target-batches] input_rows=${draftRows.length}`);
  console.log(`[elv2-manual-target-batches] total_rows=${index.totalRows}`);
  console.log(`[elv2-manual-target-batches] batch_count=${index.batches.length}`);
  console.log(`[elv2-manual-target-batches] output_dir=${outputDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
