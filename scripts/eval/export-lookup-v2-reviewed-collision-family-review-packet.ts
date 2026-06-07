import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import {
  buildLookupV2ReviewedCollisionFamilyReviewPacketRows,
} from './export-lookup-v2-manual-target-family-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

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

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl');
  const draftRows = parseDraftJsonl(inputPath);
  const familyRows = buildLookupV2ReviewedCollisionFamilyReviewPacketRows({ draftRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    familyRows.map((row) => JSON.stringify(row)).join('\n') + (familyRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-reviewed-collision-family-review-packet] input_rows=${draftRows.filter((row) => row.triageBucket === 'reviewed_collision').length}`);
  console.log(`[elv2-reviewed-collision-family-review-packet] family_rows=${familyRows.length}`);
  console.log(`[elv2-reviewed-collision-family-review-packet] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
