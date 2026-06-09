import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupExactSafeProposalPacketRow } from './export-lookup-v2-exact-safe-proposal-packet.js';
import type { LookupV2PolicyReviewPacketRow } from './export-lookup-v2-policy-review-packet.js';
import {
  buildLookupV2SemanticPolicyRegistryKey,
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  loadLookupV2SemanticPolicyRegistryMapSync,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';
import { DEFAULT_RUNTIME_STATE_PATH } from './lookup-v2-runtime-known-entity-ids.js';
import { loadLookupV2RuntimeRegistryContextSync } from './lookup-v2-runtime-registry-context.js';

interface PolicyReviewApplyResult {
  readonly exactSafePacketRows: readonly LookupExactSafeProposalPacketRow[];
  readonly approvedExactSafeRows: number;
  readonly keptPolicyConflictRows: number;
  readonly needsTargetRows: number;
  readonly pendingRows: number;
}

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

function parsePacketJsonl(filePath: string): readonly LookupV2PolicyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2PolicyReviewPacketRow);
}

function buildExactSafePacketSourceEvidence(
  row: LookupV2PolicyReviewPacketRow,
  registryRow: LookupV2SemanticPolicyRegistryRow,
  registryPath: string,
): string {
  const registryName = path.basename(registryPath);
  return `${row.sourceEvidence} [semantic_policy_registry=${registryName} semantic_conflict=${row.semanticConflictKey} reviewedBy=${registryRow.reviewedBy} decision=${registryRow.decisionReason}]`;
}

export function applyLookupV2PolicyReviewPacket(args: {
  readonly packetRows: readonly LookupV2PolicyReviewPacketRow[];
  readonly policyFamilyDecisionMap: ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow>;
  readonly policyFamilyDecisionRegistryPath: string;
}): PolicyReviewApplyResult {
  const exactSafePacketRows: LookupExactSafeProposalPacketRow[] = [];
  let approvedExactSafeRows = 0;
  let keptPolicyConflictRows = 0;
  let needsTargetRows = 0;
  let pendingRows = 0;

  for (const row of args.packetRows) {
    if (row.reviewTarget !== 'lookup_semantic_policy_registry_v1') {
      throw new Error(`unsupported reviewTarget=${JSON.stringify(row.reviewTarget)} for surface=${JSON.stringify(row.surface)}`);
    }

    if (row.proposalStatus === 'needs_policy_review') {
      pendingRows += 1;
      continue;
    }
    if (row.proposalStatus === 'kept_ambiguous') {
      if (row.benchmarkGoldEntityId === undefined) {
        throw new Error(`kept policy-review row is missing benchmarkGoldEntityId for surface=${JSON.stringify(row.surface)}`);
      }
      if (row.semanticConflictKey === undefined) {
        throw new Error(`kept policy-review row is missing semanticConflictKey for surface=${JSON.stringify(row.surface)}`);
      }
      const registryDecision = args.policyFamilyDecisionMap.get(
        buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.benchmarkGoldEntityId),
      );
      if (registryDecision?.decision !== 'keep_ambiguous') {
        throw new Error(`kept policy-review row does not match reviewed policy-family registry for surface=${JSON.stringify(row.surface)}`);
      }
      keptPolicyConflictRows += 1;
      continue;
    }
    if (row.proposalStatus === 'needs_scope_target') {
      if (row.benchmarkGoldEntityId === undefined) {
        throw new Error(`needs_scope_target policy-review row is missing benchmarkGoldEntityId for surface=${JSON.stringify(row.surface)}`);
      }
      if (row.semanticConflictKey === undefined) {
        throw new Error(`needs_scope_target policy-review row is missing semanticConflictKey for surface=${JSON.stringify(row.surface)}`);
      }
      const registryDecision = args.policyFamilyDecisionMap.get(
        buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.benchmarkGoldEntityId),
      );
      if (registryDecision?.decision !== 'needs_scope_target') {
        throw new Error(`needs_scope_target policy-review row does not match reviewed policy-family registry for surface=${JSON.stringify(row.surface)}`);
      }
      needsTargetRows += 1;
      continue;
    }

    approvedExactSafeRows += 1;
    if (row.benchmarkGoldEntityId === undefined) {
      throw new Error(`approved policy-review row is missing benchmarkGoldEntityId for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.benchmarkGoldEntityIdSource === undefined) {
      throw new Error(`approved policy-review row is missing benchmarkGoldEntityIdSource for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.semanticConflictKey === undefined) {
      throw new Error(`approved policy-review row is missing semanticConflictKey for surface=${JSON.stringify(row.surface)}`);
    }
    const registryDecision = args.policyFamilyDecisionMap.get(
      buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.benchmarkGoldEntityId),
    );
    if (registryDecision?.decision !== 'promote_exact_safe') {
      throw new Error(`approved policy-review row does not match reviewed policy-family registry for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.reviewedAt === undefined || Number.isNaN(Date.parse(row.reviewedAt))) {
      throw new Error(`approved policy-review row is missing reviewedAt for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.reviewedBy === undefined || row.reviewedBy.trim().length === 0) {
      throw new Error(`approved policy-review row is missing reviewedBy for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.decisionReason === undefined || row.decisionReason.trim().length === 0) {
      throw new Error(`approved policy-review row is missing decisionReason for surface=${JSON.stringify(row.surface)}`);
    }
    if (row.suggestedAliasType !== 'canonical' && row.suggestedAliasType !== 'translation') {
      throw new Error(`approved policy-review row has unsupported alias type=${JSON.stringify(row.suggestedAliasType)} for surface=${JSON.stringify(row.surface)}`);
    }

    exactSafePacketRows.push({
      surface: row.surface,
      entityId: row.benchmarkGoldEntityId,
      candidatePromotionClass: 'exact_safe',
      locale: row.locale,
      proposalStatus: 'approved',
      reviewTarget: 'lookup_exact_safe_registry_v1',
      suggestedAliasType: row.suggestedAliasType,
      holeClass: row.holeClass,
      benchmarkGoldHint: row.benchmarkGoldHint,
      benchmarkGoldEntityIdSource: 'semantic_policy_registry',
      sourceArtifact: row.sourceArtifact,
      sourceEvidence: buildExactSafePacketSourceEvidence(
        row,
        registryDecision,
        args.policyFamilyDecisionRegistryPath,
      ),
      proposedAt: row.proposedAt,
      reviewedAt: registryDecision.reviewedAt,
      reviewedBy: registryDecision.reviewedBy,
      decisionReason: registryDecision.decisionReason,
    });
  }

  return {
    exactSafePacketRows: exactSafePacketRows.sort((left, right) =>
      left.locale.localeCompare(right.locale)
      || left.surface.localeCompare(right.surface)
      || left.entityId.localeCompare(right.entityId),
    ),
    approvedExactSafeRows,
    keptPolicyConflictRows,
    needsTargetRows,
    pendingRows,
  };
}

function serializePacketRows(rows: readonly LookupExactSafeProposalPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      runtimeState: { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-policy-review-approved-exact-safe-packet.jsonl' },
    },
    allowPositionals: false,
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const runtimeStatePath = values.runtimeState ?? DEFAULT_RUNTIME_STATE_PATH;
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-policy-review-approved-exact-safe-packet.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const { knownEntityIds } = loadLookupV2RuntimeRegistryContextSync(runtimeStatePath);
  const policyFamilyDecisionMap = loadLookupV2SemanticPolicyRegistryMapSync(registryPath, knownEntityIds);
  const result = applyLookupV2PolicyReviewPacket({
    packetRows,
    policyFamilyDecisionMap,
    policyFamilyDecisionRegistryPath: registryPath,
  });

  writeFileSync(outputPath, serializePacketRows(result.exactSafePacketRows), 'utf8');
  console.log(`[elv2-policy-review-apply] approved_exact_safe_rows=${result.approvedExactSafeRows}`);
  console.log(`[elv2-policy-review-apply] kept_policy_conflict_rows=${result.keptPolicyConflictRows}`);
  console.log(`[elv2-policy-review-apply] needs_scope_target_rows=${result.needsTargetRows}`);
  console.log(`[elv2-policy-review-apply] pending_rows=${result.pendingRows}`);
  console.log(`[elv2-policy-review-apply] exact_safe_packet_rows=${result.exactSafePacketRows.length}`);
  console.log(`[elv2-policy-review-apply] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
