import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeFamilyReviewDecisionRow } from './review-lookup-v2-exact-safe-family-review-packet.js';
import type { LookupExactSafeFamilyReviewPacketRow } from './export-lookup-v2-exact-safe-family-review-packet.js';

export interface LookupV2ExactSafeFamilySuggestionRow {
  readonly entityId: string;
  readonly suggestionStatus: 'suggest_approve' | 'manual_review';
  readonly rationale: string;
}

const NORMALIZATION_ONLY_HOLE_CLASSES = new Set([
  'realworld_compact_alias',
  'realworld_spaced_alias',
  'realworld_korean_orthography',
]);

function isLookupExactSafeFamilyReviewPacketRow(value: unknown): value is LookupExactSafeFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['entityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
  );
}

function parsePacketJsonl(filePath: string): readonly LookupExactSafeFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupExactSafeFamilyReviewPacketRow);
}

export function buildLookupV2ExactSafeFamilySuggestions(
  packetRows: readonly LookupExactSafeFamilyReviewPacketRow[],
): readonly LookupV2ExactSafeFamilySuggestionRow[] {
  return packetRows.map((row) => {
    const allSourcesStrong = row.benchmarkGoldEntityIdSources.every((source) => source === 'fixture_exact');
    const allHoleClassesPromotionSafe = row.holeClasses.every((holeClass) => NORMALIZATION_ONLY_HOLE_CLASSES.has(holeClass));
    if (allSourcesStrong && allHoleClassesPromotionSafe) {
      return {
        entityId: row.entityId,
        suggestionStatus: 'suggest_approve',
        rationale: `promotion-safe exact-safe family: sources=${row.benchmarkGoldEntityIdSources.join(', ')} hole_classes=${row.holeClasses.join(', ')}`,
      };
    }
    return {
      entityId: row.entityId,
      suggestionStatus: 'manual_review',
      rationale: `requires manual review because source_strength=${row.benchmarkGoldEntityIdSources.join(', ')} hole_classes=${row.holeClasses.join(', ')}`,
    };
  }).sort((l, r) => l.entityId.localeCompare(r.entityId));
}

export function buildLookupV2ExactSafeSuggestedDecisionRows(
  suggestionRows: readonly LookupV2ExactSafeFamilySuggestionRow[],
): readonly LookupExactSafeFamilyReviewDecisionRow[] {
  return suggestionRows
    .filter((row) => row.suggestionStatus === 'suggest_approve')
    .map((row) => ({
      entityId: row.entityId,
      decision: 'approve' as const,
      reviewedBy: 'codex:suggested',
      decisionReason: row.rationale,
      reviewedAt: new Date().toISOString(),
    }));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl' },
      decisionsOutput: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl' },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl';
  const decisionsOutputPath = values.decisionsOutput ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const suggestionRows = buildLookupV2ExactSafeFamilySuggestions(packetRows);
  const decisionRows = buildLookupV2ExactSafeSuggestedDecisionRows(suggestionRows);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, suggestionRows.map((row) => JSON.stringify(row)).join('\n') + (suggestionRows.length > 0 ? '\n' : ''), 'utf8');
  writeFileSync(decisionsOutputPath, decisionRows.map((row) => JSON.stringify(row)).join('\n') + (decisionRows.length > 0 ? '\n' : ''), 'utf8');

  console.log(`[elv2-exact-safe-family-suggestions] input_rows=${packetRows.length}`);
  console.log(`[elv2-exact-safe-family-suggestions] suggest_approve=${suggestionRows.filter((row) => row.suggestionStatus === 'suggest_approve').length}`);
  console.log(`[elv2-exact-safe-family-suggestions] manual_review=${suggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length}`);
  console.log(`[elv2-exact-safe-family-suggestions] output=${outputPath}`);
  console.log(`[elv2-exact-safe-family-suggestions] decisions_output=${decisionsOutputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
