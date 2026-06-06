import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  loadLookupV2RuntimeSurfaceOwnerEvidenceSync,
  type LookupV2RuntimeSurfaceOwnerWitness,
} from './lookup-v2-runtime-surface-owner-evidence.js';
import type { LookupV2ManualTargetFamilyReviewDecisionRow } from './review-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';

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
  evidence = loadLookupV2RuntimeSurfaceOwnerEvidenceSync(),
): readonly LookupV2ManualTargetFamilySuggestionRow[] {
  return packetRows.map((row) => {
    const normalizedHint = normalizeForMatch(row.benchmarkGoldHint);
    const uniqueOwner = evidence.uniqueOwners.get(normalizedHint);
    if (uniqueOwner !== undefined) {
      const uniqueOwnerWitnesses = evidence.uniqueOwnerWitnesses.get(normalizedHint);
      return {
        reviewScopeKey: row.reviewScopeKey,
        benchmarkGoldHint: row.benchmarkGoldHint,
        normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
        scopeHoleClass: row.scopeHoleClass,
        scopeSuggestedAliasType: row.scopeSuggestedAliasType,
        scopeRisk: row.scopeRisk,
        suggestionStatus: 'candidate_unique_owner',
        recommendedEntityId: uniqueOwner,
        ...(evidence.entityLabels.get(uniqueOwner) !== undefined
          ? { recommendedEntityLabel: evidence.entityLabels.get(uniqueOwner)! }
          : {}),
        ...(uniqueOwnerWitnesses !== undefined && uniqueOwnerWitnesses.length > 0
          ? { recommendedWitnesses: uniqueOwnerWitnesses }
          : {}),
        sourceEvidence: 'runtime_unique_surface_owner',
      };
    }
    const collidingOwners = evidence.collidingOwners.get(normalizedHint);
    const collidingOwnerWitnesses = evidence.collidingOwnerWitnesses.get(normalizedHint);
    if (collidingOwners !== undefined) {
      return {
        reviewScopeKey: row.reviewScopeKey,
        benchmarkGoldHint: row.benchmarkGoldHint,
        normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
        scopeHoleClass: row.scopeHoleClass,
        scopeSuggestedAliasType: row.scopeSuggestedAliasType,
        scopeRisk: row.scopeRisk,
        suggestionStatus: 'collision_candidates',
        candidateEntityIds: collidingOwners,
        candidateEntityLabels: collidingOwners.map((entityId) => evidence.entityLabels.get(entityId) ?? entityId),
        ...(collidingOwnerWitnesses !== undefined && collidingOwnerWitnesses.length > 0
          ? { candidateWitnesses: collidingOwnerWitnesses }
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

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl';
  const decisionsOutputPath = values.decisionsOutput ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl';
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
