import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import {
  buildLookupV2CurationDraftRows,
  buildLookupV2CurationDraftRowsWithRuntimeDescriptors,
  type LookupV2CurationDraftRow,
} from './export-lookup-v2-curation-drafts.js';
import {
  buildLookupExactSafeProposalPacketRows,
  type LookupExactSafeProposalPacketRow,
} from './export-lookup-v2-exact-safe-proposal-packet.js';
import { approveLookupV2ReviewedAuthorityExactSafeProposalPacket } from './approve-lookup-v2-reviewed-authority-exact-safe-proposal-packet.js';
import {
  applyLookupV2ExactSafeScopeRegistryToFamilyReviewPacketRows,
  buildLookupV2ExactSafeFamilyReviewPacketRows,
  type LookupExactSafeFamilyReviewPacketRow,
} from './export-lookup-v2-exact-safe-family-review-packet.js';
import {
  buildLookupV2ExactSafeFamilySuggestions,
  buildLookupV2ExactSafeSuggestedDecisionRows,
  type LookupV2ExactSafeFamilySuggestionRow,
} from './export-lookup-v2-exact-safe-family-suggestions.js';
import {
  buildLookupV2PolicyReviewPacketRows,
  type LookupV2PolicyReviewPacketRow,
} from './export-lookup-v2-policy-review-packet.js';
import {
  buildLookupV2PolicyFamilyReviewPacketRows,
  type LookupV2PolicyFamilyReviewPacketRow,
} from './export-lookup-v2-policy-family-review-packet.js';
import {
  buildLookupV2PolicyFamilySuggestions,
  buildLookupV2PolicyFamilySuggestedDecisionRows,
  type LookupV2PolicyFamilySuggestionRow,
} from './export-lookup-v2-policy-family-suggestions.js';
import {
  buildLookupV2ManualTargetFamilyReviewPacketRows,
  buildLookupV2ReviewedCollisionFamilyReviewPacketRows,
  type LookupV2ManualTargetFamilyReviewPacketRow,
} from './export-lookup-v2-manual-target-family-review-packet.js';
import {
  buildLookupV2ManualTargetFamilySuggestions,
  buildLookupV2ManualTargetSuggestedDecisionRows,
  type LookupV2ManualTargetFamilySuggestionRow,
} from './export-lookup-v2-manual-target-family-suggestions.js';
import {
  writeLookupV2ManualTargetBatches,
  type LookupV2ManualTargetBatchIndex,
} from './export-lookup-v2-manual-target-batches.js';
import {
  writeLookupV2ManualTargetRuntimeOwnerPartitions,
  type LookupV2ManualTargetRuntimeOwnerPartitionIndex,
} from './export-lookup-v2-manual-target-runtime-owner-partitions.js';
import {
  writeLookupV2ManualTargetOwnerFamilyClusters,
  type LookupV2ManualTargetOwnerEvidenceFamilyClusterIndex,
} from './export-lookup-v2-manual-target-owner-family-clusters.js';
import {
  writeLookupV2ScopeSupportFamilyClusters,
  type LookupV2ScopeSupportFamilyClusterIndex,
} from './export-lookup-v2-scope-support-family-clusters.js';
import {
  writeLookupV2ReviewedCollisionFamilyClusters,
  type LookupV2ReviewedCollisionFamilyClusterIndex,
} from './export-lookup-v2-reviewed-collision-family-clusters.js';
import {
  writeLookupV2StretchOwnerDispatchManifest,
  type LookupV2StretchOwnerDispatchManifest,
} from './export-lookup-v2-stretch-owner-dispatch-manifest.js';
import {
  loadLookupV2BenchmarkGoldHintMapSync,
} from './lookup-v2-benchmark-gold-map.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetApprovedMapSync,
  loadLookupV2SemanticScopeTargetRejectedMapSync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import {
  loadLookupPolicyConflictBenchmarkHintOwnerMapSync,
} from './lookup-v2-policy-conflict-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  loadLookupV2SemanticPolicyRegistryMapSync,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
  loadLookupV2SemanticScopeSupportRegistryMapSync,
  type LookupV2SemanticScopeSupportRegistryRow,
} from './lookup-v2-semantic-scope-support-registry.js';
import type { LookupV2FamilyCollisionRegistryRow } from './lookup-v2-family-collision-registry.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH,
  loadLookupV2FamilyCollisionRegistryMapSync,
} from './lookup-v2-family-collision-registry.js';
import {
  buildLookupV2ApprovedScopeSurfaceMap,
  loadLookupV2LocalizedScopeSurfaceRegistrySync,
} from './lookup-v2-localized-scope-surface-registry.js';
import type { LookupExactSafeRegistryRow } from '../etl/lookup-exact-safe-registry.js';
import {
  DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
  loadLookupExactSafeRegistry,
} from '../etl/lookup-exact-safe-registry.js';
import type { LookupV2ExactSafeScopeRegistryRow } from './lookup-v2-exact-safe-scope-registry.js';
import {
  DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH,
  loadLookupV2ExactSafeScopeRegistryMapSync,
} from './lookup-v2-exact-safe-scope-registry.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import {
  loadLookupV2RuntimeSurfaceOwnerEvidenceSync,
} from './lookup-v2-runtime-surface-owner-evidence.js';
import { applyLookupV2ExactSafeFamilyReviewPacket } from './apply-lookup-v2-exact-safe-family-review-packet.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';
import type { LookupV2RuntimeSemanticDescriptor } from './lookup-v2-runtime-semantic-descriptors.js';
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from './lookup-v2-runtime-semantic-descriptors.js';

interface LookupV2StretchCoverageArtifact {
  readonly generatedAt?: string;
  readonly curationTasks?: readonly CurationTask[];
  readonly report?: {
    readonly hotEntityCount?: number;
    readonly coveredCount?: number;
    readonly holes?: readonly Array<{
      readonly operatorBucket?: string;
      readonly observedReasonCode?: string;
    }>;
  };
}

interface LookupV2StretchWritePlaneOutputPaths {
  readonly draft: string;
  readonly exactSafePacket: string;
  readonly reviewedAuthorityApprovedExactSafePacket: string;
  readonly reviewedScopeExactSafePacket: string;
  readonly exactSafeFamilyReviewPacket: string;
  readonly exactSafeFamilySuggestions: string;
  readonly exactSafeFamilySuggestedDecisions: string;
  readonly policyReviewPacket: string;
  readonly policyFamilyReviewPacket: string;
  readonly policyFamilySuggestions: string;
  readonly policyFamilySuggestedDecisions: string;
  readonly manualTargetFamilyReviewPacket: string;
  readonly reviewedCollisionFamilyReviewPacket: string;
  readonly manualTargetFamilySuggestions: string;
  readonly manualTargetFamilySuggestedDecisions: string;
  readonly manualTargetBatchDir: string;
  readonly manualTargetOwnerEvidenceDir: string;
  readonly ownerDispatchManifest: string;
  readonly ownerDispatchPacketsDir: string;
  readonly summary: string;
}

export interface LookupV2StretchWritePlaneRefreshSummary {
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly outputPaths: LookupV2StretchWritePlaneOutputPaths;
  readonly coverageResidue: {
    readonly hotEntityCount: number;
    readonly coveredCount: number;
    readonly uncoveredCount: number;
    readonly activeCoverageRatio: number;
    readonly activeCoveragePercent: number;
    readonly operatorBucketCounts: Readonly<Record<string, number>>;
    readonly observedReasonCodeCounts: Readonly<Record<string, number>>;
  };
  readonly draft: {
    readonly rows: number;
    readonly autoTargetable: number;
    readonly scopePolicyReview: number;
    readonly localizedSurfaceReview: number;
    readonly reviewedRejected: number;
    readonly catalogSupportReview: number;
    readonly reviewedCollision: number;
    readonly scopeTargetReview: number;
  };
  readonly exactSafe: {
    readonly packetRows: number;
    readonly reviewedAuthorityApprovedRows: number;
    readonly reviewedAuthorityPendingRows: number;
    readonly bySource: Record<string, number>;
    readonly scopeReviewedRowPacketRows: number;
    readonly familyReviewRows: number;
    readonly familyApprovedRows: number;
    readonly familyRejectedRows: number;
    readonly familyPendingRows: number;
    readonly familySuggestions: {
      readonly suggestApprove: number;
      readonly manualReview: number;
    };
  };
  readonly policy: {
    readonly reviewRows: number;
    readonly familyReviewRows: number;
    readonly suggestions: {
      readonly keepAmbiguous: number;
      readonly manualReview: number;
    };
  };
  readonly manualTarget: {
    readonly batchIndex: LookupV2ManualTargetBatchIndex;
    readonly ownerEvidenceIndex: LookupV2ManualTargetRuntimeOwnerPartitionIndex;
    readonly ownerEvidenceFamilyIndex: LookupV2ManualTargetOwnerEvidenceFamilyClusterIndex;
    readonly familyReviewRows: number;
    readonly suggestions: {
      readonly candidateUniqueOwner: number;
      readonly collisionCandidates: number;
      readonly missingRuntimeOwner: number;
    };
  };
  readonly scopeSupport: {
    readonly familyClusterIndex: LookupV2ScopeSupportFamilyClusterIndex;
  };
  readonly reviewedCollision: {
    readonly familyClusterIndex: LookupV2ReviewedCollisionFamilyClusterIndex;
    readonly familyReviewRows: number;
  };
  readonly ownerDispatch: {
    readonly manifest: LookupV2StretchOwnerDispatchManifest;
  };
  readonly remainingWork: {
    readonly ownerDispatchPackets: number;
    readonly ownerDispatchFamilies: number;
    readonly ownerDispatchRows: number;
    readonly exactSafePendingFamilyRows: number;
    readonly runtimeBackfill: {
      readonly packetCount: number;
      readonly familyCount: number;
      readonly rowCount: number;
      readonly byGapReason: Readonly<Record<string, {
        readonly packetCount: number;
        readonly familyCount: number;
        readonly rowCount: number;
      }>>;
    };
    readonly manualTargetCollision: {
      readonly packetCount: number;
      readonly familyCount: number;
      readonly rowCount: number;
    };
    readonly reviewedCollisionScope: {
      readonly packetCount: number;
      readonly familyCount: number;
      readonly rowCount: number;
      readonly byClarificationAxis: Readonly<Record<string, {
        readonly packetCount: number;
        readonly familyCount: number;
        readonly rowCount: number;
      }>>;
    };
  };
}

function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeJsonl(rows), 'utf8');
}

function buildOutputPaths(outputDir: string): LookupV2StretchWritePlaneOutputPaths {
  return {
    draft: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl'),
    exactSafePacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl'),
    reviewedAuthorityApprovedExactSafePacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-reviewed-authority-exact-safe-proposals-approved.jsonl'),
    reviewedScopeExactSafePacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-proposals-reviewed-from-scope-registry.jsonl'),
    exactSafeFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl'),
    exactSafeFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl'),
    exactSafeFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl'),
    policyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl'),
    policyFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl'),
    policyFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl'),
    policyFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl'),
    manualTargetFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl'),
    reviewedCollisionFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl'),
    manualTargetFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl'),
    manualTargetFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl'),
    manualTargetBatchDir: path.join(outputDir, 'manual-target-batches'),
    manualTargetOwnerEvidenceDir: path.join(outputDir, 'manual-target-owner-evidence'),
    ownerDispatchManifest: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json'),
    ownerDispatchPacketsDir: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-owner-dispatch-packets'),
    summary: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-write-plane-summary.json'),
  };
}

function countBy<T>(rows: readonly T[], keyFn: (row: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function buildCoverageResidueSummary(report: LookupV2StretchCoverageArtifact['report'] | undefined): LookupV2StretchWritePlaneRefreshSummary['coverageResidue'] {
  const hotEntityCount = report?.hotEntityCount ?? 0;
  const coveredCount = report?.coveredCount ?? 0;
  const uncoveredCount = Math.max(0, hotEntityCount - coveredCount);
  const activeCoverageRatio = hotEntityCount > 0 ? coveredCount / hotEntityCount : 0;
  const activeCoveragePercent = hotEntityCount > 0
    ? Number((activeCoverageRatio * 100).toFixed(1))
    : 0;
  const holes = report?.holes ?? [];
  const operatorBucketCounts = countBy(
    holes.filter((hole) => typeof hole.operatorBucket === 'string' && hole.operatorBucket.length > 0),
    (hole) => hole.operatorBucket!,
  );
  const observedReasonCodeCounts = countBy(
    holes.filter((hole) => typeof hole.observedReasonCode === 'string' && hole.observedReasonCode.length > 0),
    (hole) => hole.observedReasonCode!,
  );

  return {
    hotEntityCount,
    coveredCount,
    uncoveredCount,
    activeCoverageRatio,
    activeCoveragePercent,
    operatorBucketCounts,
    observedReasonCodeCounts,
  };
}

function buildDispatchSignatureCounts(
  packets: readonly LookupV2StretchOwnerDispatchManifest['packets'][number][],
): Readonly<Record<string, {
  readonly packetCount: number;
  readonly familyCount: number;
  readonly rowCount: number;
}>> {
  const counts = new Map<string, {
    packetCount: number;
    familyCount: number;
    rowCount: number;
  }>();

  for (const packet of packets) {
    const current = counts.get(packet.dispatchSignature) ?? {
      packetCount: 0,
      familyCount: 0,
      rowCount: 0,
    };
    current.packetCount += 1;
    current.familyCount += packet.familyCount;
    current.rowCount += packet.rowCount;
    counts.set(packet.dispatchSignature, current);
  }

  return Object.fromEntries(
    [...counts.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([signature, current]) => [signature, current]),
  );
}

function buildPacketClassSummary(
  packets: readonly LookupV2StretchOwnerDispatchManifest['packets'][number][],
) {
  return {
    packetCount: packets.length,
    familyCount: packets.reduce((sum, packet) => sum + packet.familyCount, 0),
    rowCount: packets.reduce((sum, packet) => sum + packet.rowCount, 0),
  };
}

function buildRemainingWorkSummary(args: {
  readonly manifest: LookupV2StretchOwnerDispatchManifest;
  readonly exactSafePendingFamilyRows: number;
}): LookupV2StretchWritePlaneRefreshSummary['remainingWork'] {
  const runtimeBackfillPackets = args.manifest.packets.filter((packet) => packet.packetClass === 'runtime_backfill');
  const manualTargetCollisionPackets = args.manifest.packets.filter((packet) => packet.packetClass === 'manual_target_collision');
  const reviewedCollisionPackets = args.manifest.packets.filter((packet) => packet.packetClass === 'reviewed_collision_scope');

  return {
    ownerDispatchPackets: args.manifest.totalPackets,
    ownerDispatchFamilies: args.manifest.packets.reduce((sum, packet) => sum + packet.familyCount, 0),
    ownerDispatchRows: args.manifest.packets.reduce((sum, packet) => sum + packet.rowCount, 0),
    exactSafePendingFamilyRows: args.exactSafePendingFamilyRows,
    runtimeBackfill: {
      ...buildPacketClassSummary(runtimeBackfillPackets),
      byGapReason: buildDispatchSignatureCounts(runtimeBackfillPackets),
    },
    manualTargetCollision: buildPacketClassSummary(manualTargetCollisionPackets),
    reviewedCollisionScope: {
      ...buildPacketClassSummary(reviewedCollisionPackets),
      byClarificationAxis: buildDispatchSignatureCounts(reviewedCollisionPackets),
    },
  };
}

export async function refreshLookupV2StretchWritePlaneArtifacts(args: {
  readonly tasks: readonly CurationTask[];
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly outputDir: string;
  readonly coverageReport?: LookupV2StretchCoverageArtifact['report'];
  readonly runtimeDescriptorMap?: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
  readonly benchmarkGoldHintMap?: ReadonlyMap<string, string>;
  readonly familyTargetApprovedMap?: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
  readonly familyTargetRejectedMap?: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
  readonly policyConflictOwners?: ReadonlyMap<string, LookupPolicyConflictRegistryRow>;
  readonly policyFamilyDecisionMap?: ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow>;
  readonly semanticScopeSupportRegistryMap?: ReadonlyMap<string, LookupV2SemanticScopeSupportRegistryRow>;
  readonly familyCollisionRegistryMap?: ReadonlyMap<string, LookupV2FamilyCollisionRegistryRow>;
  readonly approvedScopeSurfaceMap?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly exactSafeRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly exactSafeScopeRegistryMap?: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
}): Promise<LookupV2StretchWritePlaneRefreshSummary> {
  const outputPaths = buildOutputPaths(args.outputDir);
  const draftRows = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
    args.tasks,
    args.inputArtifact,
    args.generatedAt,
    args.runtimeDescriptorMap ?? loadLookupV2RuntimeSemanticDescriptorMapSync(),
    args.benchmarkGoldHintMap,
    args.familyTargetApprovedMap,
    args.familyTargetRejectedMap,
    args.policyConflictOwners,
    args.policyFamilyDecisionMap,
    args.semanticScopeSupportRegistryMap,
    args.familyCollisionRegistryMap,
    args.approvedScopeSurfaceMap
      ?? buildLookupV2ApprovedScopeSurfaceMap(loadLookupV2LocalizedScopeSurfaceRegistrySync()),
  );
  writeJsonl(outputPaths.draft, draftRows);

  const exactSafeRegistryRows = args.exactSafeRegistryRows ?? [];
  const exactSafePacketRows = buildLookupExactSafeProposalPacketRows({
    draftRows,
    existingRegistryRows: exactSafeRegistryRows,
    exactSafeScopeRegistryMap: args.exactSafeScopeRegistryMap,
    semanticScopeTargetApprovedMap: args.familyTargetApprovedMap,
  });
  writeJsonl(outputPaths.exactSafePacket, exactSafePacketRows);

  const reviewedAuthorityApprovedExactSafePacketRows =
    approveLookupV2ReviewedAuthorityExactSafeProposalPacket({
      packetRows: exactSafePacketRows,
      reviewedBy: 'registry:reviewed-authority',
      reviewedAt: args.generatedAt,
      decisionReason: 'approved upstream reviewed authority source',
    });
  writeJsonl(outputPaths.reviewedAuthorityApprovedExactSafePacket, reviewedAuthorityApprovedExactSafePacketRows);

  const rawExactSafeFamilyReviewRows = buildLookupV2ExactSafeFamilyReviewPacketRows({
    packetRows: exactSafePacketRows,
  });
  const exactSafeFamilyReviewRows = applyLookupV2ExactSafeScopeRegistryToFamilyReviewPacketRows({
    familyRows: rawExactSafeFamilyReviewRows,
    scopeRegistryMap: args.exactSafeScopeRegistryMap ?? new Map(),
  });
  writeJsonl(outputPaths.exactSafeFamilyReviewPacket, exactSafeFamilyReviewRows);
  const reviewedScopeExactSafePacketRows = applyLookupV2ExactSafeFamilyReviewPacket({
    familyRows: exactSafeFamilyReviewRows,
    rowPacketRows: exactSafePacketRows,
  });
  writeJsonl(outputPaths.reviewedScopeExactSafePacket, reviewedScopeExactSafePacketRows);
  const exactSafeFamilySuggestionRows = buildLookupV2ExactSafeFamilySuggestions(exactSafeFamilyReviewRows);
  writeJsonl(outputPaths.exactSafeFamilySuggestions, exactSafeFamilySuggestionRows);
  const exactSafeFamilySuggestedDecisionRows = buildLookupV2ExactSafeSuggestedDecisionRows(exactSafeFamilySuggestionRows);
  writeJsonl(outputPaths.exactSafeFamilySuggestedDecisions, exactSafeFamilySuggestedDecisionRows);

  const policyReviewRows = buildLookupV2PolicyReviewPacketRows({
    draftRows,
    policyConflictOwners: args.policyConflictOwners,
  });
  writeJsonl(outputPaths.policyReviewPacket, policyReviewRows);
  const policyFamilyReviewRows = buildLookupV2PolicyFamilyReviewPacketRows({
    packetRows: policyReviewRows,
  });
  writeJsonl(outputPaths.policyFamilyReviewPacket, policyFamilyReviewRows);
  const policyFamilySuggestionRows = buildLookupV2PolicyFamilySuggestions(policyFamilyReviewRows);
  writeJsonl(outputPaths.policyFamilySuggestions, policyFamilySuggestionRows);
  const policyFamilySuggestedDecisionRows = buildLookupV2PolicyFamilySuggestedDecisionRows(policyFamilySuggestionRows);
  writeJsonl(outputPaths.policyFamilySuggestedDecisions, policyFamilySuggestedDecisionRows);

  const manualTargetBatchIndex = writeLookupV2ManualTargetBatches({
    draftRows,
    sourceDraftPath: outputPaths.draft,
    outputDir: outputPaths.manualTargetBatchDir,
    generatedAt: args.generatedAt,
  });
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const manualTargetFamilyReviewRows = buildLookupV2ManualTargetFamilyReviewPacketRows({
    draftRows,
    runtimeOwnerEvidence,
    runtimeDescriptorMap: args.runtimeDescriptorMap,
  });
  writeJsonl(outputPaths.manualTargetFamilyReviewPacket, manualTargetFamilyReviewRows);
  const reviewedCollisionFamilyReviewRows = buildLookupV2ReviewedCollisionFamilyReviewPacketRows({
    draftRows,
    runtimeOwnerEvidence,
    runtimeDescriptorMap: args.runtimeDescriptorMap,
  });
  writeJsonl(outputPaths.reviewedCollisionFamilyReviewPacket, reviewedCollisionFamilyReviewRows);
  const manualTargetOwnerEvidenceIndex = writeLookupV2ManualTargetRuntimeOwnerPartitions({
    packetRows: manualTargetFamilyReviewRows,
    sourcePacketPath: outputPaths.manualTargetFamilyReviewPacket,
    outputDir: outputPaths.manualTargetOwnerEvidenceDir,
    generatedAt: args.generatedAt,
  });
  const manualTargetOwnerEvidenceFamilyIndex = writeLookupV2ManualTargetOwnerFamilyClusters({
    packetRows: manualTargetFamilyReviewRows,
    sourcePacketPath: outputPaths.manualTargetFamilyReviewPacket,
    outputDir: outputPaths.manualTargetOwnerEvidenceDir,
    generatedAt: args.generatedAt,
  });
  const manualTargetFamilySuggestionRows = buildLookupV2ManualTargetFamilySuggestions(
    manualTargetFamilyReviewRows,
    runtimeOwnerEvidence,
  );
  writeJsonl(outputPaths.manualTargetFamilySuggestions, manualTargetFamilySuggestionRows);
  const manualTargetSuggestedDecisionRows = buildLookupV2ManualTargetSuggestedDecisionRows(manualTargetFamilySuggestionRows);
  writeJsonl(outputPaths.manualTargetFamilySuggestedDecisions, manualTargetSuggestedDecisionRows);
  const scopeSupportFamilyClusterIndex = writeLookupV2ScopeSupportFamilyClusters({
    draftRows,
    sourceDraftPath: outputPaths.draft,
    outputPath: path.join(args.outputDir, 'lookup-v2-korean-realworld-stretch-scope-support-family-clusters.jsonl'),
    generatedAt: args.generatedAt,
  });
  const reviewedCollisionFamilyClusterIndex = writeLookupV2ReviewedCollisionFamilyClusters({
    draftRows,
    packetRows: reviewedCollisionFamilyReviewRows,
    runtimeOwnerEvidence,
    sourceDraftPath: outputPaths.draft,
    sourcePacketPath: outputPaths.reviewedCollisionFamilyReviewPacket,
    outputPath: path.join(args.outputDir, 'lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl'),
    generatedAt: args.generatedAt,
  });
  const ownerDispatchManifest = writeLookupV2StretchOwnerDispatchManifest({
    inputArtifact: args.inputArtifact,
    outputDir: args.outputDir,
    generatedAt: args.generatedAt,
    manualTargetCollisionSourcePath: manualTargetOwnerEvidenceFamilyIndex.outputPaths.collisionCandidateFamilies,
    manualTargetCollisionPacketPath: outputPaths.manualTargetFamilyReviewPacket,
    runtimeBackfillByGapReasonDir: manualTargetOwnerEvidenceFamilyIndex.outputPaths.gapReasonDir,
    reviewedCollisionByClarificationAxisDir: reviewedCollisionFamilyClusterIndex.clarificationOutputDir,
    reviewedCollisionPacketPath: outputPaths.reviewedCollisionFamilyReviewPacket,
    manifestPath: outputPaths.ownerDispatchManifest,
    packetsDir: outputPaths.ownerDispatchPacketsDir,
  });

  const summary: LookupV2StretchWritePlaneRefreshSummary = {
    inputArtifact: args.inputArtifact,
    generatedAt: args.generatedAt,
    outputPaths,
    coverageResidue: buildCoverageResidueSummary(args.coverageReport),
    draft: {
      rows: draftRows.length,
      autoTargetable: draftRows.filter((row) => row.triageBucket === 'auto_targetable').length,
      scopePolicyReview: draftRows.filter((row) => row.triageBucket === 'scope_policy_review').length,
      localizedSurfaceReview: draftRows.filter((row) => row.triageBucket === 'localized_surface_review').length,
      reviewedRejected: draftRows.filter((row) => row.triageBucket === 'reviewed_rejected').length,
      catalogSupportReview: draftRows.filter((row) => row.triageBucket === 'catalog_support_review').length,
      reviewedCollision: draftRows.filter((row) => row.triageBucket === 'reviewed_collision').length,
      scopeTargetReview: draftRows.filter((row) => row.triageBucket === 'scope_target_review').length,
    },
    exactSafe: {
      packetRows: exactSafePacketRows.length,
      reviewedAuthorityApprovedRows: reviewedAuthorityApprovedExactSafePacketRows.filter((row) => row.proposalStatus === 'approved').length,
      reviewedAuthorityPendingRows: reviewedAuthorityApprovedExactSafePacketRows.filter((row) => row.proposalStatus === 'needs_review').length,
      bySource: countBy(exactSafePacketRows, (row) => row.benchmarkGoldEntityIdSource),
      scopeReviewedRowPacketRows: reviewedScopeExactSafePacketRows.length,
      familyReviewRows: exactSafeFamilyReviewRows.length,
      familyApprovedRows: exactSafeFamilyReviewRows.filter((row) => row.proposalStatus === 'approved').length,
      familyRejectedRows: exactSafeFamilyReviewRows.filter((row) => row.proposalStatus === 'rejected').length,
      familyPendingRows: exactSafeFamilyReviewRows.filter((row) => row.proposalStatus === 'needs_review').length,
      familySuggestions: {
        suggestApprove: exactSafeFamilySuggestionRows.filter((row) => row.suggestionStatus === 'suggest_approve').length,
        manualReview: exactSafeFamilySuggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length,
      },
    },
    policy: {
      reviewRows: policyReviewRows.length,
      familyReviewRows: policyFamilyReviewRows.length,
      suggestions: {
        keepAmbiguous: policyFamilySuggestionRows.filter((row) => row.suggestionStatus === 'suggest_keep_ambiguous').length,
        manualReview: policyFamilySuggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length,
      },
    },
    manualTarget: {
      batchIndex: manualTargetBatchIndex,
      ownerEvidenceIndex: manualTargetOwnerEvidenceIndex,
      ownerEvidenceFamilyIndex: manualTargetOwnerEvidenceFamilyIndex,
      familyReviewRows: manualTargetFamilyReviewRows.length,
      suggestions: {
        candidateUniqueOwner: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'candidate_unique_owner').length,
        collisionCandidates: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'collision_candidates').length,
        missingRuntimeOwner: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'missing_runtime_owner').length,
      },
    },
    scopeSupport: {
      familyClusterIndex: scopeSupportFamilyClusterIndex,
    },
    reviewedCollision: {
      familyClusterIndex: reviewedCollisionFamilyClusterIndex,
      familyReviewRows: reviewedCollisionFamilyReviewRows.length,
    },
    ownerDispatch: {
      manifest: ownerDispatchManifest,
    },
    remainingWork: buildRemainingWorkSummary({
      manifest: ownerDispatchManifest,
      exactSafePendingFamilyRows: exactSafeFamilyReviewRows.filter((row) => row.proposalStatus === 'needs_review').length,
    }),
  };

  writeFileSync(outputPaths.summary, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json' },
      outputDir: { type: 'string', default: lookupV2DraftCliPath() },
      semanticScopeTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      semanticPolicyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      semanticScopeSupportRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH },
      familyCollisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH },
      exactSafeRegistry: { type: 'string', default: DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH },
      exactSafeScopeRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json';
  const outputDir = resolveCliDataPathArg(values.outputDir ?? lookupV2DraftCliPath());
  const familyTargetRegistryPath = values.semanticScopeTargetRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const policyFamilyDecisionRegistryPath = values.semanticPolicyRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const semanticScopeSupportRegistryPath = values.semanticScopeSupportRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH;
  const familyCollisionRegistryPath = values.familyCollisionRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH;
  const exactSafeRegistryPath = values.exactSafeRegistry ?? DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;
  const exactSafeScopeRegistryPath = values.exactSafeScopeRegistry ?? DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH;

  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as LookupV2StretchCoverageArtifact;
  const summary = await refreshLookupV2StretchWritePlaneArtifacts({
    tasks: parsed.curationTasks ?? [],
    inputArtifact: inputPath,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    outputDir,
    coverageReport: parsed.report,
    benchmarkGoldHintMap: loadLookupV2BenchmarkGoldHintMapSync(),
    familyTargetApprovedMap: loadLookupV2SemanticScopeTargetApprovedMapSync(familyTargetRegistryPath),
    familyTargetRejectedMap: loadLookupV2SemanticScopeTargetRejectedMapSync(familyTargetRegistryPath),
    policyConflictOwners: loadLookupPolicyConflictBenchmarkHintOwnerMapSync(),
    policyFamilyDecisionMap: loadLookupV2SemanticPolicyRegistryMapSync(policyFamilyDecisionRegistryPath),
    semanticScopeSupportRegistryMap: loadLookupV2SemanticScopeSupportRegistryMapSync(semanticScopeSupportRegistryPath),
    familyCollisionRegistryMap: loadLookupV2FamilyCollisionRegistryMapSync(familyCollisionRegistryPath),
    exactSafeRegistryRows: await loadLookupExactSafeRegistry(exactSafeRegistryPath),
    exactSafeScopeRegistryMap: loadLookupV2ExactSafeScopeRegistryMapSync(exactSafeScopeRegistryPath),
    runtimeOwnerEvidence: loadLookupV2RuntimeSurfaceOwnerEvidenceSync(),
  });

  console.log(`[elv2-stretch-write-plane-refresh] draft_rows=${summary.draft.rows}`);
  console.log(`[elv2-stretch-write-plane-refresh] active_coverage=${summary.coverageResidue.coveredCount}/${summary.coverageResidue.hotEntityCount} (${summary.coverageResidue.activeCoveragePercent}%)`);
  console.log(`[elv2-stretch-write-plane-refresh] auto_targetable=${summary.draft.autoTargetable}`);
  console.log(`[elv2-stretch-write-plane-refresh] scope_policy_review=${summary.draft.scopePolicyReview}`);
  console.log(`[elv2-stretch-write-plane-refresh] localized_surface_review=${summary.draft.localizedSurfaceReview}`);
  console.log(`[elv2-stretch-write-plane-refresh] catalog_support_review=${summary.draft.catalogSupportReview}`);
  console.log(`[elv2-stretch-write-plane-refresh] reviewed_collision=${summary.draft.reviewedCollision}`);
  console.log(`[elv2-stretch-write-plane-refresh] scope_target_review=${summary.draft.scopeTargetReview}`);
  console.log(`[elv2-stretch-write-plane-refresh] exact_safe_packet_rows=${summary.exactSafe.packetRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] reviewed_authority_approved_rows=${summary.exactSafe.reviewedAuthorityApprovedRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] reviewed_authority_pending_rows=${summary.exactSafe.reviewedAuthorityPendingRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] exact_safe_family_pending_rows=${summary.exactSafe.familyPendingRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] policy_family_rows=${summary.policy.familyReviewRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] manual_target_family_rows=${summary.manualTarget.familyReviewRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] manual_target_collision_families=${summary.manualTarget.ownerEvidenceFamilyIndex.collisionCandidateFamilies}`);
  console.log(`[elv2-stretch-write-plane-refresh] manual_target_missing_families=${summary.manualTarget.ownerEvidenceFamilyIndex.missingRuntimeOwnerFamilies}`);
  console.log(`[elv2-stretch-write-plane-refresh] runtime_backfill_packets=${summary.remainingWork.runtimeBackfill.packetCount}`);
  console.log(`[elv2-stretch-write-plane-refresh] reviewed_collision_scope_packets=${summary.remainingWork.reviewedCollisionScope.packetCount}`);
  console.log(`[elv2-stretch-write-plane-refresh] summary=${summary.outputPaths.summary}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
