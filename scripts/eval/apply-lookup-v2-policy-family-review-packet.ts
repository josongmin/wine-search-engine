import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2PolicyReviewPacketRow } from './export-lookup-v2-policy-review-packet.js';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';
import {
  buildLookupV2SemanticPolicyRegistryKey,
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  loadLookupV2SemanticPolicyRegistryMapSync,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';
import { DEFAULT_RUNTIME_STATE_PATH } from './lookup-v2-runtime-known-entity-ids.js';
import { loadLookupV2RuntimeRegistryContextSync } from './lookup-v2-runtime-registry-context.js';

function isLookupV2PolicyReviewPacketRow(value: unknown): value is LookupV2PolicyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
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

function isLookupV2PolicyFamilyReviewPacketRow(value: unknown): value is LookupV2PolicyFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['policyConflictSurface'] === 'string'
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['benchmarkGoldHints'])
    && Array.isArray(row['sampleSurfaces'])
  );
}

function parsePacketJsonl<T>(
  filePath: string,
  predicate: (value: unknown) => value is T,
): readonly T[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(predicate);
}

function familyKey(semanticConflictKey: string, benchmarkGoldEntityId: string): string {
  return `${semanticConflictKey}::${benchmarkGoldEntityId}`;
}

export function applyLookupV2PolicyFamilyReviewPacket(args: {
  readonly familyRows: readonly LookupV2PolicyFamilyReviewPacketRow[];
  readonly rowPacketRows: readonly LookupV2PolicyReviewPacketRow[];
  readonly policyFamilyDecisionMap: ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow>;
}): readonly LookupV2PolicyReviewPacketRow[] {
  const familyByKey = new Map<string, LookupV2PolicyFamilyReviewPacketRow>();
  for (const row of args.familyRows) {
    const key = familyKey(row.semanticConflictKey, row.benchmarkGoldEntityId);
    if (familyByKey.has(key)) {
      throw new Error(`duplicate family review row for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    familyByKey.set(key, row);
  }

  return args.rowPacketRows.map((row) => {
    if (row.benchmarkGoldEntityId === undefined) {
      throw new Error(`row policy packet is missing benchmarkGoldEntityId for surface=${JSON.stringify(row.surface)}`);
    }
    const key = familyKey(row.semanticConflictKey, row.benchmarkGoldEntityId);
    const family = familyByKey.get(key);
    if (family === undefined) {
      throw new Error(`row policy packet has no family review row for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    if (family.proposalStatus === 'needs_policy_review') {
      return row;
    }
    const registryDecision = args.policyFamilyDecisionMap.get(
      buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.benchmarkGoldEntityId),
    );
    if (registryDecision === undefined) {
      throw new Error(`row policy packet has no reviewed policy-family registry decision for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    const expectedDecision = family.proposalStatus === 'approved_exact_safe'
      ? 'promote_exact_safe'
      : family.proposalStatus === 'kept_ambiguous'
        ? 'keep_ambiguous'
        : 'needs_scope_target';
    if (registryDecision.decision !== expectedDecision) {
      throw new Error(`row policy packet family review does not match reviewed policy-family registry for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.benchmarkGoldEntityId)}`);
    }
    return {
      ...row,
      proposalStatus: family.proposalStatus,
      reviewedAt: registryDecision.reviewedAt,
      reviewedBy: registryDecision.reviewedBy,
      decisionReason: registryDecision.decisionReason,
    };
  });
}

function serializeRows(rows: readonly LookupV2PolicyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      families: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl' },
      rows: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl') },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      runtimeState: { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed-from-family.jsonl' },
    },
  });

  const familiesPath = values.families ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed.jsonl';
  const rowsPath = resolveCliDataPathArg(
    values.rows ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl'),
  );
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const runtimeStatePath = values.runtimeState ?? DEFAULT_RUNTIME_STATE_PATH;
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed-from-family.jsonl';
  const familyRows = parsePacketJsonl(familiesPath, isLookupV2PolicyFamilyReviewPacketRow);
  const rowPacketRows = parsePacketJsonl(rowsPath, isLookupV2PolicyReviewPacketRow);
  const { knownEntityIds } = loadLookupV2RuntimeRegistryContextSync(runtimeStatePath);
  const policyFamilyDecisionMap = loadLookupV2SemanticPolicyRegistryMapSync(registryPath, knownEntityIds);
  const reviewedRows = applyLookupV2PolicyFamilyReviewPacket({
    familyRows,
    rowPacketRows,
    policyFamilyDecisionMap,
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const approved = reviewedRows.filter((row) => row.proposalStatus === 'approved_exact_safe').length;
  const kept = reviewedRows.filter((row) => row.proposalStatus === 'kept_ambiguous').length;
  const needsTarget = reviewedRows.filter((row) => row.proposalStatus === 'needs_scope_target').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_policy_review').length;
  console.log(`[elv2-policy-family-apply] family_rows=${familyRows.length}`);
  console.log(`[elv2-policy-family-apply] row_packet_rows=${rowPacketRows.length}`);
  console.log(`[elv2-policy-family-apply] approved_exact_safe_rows=${approved}`);
  console.log(`[elv2-policy-family-apply] kept_ambiguous_rows=${kept}`);
  console.log(`[elv2-policy-family-apply] needs_scope_target_rows=${needsTarget}`);
  console.log(`[elv2-policy-family-apply] pending_rows=${pending}`);
  console.log(`[elv2-policy-family-apply] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
