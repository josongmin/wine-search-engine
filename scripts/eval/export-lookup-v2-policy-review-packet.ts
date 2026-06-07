import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from './lookup-v2-policy-conflict-registry.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2PolicyReviewPacketRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly suggestedAliasType: LookupV2CurationDraftRow['suggestedAliasType'];
  readonly holeClass: string;
  readonly observedStatus: string;
  readonly benchmarkGoldHint: string;
  readonly benchmarkGoldEntityId?: string | undefined;
  readonly benchmarkGoldEntityIdSource?: 'fixture_exact' | 'hint_resolution' | 'policy_registry_authority' | undefined;
  readonly semanticConflictKey: string;
  readonly policyConflictSurface: string;
  readonly policyConflictType: LookupPolicyConflictRegistryRow['conflictType'];
  readonly authorityStatus: LookupPolicyConflictRegistryRow['authorityStatus'];
  readonly stretchExpectedStatus: LookupPolicyConflictRegistryRow['stretchExpectedStatus'];
  readonly proposalStatus: 'needs_policy_review' | 'approved_exact_safe' | 'kept_ambiguous' | 'needs_scope_target';
  readonly reviewTarget: 'lookup_semantic_policy_registry_v1';
  readonly sourceArtifact: string;
  readonly sourceEvidence: string;
  readonly proposedAt: string;
  readonly reviewedAt?: string | undefined;
  readonly reviewedBy?: string | undefined;
  readonly decisionReason?: string | undefined;
}

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
    && typeof row['observedStatus'] === 'string'
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

export function buildLookupV2PolicyReviewPacketRows(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly policyConflictOwners?: ReadonlyMap<string, LookupPolicyConflictRegistryRow>;
}): readonly LookupV2PolicyReviewPacketRow[] {
  const policyConflictOwners = args.policyConflictOwners
    ?? loadLookupPolicyConflictBenchmarkHintOwnerMapSync();
  const rows: LookupV2PolicyReviewPacketRow[] = [];
  const seen = new Set<string>();

  for (const row of args.draftRows) {
    if (row.triageBucket !== 'scope_policy_review') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined) {
      throw new Error(`scope_policy_review draft row is missing benchmarkGoldHint for surface=${JSON.stringify(row.surface)}`);
    }
    const normalizedHint = normalizeForMatch(row.benchmarkGoldHint);
    const owner = policyConflictOwners.get(normalizedHint);
    if (owner === undefined) {
      throw new Error(
        `scope_policy_review draft row has no reviewed policy owner for hint=${JSON.stringify(row.benchmarkGoldHint)} surface=${JSON.stringify(row.surface)}`,
      );
    }
    if (row.semanticConflictKey === undefined) {
      throw new Error(
        `scope_policy_review draft row is missing semanticConflictKey for hint=${JSON.stringify(row.benchmarkGoldHint)} surface=${JSON.stringify(row.surface)}`,
      );
    }
    const dedupeKey = JSON.stringify([
      row.semanticConflictKey,
      row.benchmarkGoldEntityId ?? '',
      normalizedHint,
    ]);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    rows.push({
      surface: row.surface,
      locale: row.locale,
      suggestedAliasType: row.suggestedAliasType,
      holeClass: row.holeClass,
      observedStatus: row.observedStatus,
      benchmarkGoldHint: row.benchmarkGoldHint,
      ...(row.benchmarkGoldEntityId !== undefined ? { benchmarkGoldEntityId: row.benchmarkGoldEntityId } : {}),
      ...(row.benchmarkGoldEntityIdSource !== undefined
        ? { benchmarkGoldEntityIdSource: row.benchmarkGoldEntityIdSource }
        : {}),
      semanticConflictKey: row.semanticConflictKey,
      policyConflictSurface: owner.surface,
      policyConflictType: owner.conflictType,
      authorityStatus: owner.authorityStatus,
      stretchExpectedStatus: owner.stretchExpectedStatus,
      proposalStatus: 'needs_policy_review',
      reviewTarget: 'lookup_semantic_policy_registry_v1',
      sourceArtifact: row.sourceArtifact,
      sourceEvidence: row.sourceEvidence,
      proposedAt: row.reviewedAt,
    });
  }

  return rows.sort((left, right) =>
    left.semanticConflictKey.localeCompare(right.semanticConflictKey)
    || left.policyConflictSurface.localeCompare(right.policyConflictSurface)
    || left.surface.localeCompare(right.surface)
    || left.benchmarkGoldHint.localeCompare(right.benchmarkGoldHint)
    || (left.benchmarkGoldEntityId ?? '').localeCompare(right.benchmarkGoldEntityId ?? ''),
  );
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl');
  const outputPath = resolveCliDataPathArg(values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl');
  const draftRows = parseDraftJsonl(inputPath);
  const packetRows = buildLookupV2PolicyReviewPacketRows({ draftRows });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    packetRows.map((row) => JSON.stringify(row)).join('\n') + (packetRows.length > 0 ? '\n' : ''),
    'utf8',
  );

  const countsByConflictSurface = new Map<string, number>();
  for (const row of packetRows) {
    countsByConflictSurface.set(
      row.policyConflictSurface,
      (countsByConflictSurface.get(row.policyConflictSurface) ?? 0) + 1,
    );
  }

  console.log(`[elv2-policy-review-packet] input_rows=${draftRows.length}`);
  console.log(`[elv2-policy-review-packet] packet_rows=${packetRows.length}`);
  console.log(`[elv2-policy-review-packet] output=${outputPath}`);
  console.log(`[elv2-policy-review-packet] counts_by_policy_surface=${JSON.stringify(Object.fromEntries(
    [...countsByConflictSurface.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  ))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
