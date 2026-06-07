import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import { applyLookupV2SemanticScopeTargetRegistry } from './apply-lookup-v2-semantic-scope-target-registry.js';
import { applyLookupV2PolicyFamilyDecisionRegistry } from './apply-lookup-v2-policy-family-decision-registry.js';
import { refreshLookupV2StretchWritePlaneArtifacts, type LookupV2StretchWritePlaneRefreshSummary } from './refresh-lookup-v2-stretch-write-plane.js';
import { loadLookupV2BenchmarkGoldHintMapSync } from './lookup-v2-benchmark-gold-map.js';
import {
  buildLookupV2SemanticScopeTargetApprovedMap,
  buildLookupV2SemanticScopeTargetRejectedMap,
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetRegistrySync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from './lookup-v2-policy-conflict-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import {
  buildLookupV2SemanticPolicyRegistryMap,
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  loadLookupV2SemanticPolicyRegistrySync,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';
import {
  buildLookupV2SemanticScopeSupportRegistryMap,
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
  loadLookupV2SemanticScopeSupportRegistrySync,
  type LookupV2SemanticScopeSupportRegistryRow,
} from './lookup-v2-semantic-scope-support-registry.js';
import {
  buildLookupV2FamilyCollisionRegistryMap,
  DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH,
  loadLookupV2FamilyCollisionRegistrySync,
  type LookupV2FamilyCollisionRegistryRow,
} from './lookup-v2-family-collision-registry.js';
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
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

interface LookupV2StretchCoverageArtifact {
  readonly generatedAt?: string;
  readonly curationTasks?: readonly CurationTask[];
}

interface LookupV2StretchReviewedRegistryOverlayInvariants {
  readonly autoTargetableNonDecreasing: boolean;
  readonly catalogSupportReviewNonDecreasing: boolean;
  readonly reviewedCollisionDirectionRespected: boolean;
  readonly scopePolicyReviewNonIncreasing: boolean;
  readonly scopeTargetReviewNonIncreasing: boolean;
  readonly exactSafePacketNonDecreasing: boolean;
  readonly reviewedAuthorityApprovedNonDecreasing: boolean;
  readonly policyPacketNonIncreasing: boolean;
  readonly policyFamilyPacketNonIncreasing: boolean;
  readonly manualTargetFamilyPacketNonIncreasing: boolean;
}

export interface LookupV2StretchReviewedRegistryOverlaySummary {
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly workDir: string;
  readonly outputSummaryPath: string;
  readonly baselineOutputDir: string;
  readonly overlayOutputDir: string;
  readonly baseline: LookupV2StretchWritePlaneRefreshSummary;
  readonly overlay: LookupV2StretchWritePlaneRefreshSummary;
  readonly semanticScopeTargetRegistryApply: ReturnType<typeof applyLookupV2SemanticScopeTargetRegistry>;
  readonly semanticPolicyRegistryApply: ReturnType<typeof applyLookupV2PolicyFamilyDecisionRegistry>;
  readonly deltas: {
    readonly draftAutoTargetable: number;
    readonly draftCatalogSupportReview: number;
    readonly draftReviewedCollision: number;
    readonly draftScopePolicyReview: number;
    readonly draftScopeTargetReview: number;
    readonly exactSafePacketRows: number;
    readonly reviewedAuthorityApprovedRows: number;
    readonly policyReviewRows: number;
    readonly policyFamilyReviewRows: number;
    readonly manualTargetFamilyReviewRows: number;
  };
  readonly invariants: LookupV2StretchReviewedRegistryOverlayInvariants;
}

function readCoverageArtifact(inputPath: string): LookupV2StretchCoverageArtifact {
  return JSON.parse(readFileSync(inputPath, 'utf8')) as LookupV2StretchCoverageArtifact;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isManualTargetFamilyReviewPacketRow(value: unknown): value is LookupV2ManualTargetFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['normalizedBenchmarkGoldHint'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
  );
}

function isPolicyFamilyReviewPacketRow(value: unknown): value is LookupV2PolicyFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['policyConflictSurface'] === 'string'
    && typeof row['benchmarkGoldEntityId'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
  );
}

function readJsonlRows<T>(
  filePath: string | undefined,
  guard: (value: unknown) => value is T,
): readonly T[] {
  if (filePath === undefined || !existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(guard);
}

function assertInvariants(
  invariants: LookupV2StretchReviewedRegistryOverlayInvariants,
): void {
  const failures = Object.entries(invariants)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  if (failures.length > 0) {
    throw new Error(`stretch reviewed registry overlay invariant failed: ${failures.join(', ')}`);
  }
}

export async function verifyLookupV2StretchReviewedRegistryOverlay(args: {
  readonly tasks: readonly CurationTask[];
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly workDir: string;
  readonly outputSummaryPath: string;
  readonly baselineOutputDir?: string;
  readonly overlayOutputDir?: string;
  readonly familyReviewRows?: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly policyFamilyReviewRows?: readonly LookupV2PolicyFamilyReviewPacketRow[];
  readonly benchmarkGoldHintMap?: ReadonlyMap<string, string>;
  readonly baselineFamilyTargetRegistryRows?: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly baselinePolicyFamilyDecisionRegistryRows?: readonly LookupV2SemanticPolicyRegistryRow[];
  readonly baselineSemanticScopeSupportRegistryRows?: readonly LookupV2SemanticScopeSupportRegistryRow[];
  readonly baselineFamilyCollisionRegistryRows?: readonly LookupV2FamilyCollisionRegistryRow[];
  readonly existingFamilyTargetRegistryRows?: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly existingPolicyFamilyDecisionRegistryRows?: readonly LookupV2SemanticPolicyRegistryRow[];
  readonly existingSemanticScopeSupportRegistryRows?: readonly LookupV2SemanticScopeSupportRegistryRow[];
  readonly existingFamilyCollisionRegistryRows?: readonly LookupV2FamilyCollisionRegistryRow[];
  readonly exactSafeRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly exactSafeScopeRegistryMap?: ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow>;
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly knownEntityIds?: ReadonlySet<string>;
  readonly runtimeDescriptorMap?: ReadonlyMap<string, {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  }>;
  readonly policyConflictOwners?: ReadonlyMap<string, LookupPolicyConflictRegistryRow>;
}): Promise<LookupV2StretchReviewedRegistryOverlaySummary> {
  const benchmarkGoldHintMap = args.benchmarkGoldHintMap ?? loadLookupV2BenchmarkGoldHintMapSync();
  const baselineFamilyTargetRegistryRows = args.baselineFamilyTargetRegistryRows ?? args.existingFamilyTargetRegistryRows ?? [];
  const baselinePolicyFamilyDecisionRegistryRows =
    args.baselinePolicyFamilyDecisionRegistryRows ?? args.existingPolicyFamilyDecisionRegistryRows ?? [];
  const baselineSemanticScopeSupportRegistryRows =
    args.baselineSemanticScopeSupportRegistryRows ?? args.existingSemanticScopeSupportRegistryRows ?? [];
  const baselineFamilyCollisionRegistryRows =
    args.baselineFamilyCollisionRegistryRows ?? args.existingFamilyCollisionRegistryRows ?? [];
  const existingFamilyTargetRegistryRows = args.existingFamilyTargetRegistryRows ?? [];
  const existingPolicyFamilyDecisionRegistryRows = args.existingPolicyFamilyDecisionRegistryRows ?? [];
  const existingSemanticScopeSupportRegistryRows = args.existingSemanticScopeSupportRegistryRows ?? [];
  const existingFamilyCollisionRegistryRows = args.existingFamilyCollisionRegistryRows ?? [];
  const exactSafeRegistryRows = args.exactSafeRegistryRows ?? [];
  const exactSafeScopeRegistryMap = args.exactSafeScopeRegistryMap ?? new Map();
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const policyConflictOwners = args.policyConflictOwners ?? loadLookupPolicyConflictBenchmarkHintOwnerMapSync();

  const baselineOutputDir = args.baselineOutputDir ?? path.join(args.workDir, 'baseline');
  const overlayOutputDir = args.overlayOutputDir ?? path.join(args.workDir, 'overlay');
  mkdirSync(baselineOutputDir, { recursive: true });
  mkdirSync(overlayOutputDir, { recursive: true });

  const baseline = await refreshLookupV2StretchWritePlaneArtifacts({
    tasks: args.tasks,
    inputArtifact: args.inputArtifact,
    generatedAt: args.generatedAt,
    outputDir: baselineOutputDir,
    benchmarkGoldHintMap,
    familyTargetApprovedMap: buildLookupV2SemanticScopeTargetApprovedMap(baselineFamilyTargetRegistryRows),
    familyTargetRejectedMap: buildLookupV2SemanticScopeTargetRejectedMap(baselineFamilyTargetRegistryRows),
    policyConflictOwners,
    policyFamilyDecisionMap: buildLookupV2SemanticPolicyRegistryMap(baselinePolicyFamilyDecisionRegistryRows),
    semanticScopeSupportRegistryMap: buildLookupV2SemanticScopeSupportRegistryMap(baselineSemanticScopeSupportRegistryRows),
    familyCollisionRegistryMap: buildLookupV2FamilyCollisionRegistryMap(baselineFamilyCollisionRegistryRows),
    exactSafeRegistryRows,
    exactSafeScopeRegistryMap,
    runtimeOwnerEvidence,
  });

  const familyTargetRegistryApply = applyLookupV2SemanticScopeTargetRegistry({
    familyRows: args.familyReviewRows ?? [],
    existingRegistryRows: existingFamilyTargetRegistryRows,
    knownEntityIds,
    runtimeDescriptorMap: args.runtimeDescriptorMap,
  });
  if (familyTargetRegistryApply.registryConflictRows > 0) {
    throw new Error(`family-target registry overlay has registry_conflict_rows=${familyTargetRegistryApply.registryConflictRows}`);
  }

  const policyFamilyDecisionRegistryApply = applyLookupV2PolicyFamilyDecisionRegistry({
    familyRows: args.policyFamilyReviewRows ?? [],
    existingRegistryRows: existingPolicyFamilyDecisionRegistryRows,
  });
  if (policyFamilyDecisionRegistryApply.registryConflictRows > 0) {
    throw new Error(`policy-family decision registry overlay has registry_conflict_rows=${policyFamilyDecisionRegistryApply.registryConflictRows}`);
  }

  const overlay = await refreshLookupV2StretchWritePlaneArtifacts({
    tasks: args.tasks,
    inputArtifact: args.inputArtifact,
    generatedAt: args.generatedAt,
    outputDir: overlayOutputDir,
    benchmarkGoldHintMap,
    familyTargetApprovedMap: buildLookupV2SemanticScopeTargetApprovedMap(familyTargetRegistryApply.mergedRows),
    familyTargetRejectedMap: buildLookupV2SemanticScopeTargetRejectedMap(familyTargetRegistryApply.mergedRows),
    policyConflictOwners,
    policyFamilyDecisionMap: buildLookupV2SemanticPolicyRegistryMap(policyFamilyDecisionRegistryApply.mergedRows),
    semanticScopeSupportRegistryMap: buildLookupV2SemanticScopeSupportRegistryMap(existingSemanticScopeSupportRegistryRows),
    familyCollisionRegistryMap: buildLookupV2FamilyCollisionRegistryMap(existingFamilyCollisionRegistryRows),
    exactSafeRegistryRows,
    exactSafeScopeRegistryMap,
    runtimeOwnerEvidence,
  });

  const hasReviewedCollisionFamilyReview =
    (args.familyReviewRows ?? []).some((row) => row.reviewTarget === 'lookup_reviewed_collision_resolution_v1');
  const invariants: LookupV2StretchReviewedRegistryOverlayInvariants = {
    autoTargetableNonDecreasing: overlay.draft.autoTargetable >= baseline.draft.autoTargetable,
    catalogSupportReviewNonDecreasing: overlay.draft.catalogSupportReview >= baseline.draft.catalogSupportReview,
    reviewedCollisionDirectionRespected: hasReviewedCollisionFamilyReview
      ? overlay.draft.reviewedCollision <= baseline.draft.reviewedCollision
      : overlay.draft.reviewedCollision >= baseline.draft.reviewedCollision,
    scopePolicyReviewNonIncreasing: overlay.draft.scopePolicyReview <= baseline.draft.scopePolicyReview,
    scopeTargetReviewNonIncreasing: overlay.draft.scopeTargetReview <= baseline.draft.scopeTargetReview,
    exactSafePacketNonDecreasing: overlay.exactSafe.packetRows >= baseline.exactSafe.packetRows,
    reviewedAuthorityApprovedNonDecreasing:
      overlay.exactSafe.reviewedAuthorityApprovedRows >= baseline.exactSafe.reviewedAuthorityApprovedRows,
    policyPacketNonIncreasing: overlay.policy.reviewRows <= baseline.policy.reviewRows,
    policyFamilyPacketNonIncreasing: overlay.policy.familyReviewRows <= baseline.policy.familyReviewRows,
    manualTargetFamilyPacketNonIncreasing: overlay.manualTarget.familyReviewRows <= baseline.manualTarget.familyReviewRows,
  };
  assertInvariants(invariants);

  const summary: LookupV2StretchReviewedRegistryOverlaySummary = {
    inputArtifact: args.inputArtifact,
    generatedAt: args.generatedAt,
    workDir: args.workDir,
    outputSummaryPath: args.outputSummaryPath,
    baselineOutputDir,
    overlayOutputDir,
    baseline,
    overlay,
    semanticScopeTargetRegistryApply: familyTargetRegistryApply,
    semanticPolicyRegistryApply: policyFamilyDecisionRegistryApply,
    deltas: {
      draftAutoTargetable: overlay.draft.autoTargetable - baseline.draft.autoTargetable,
      draftCatalogSupportReview: overlay.draft.catalogSupportReview - baseline.draft.catalogSupportReview,
      draftReviewedCollision: overlay.draft.reviewedCollision - baseline.draft.reviewedCollision,
      draftScopePolicyReview: overlay.draft.scopePolicyReview - baseline.draft.scopePolicyReview,
      draftScopeTargetReview: overlay.draft.scopeTargetReview - baseline.draft.scopeTargetReview,
      exactSafePacketRows: overlay.exactSafe.packetRows - baseline.exactSafe.packetRows,
      reviewedAuthorityApprovedRows:
        overlay.exactSafe.reviewedAuthorityApprovedRows - baseline.exactSafe.reviewedAuthorityApprovedRows,
      policyReviewRows: overlay.policy.reviewRows - baseline.policy.reviewRows,
      policyFamilyReviewRows: overlay.policy.familyReviewRows - baseline.policy.familyReviewRows,
      manualTargetFamilyReviewRows: overlay.manualTarget.familyReviewRows - baseline.manualTarget.familyReviewRows,
    },
    invariants,
  };

  writeJson(args.outputSummaryPath, summary);
  return summary;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json' },
      familyReview: { type: 'string' },
      policyFamilyReview: { type: 'string' },
      baselineFamilyRegistry: { type: 'string' },
      baselinePolicyRegistry: { type: 'string' },
      baselineSemanticScopeSupportRegistry: { type: 'string' },
      familyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      policyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      semanticScopeSupportRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH },
      baselineFamilyCollisionRegistry: { type: 'string' },
      familyCollisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH },
      exactSafeRegistry: { type: 'string', default: DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH },
      exactSafeScopeRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH },
      workDir: { type: 'string', default: '/tmp/lookup-v2-stretch-reviewed-registry-overlay' },
      baselineOutputDir: { type: 'string' },
      overlayOutputDir: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-stretch-reviewed-registry-overlay-summary.json' },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json';
  const familyReviewPath = values.familyReview;
  const policyFamilyReviewPath = values.policyFamilyReview;
  const baselineFamilyRegistryPath = values.baselineFamilyRegistry;
  const baselinePolicyRegistryPath = values.baselinePolicyRegistry;
  const baselineSemanticScopeSupportRegistryPath = values.baselineSemanticScopeSupportRegistry;
  const baselineFamilyCollisionRegistryPath = values.baselineFamilyCollisionRegistry;
  const familyRegistryPath = values.familyRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const policyRegistryPath = values.policyRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const semanticScopeSupportRegistryPath = values.semanticScopeSupportRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH;
  const familyCollisionRegistryPath = values.familyCollisionRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH;
  const exactSafeRegistryPath = values.exactSafeRegistry ?? DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;
  const exactSafeScopeRegistryPath = values.exactSafeScopeRegistry ?? DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH;
  const workDir = values.workDir ?? '/tmp/lookup-v2-stretch-reviewed-registry-overlay';
  const baselineOutputDir = values.baselineOutputDir;
  const overlayOutputDir = values.overlayOutputDir;
  const outputPath = values.output ?? '/tmp/lookup-v2-stretch-reviewed-registry-overlay-summary.json';

  const artifact = readCoverageArtifact(inputPath);
  const familyReviewRows = readJsonlRows(familyReviewPath, isManualTargetFamilyReviewPacketRow);
  const policyFamilyReviewRows = readJsonlRows(policyFamilyReviewPath, isPolicyFamilyReviewPacketRow);

  const summary = await verifyLookupV2StretchReviewedRegistryOverlay({
    tasks: artifact.curationTasks ?? [],
    inputArtifact: inputPath,
    generatedAt: artifact.generatedAt ?? new Date().toISOString(),
    workDir,
    outputSummaryPath: outputPath,
    baselineOutputDir,
    overlayOutputDir,
    familyReviewRows,
    policyFamilyReviewRows,
    benchmarkGoldHintMap: loadLookupV2BenchmarkGoldHintMapSync(),
    baselineFamilyTargetRegistryRows: loadLookupV2SemanticScopeTargetRegistrySync(
      baselineFamilyRegistryPath ?? familyRegistryPath,
    ),
    baselinePolicyFamilyDecisionRegistryRows: loadLookupV2SemanticPolicyRegistrySync(
      baselinePolicyRegistryPath ?? policyRegistryPath,
    ),
    baselineSemanticScopeSupportRegistryRows: loadLookupV2SemanticScopeSupportRegistrySync(
      baselineSemanticScopeSupportRegistryPath ?? semanticScopeSupportRegistryPath,
    ),
    baselineFamilyCollisionRegistryRows: loadLookupV2FamilyCollisionRegistrySync(
      baselineFamilyCollisionRegistryPath ?? familyCollisionRegistryPath,
    ),
    existingFamilyTargetRegistryRows: loadLookupV2SemanticScopeTargetRegistrySync(familyRegistryPath),
    existingPolicyFamilyDecisionRegistryRows: loadLookupV2SemanticPolicyRegistrySync(policyRegistryPath),
    existingSemanticScopeSupportRegistryRows: loadLookupV2SemanticScopeSupportRegistrySync(semanticScopeSupportRegistryPath),
    existingFamilyCollisionRegistryRows: loadLookupV2FamilyCollisionRegistrySync(familyCollisionRegistryPath),
    exactSafeRegistryRows: await loadLookupExactSafeRegistry(exactSafeRegistryPath),
    exactSafeScopeRegistryMap: loadLookupV2ExactSafeScopeRegistryMapSync(exactSafeScopeRegistryPath),
    runtimeOwnerEvidence: loadLookupV2RuntimeSurfaceOwnerEvidenceSync(),
  });

  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_auto_targetable=${summary.baseline.draft.autoTargetable}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_auto_targetable=${summary.overlay.draft.autoTargetable}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_localized_surface_review=${summary.baseline.draft.localizedSurfaceReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_localized_surface_review=${summary.overlay.draft.localizedSurfaceReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_catalog_support_review=${summary.baseline.draft.catalogSupportReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_catalog_support_review=${summary.overlay.draft.catalogSupportReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_reviewed_collision=${summary.baseline.draft.reviewedCollision}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_reviewed_collision=${summary.overlay.draft.reviewedCollision}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_scope_policy_review=${summary.baseline.draft.scopePolicyReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_scope_policy_review=${summary.overlay.draft.scopePolicyReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_scope_target_review=${summary.baseline.draft.scopeTargetReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_scope_target_review=${summary.overlay.draft.scopeTargetReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] semantic_scope_registry_inserted=${summary.semanticScopeTargetRegistryApply.registryInsertedRows}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] semantic_policy_registry_inserted=${summary.semanticPolicyRegistryApply.registryInsertedRows}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] output=${summary.outputSummaryPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
