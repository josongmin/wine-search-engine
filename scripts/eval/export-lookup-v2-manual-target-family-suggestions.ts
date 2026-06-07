import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2RuntimeSurfaceOwnerWitness } from './lookup-v2-runtime-surface-owner-evidence.js';
import type { LookupV2ManualTargetFamilyReviewDecisionRow } from './review-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ManualTargetFamilySuggestionRow {
  readonly reviewScopeKey: string;
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly scopeHoleClass: LookupV2ManualTargetFamilyReviewPacketRow['scopeHoleClass'];
  readonly scopeSuggestedAliasType: LookupV2ManualTargetFamilyReviewPacketRow['scopeSuggestedAliasType'];
  readonly scopeRisk: LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'];
  readonly suggestionStatus: 'candidate_unique_owner' | 'collision_candidates' | 'missing_runtime_owner';
  readonly recommendedEntityId?: string | undefined;
  readonly recommendedEntityLabel?: string | undefined;
  readonly recommendedWitnesses?: readonly LookupV2RuntimeSurfaceOwnerWitness[] | undefined;
  readonly candidateEntityIds?: readonly string[] | undefined;
  readonly candidateEntityLabels?: readonly string[] | undefined;
  readonly candidateWitnesses?: readonly LookupV2RuntimeSurfaceOwnerWitness[] | undefined;
  readonly sourceEvidence: 'runtime_unique_surface_owner' | 'runtime_colliding_surface_owner' | 'runtime_owner_missing';
}

function isLookupV2ManualTargetFamilyReviewPacketRow(value: unknown): value is LookupV2ManualTargetFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['normalizedBenchmarkGoldHint'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
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

export function buildLookupV2ManualTargetFamilySuggestions(
  packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[],
): readonly LookupV2ManualTargetFamilySuggestionRow[] {
  return packetRows.map((row) => {
    if (row.runtimeEvidenceStatus === 'candidate_unique_owner' && row.runtimeEvidenceEntityId !== undefined) {
      return {
        reviewScopeKey: row.reviewScopeKey,
        benchmarkGoldHint: row.benchmarkGoldHint,
        normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
        scopeHoleClass: row.scopeHoleClass,
        scopeSuggestedAliasType: row.scopeSuggestedAliasType,
        scopeRisk: row.scopeRisk,
        suggestionStatus: 'candidate_unique_owner',
        recommendedEntityId: row.runtimeEvidenceEntityId,
        ...(row.runtimeEvidenceEntityLabel !== undefined
          ? { recommendedEntityLabel: row.runtimeEvidenceEntityLabel }
          : {}),
        ...(row.runtimeEvidenceWitnesses !== undefined && row.runtimeEvidenceWitnesses.length > 0
          ? { recommendedWitnesses: row.runtimeEvidenceWitnesses }
          : {}),
        sourceEvidence: 'runtime_unique_surface_owner',
      };
    }
    if (row.runtimeEvidenceStatus === 'collision_candidates' && row.runtimeCollisionEntityIds !== undefined) {
      return {
        reviewScopeKey: row.reviewScopeKey,
        benchmarkGoldHint: row.benchmarkGoldHint,
        normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
        scopeHoleClass: row.scopeHoleClass,
        scopeSuggestedAliasType: row.scopeSuggestedAliasType,
        scopeRisk: row.scopeRisk,
        suggestionStatus: 'collision_candidates',
        candidateEntityIds: row.runtimeCollisionEntityIds,
        candidateEntityLabels: row.runtimeCollisionEntityLabels ?? row.runtimeCollisionEntityIds,
        ...(row.runtimeCollisionWitnesses !== undefined && row.runtimeCollisionWitnesses.length > 0
          ? { candidateWitnesses: row.runtimeCollisionWitnesses }
          : {}),
        sourceEvidence: 'runtime_colliding_surface_owner',
      };
    }
    return {
      reviewScopeKey: row.reviewScopeKey,
      benchmarkGoldHint: row.benchmarkGoldHint,
      normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
      scopeHoleClass: row.scopeHoleClass,
      scopeSuggestedAliasType: row.scopeSuggestedAliasType,
      scopeRisk: row.scopeRisk,
      suggestionStatus: 'missing_runtime_owner',
      sourceEvidence: 'runtime_owner_missing',
    };
  }).sort((l, r) => l.reviewScopeKey.localeCompare(r.reviewScopeKey));
}

export function buildLookupV2ManualTargetSuggestedDecisionRows(
  suggestionRows: readonly LookupV2ManualTargetFamilySuggestionRow[],
): readonly LookupV2ManualTargetFamilyReviewDecisionRow[] {
  void suggestionRows;
  return [];
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl' },
      decisionsOutput: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl');
  const decisionsOutputPath = resolveCliDataPathArg(values.decisionsOutput ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl');
  const packetRows = parsePacketJsonl(inputPath);
  const suggestionRows = buildLookupV2ManualTargetFamilySuggestions(packetRows);
  const decisionRows = buildLookupV2ManualTargetSuggestedDecisionRows(suggestionRows);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, suggestionRows.map((row) => JSON.stringify(row)).join('\n') + (suggestionRows.length > 0 ? '\n' : ''), 'utf8');
  writeFileSync(decisionsOutputPath, decisionRows.map((row) => JSON.stringify(row)).join('\n') + (decisionRows.length > 0 ? '\n' : ''), 'utf8');

  const uniqueSuggestions = suggestionRows.filter((row) => row.suggestionStatus === 'candidate_unique_owner').length;
  const collisions = suggestionRows.filter((row) => row.suggestionStatus === 'collision_candidates').length;
  const missing = suggestionRows.filter((row) => row.suggestionStatus === 'missing_runtime_owner').length;
  console.log(`[elv2-manual-target-suggestions] input_rows=${packetRows.length}`);
  console.log(`[elv2-manual-target-suggestions] candidate_unique_owner=${uniqueSuggestions}`);
  console.log(`[elv2-manual-target-suggestions] collision_candidates=${collisions}`);
  console.log(`[elv2-manual-target-suggestions] missing_runtime_owner=${missing}`);
  console.log(`[elv2-manual-target-suggestions] output=${outputPath}`);
  console.log(`[elv2-manual-target-suggestions] decisions_output=${decisionsOutputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
