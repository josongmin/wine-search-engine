import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2PolicyFamilyReviewDecisionRow } from './review-lookup-v2-policy-family-review-packet.js';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2PolicyFamilySuggestionRow {
  readonly semanticConflictKey: string;
  readonly policyConflictSurface: string;
  readonly benchmarkGoldEntityId: string;
  readonly suggestionStatus: 'suggest_keep_ambiguous' | 'manual_review';
  readonly rationale: string;
}

function isLookupV2PolicyFamilyReviewPacketRow(value: unknown): value is LookupV2PolicyFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['policyConflictSurface'] === 'string'
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && typeof row['policyConflictType'] === 'string'
    && typeof row['authorityStatus'] === 'string'
    && typeof row['stretchExpectedStatus'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['benchmarkGoldHints'])
    && Array.isArray(row['sampleSurfaces'])
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2PolicyFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2PolicyFamilyReviewPacketRow);
}

export function buildLookupV2PolicyFamilySuggestions(
  packetRows: readonly LookupV2PolicyFamilyReviewPacketRow[],
): readonly LookupV2PolicyFamilySuggestionRow[] {
  return packetRows.map((row) => {
    const isFailClosedBroadConflict = (
      (row.policyConflictType === 'short_form_collision' || row.policyConflictType === 'broad_icon_collision')
      && row.authorityStatus === 'resolved'
      && row.stretchExpectedStatus === 'ambiguous'
    );
    if (isFailClosedBroadConflict) {
      return {
        semanticConflictKey: row.semanticConflictKey,
        policyConflictSurface: row.policyConflictSurface,
        benchmarkGoldEntityId: row.benchmarkGoldEntityId,
        suggestionStatus: 'suggest_keep_ambiguous',
        rationale: `fail-closed broad conflict: type=${row.policyConflictType} authority=${row.authorityStatus} stretch=${row.stretchExpectedStatus}`,
      };
    }
    return {
      semanticConflictKey: row.semanticConflictKey,
      policyConflictSurface: row.policyConflictSurface,
      benchmarkGoldEntityId: row.benchmarkGoldEntityId,
      suggestionStatus: 'manual_review',
      rationale: `requires manual policy review: type=${row.policyConflictType} authority=${row.authorityStatus} stretch=${row.stretchExpectedStatus}`,
    };
  }).sort((l, r) =>
    l.policyConflictSurface.localeCompare(r.policyConflictSurface)
    || l.benchmarkGoldEntityId.localeCompare(r.benchmarkGoldEntityId),
  );
}

export function buildLookupV2PolicyFamilySuggestedDecisionRows(
  suggestionRows: readonly LookupV2PolicyFamilySuggestionRow[],
): readonly LookupV2PolicyFamilyReviewDecisionRow[] {
  return suggestionRows
    .filter((row) => row.suggestionStatus === 'suggest_keep_ambiguous')
    .map((row) => ({
      semanticConflictKey: row.semanticConflictKey,
      policyConflictSurface: row.policyConflictSurface,
      benchmarkGoldEntityId: row.benchmarkGoldEntityId,
      decision: 'keep_ambiguous' as const,
      reviewedBy: 'codex:suggested',
      decisionReason: row.rationale,
      reviewedAt: new Date().toISOString(),
    }));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl' },
      decisionsOutput: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl');
  const decisionsOutputPath = resolveCliDataPathArg(values.decisionsOutput ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl');
  const packetRows = parsePacketJsonl(inputPath);
  const suggestionRows = buildLookupV2PolicyFamilySuggestions(packetRows);
  const decisionRows = buildLookupV2PolicyFamilySuggestedDecisionRows(suggestionRows);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, suggestionRows.map((row) => JSON.stringify(row)).join('\n') + (suggestionRows.length > 0 ? '\n' : ''), 'utf8');
  writeFileSync(decisionsOutputPath, decisionRows.map((row) => JSON.stringify(row)).join('\n') + (decisionRows.length > 0 ? '\n' : ''), 'utf8');

  console.log(`[elv2-policy-family-suggestions] input_rows=${packetRows.length}`);
  console.log(`[elv2-policy-family-suggestions] suggest_keep_ambiguous=${suggestionRows.filter((row) => row.suggestionStatus === 'suggest_keep_ambiguous').length}`);
  console.log(`[elv2-policy-family-suggestions] manual_review=${suggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length}`);
  console.log(`[elv2-policy-family-suggestions] output=${outputPath}`);
  console.log(`[elv2-policy-family-suggestions] decisions_output=${decisionsOutputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
