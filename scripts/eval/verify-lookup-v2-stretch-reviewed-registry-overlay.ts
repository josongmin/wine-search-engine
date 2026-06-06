import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2PolicyFamilyReviewPacketRow } from './export-lookup-v2-policy-family-review-packet.js';
import { applyLookupV2FamilyTargetRegistry } from './apply-lookup-v2-family-target-registry.js';
import { applyLookupV2PolicyFamilyDecisionRegistry } from './apply-lookup-v2-policy-family-decision-registry.js';
import { refreshLookupV2StretchWritePlaneArtifacts, type LookupV2StretchWritePlaneRefreshSummary } from './refresh-lookup-v2-stretch-write-plane.js';
import { loadLookupV2BenchmarkGoldHintMapSync } from './lookup-v2-benchmark-gold-map.js';
import {
  buildLookupV2FamilyTargetApprovedMap,
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetRegistrySync,
  type LookupV2FamilyTargetRegistryRow,
} from './lookup-v2-family-target-registry.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from './lookup-v2-policy-conflict-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import {
  buildLookupV2PolicyFamilyDecisionMap,
  DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  loadLookupV2PolicyFamilyDecisionRegistrySync,
  type LookupV2PolicyFamilyDecisionRegistryRow,
} from './lookup-v2-policy-family-decision-registry.js';
import type { LookupExactSafeRegistryRow } from '../etl/lookup-exact-safe-registry.js';
import {
  DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
  loadLookupExactSafeRegistry,
} from '../etl/lookup-exact-safe-registry.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

interface LookupV2StretchCoverageArtifact {
  readonly generatedAt?: string;
  readonly curationTasks?: readonly CurationTask[];
}

interface LookupV2StretchReviewedRegistryOverlayInvariants {
  readonly autoTargetableNonDecreasing: boolean;
  readonly policyReviewNonIncreasing: boolean;
  readonly manualTargetNonIncreasing: boolean;
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
  readonly familyTargetRegistryApply: ReturnType<typeof applyLookupV2FamilyTargetRegistry>;
  readonly policyFamilyDecisionRegistryApply: ReturnType<typeof applyLookupV2PolicyFamilyDecisionRegistry>;
  readonly deltas: {
    readonly draftAutoTargetable: number;
    readonly draftPolicyReview: number;
    readonly draftManualTarget: number;
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
  readonly baselineFamilyTargetRegistryRows?: readonly LookupV2FamilyTargetRegistryRow[];
  readonly baselinePolicyFamilyDecisionRegistryRows?: readonly LookupV2PolicyFamilyDecisionRegistryRow[];
  readonly existingFamilyTargetRegistryRows?: readonly LookupV2FamilyTargetRegistryRow[];
  readonly existingPolicyFamilyDecisionRegistryRows?: readonly LookupV2PolicyFamilyDecisionRegistryRow[];
  readonly exactSafeRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly knownEntityIds?: ReadonlySet<string>;
  readonly policyConflictOwners?: ReadonlyMap<string, LookupPolicyConflictRegistryRow>;
}): Promise<LookupV2StretchReviewedRegistryOverlaySummary> {
  const benchmarkGoldHintMap = args.benchmarkGoldHintMap ?? loadLookupV2BenchmarkGoldHintMapSync();
  const baselineFamilyTargetRegistryRows = args.baselineFamilyTargetRegistryRows ?? args.existingFamilyTargetRegistryRows ?? [];
  const baselinePolicyFamilyDecisionRegistryRows =
    args.baselinePolicyFamilyDecisionRegistryRows ?? args.existingPolicyFamilyDecisionRegistryRows ?? [];
  const existingFamilyTargetRegistryRows = args.existingFamilyTargetRegistryRows ?? [];
  const existingPolicyFamilyDecisionRegistryRows = args.existingPolicyFamilyDecisionRegistryRows ?? [];
  const exactSafeRegistryRows = args.exactSafeRegistryRows ?? [];
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
    familyTargetApprovedMap: buildLookupV2FamilyTargetApprovedMap(baselineFamilyTargetRegistryRows),
    policyConflictOwners,
    policyFamilyDecisionMap: buildLookupV2PolicyFamilyDecisionMap(baselinePolicyFamilyDecisionRegistryRows),
    exactSafeRegistryRows,
    runtimeOwnerEvidence,
  });

  const familyTargetRegistryApply = applyLookupV2FamilyTargetRegistry({
    familyRows: args.familyReviewRows ?? [],
    existingRegistryRows: existingFamilyTargetRegistryRows,
    knownEntityIds,
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
    familyTargetApprovedMap: buildLookupV2FamilyTargetApprovedMap(familyTargetRegistryApply.mergedRows),
    policyConflictOwners,
    policyFamilyDecisionMap: buildLookupV2PolicyFamilyDecisionMap(policyFamilyDecisionRegistryApply.mergedRows),
    exactSafeRegistryRows,
    runtimeOwnerEvidence,
  });

  const invariants: LookupV2StretchReviewedRegistryOverlayInvariants = {
    autoTargetableNonDecreasing: overlay.draft.autoTargetable >= baseline.draft.autoTargetable,
    policyReviewNonIncreasing: overlay.draft.policyReview <= baseline.draft.policyReview,
    manualTargetNonIncreasing: overlay.draft.manualTarget <= baseline.draft.manualTarget,
    exactSafePacketNonDecreasing: overlay.exactSafe.packetRows >= baseline.exactSafe.packetRows,
    reviewedAuthorityApprovedNonDecreasing: overlay.exactSafe.approvedRows >= baseline.exactSafe.approvedRows,
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
    familyTargetRegistryApply,
    policyFamilyDecisionRegistryApply,
    deltas: {
      draftAutoTargetable: overlay.draft.autoTargetable - baseline.draft.autoTargetable,
      draftPolicyReview: overlay.draft.policyReview - baseline.draft.policyReview,
      draftManualTarget: overlay.draft.manualTarget - baseline.draft.manualTarget,
      exactSafePacketRows: overlay.exactSafe.packetRows - baseline.exactSafe.packetRows,
      reviewedAuthorityApprovedRows: overlay.exactSafe.approvedRows - baseline.exactSafe.approvedRows,
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
      familyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      policyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH },
      exactSafeRegistry: { type: 'string', default: DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH },
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
  const familyRegistryPath = values.familyRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH;
  const policyRegistryPath = values.policyRegistry ?? DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH;
  const exactSafeRegistryPath = values.exactSafeRegistry ?? DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;
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
    baselineFamilyTargetRegistryRows: loadLookupV2FamilyTargetRegistrySync(
      baselineFamilyRegistryPath ?? familyRegistryPath,
    ),
    baselinePolicyFamilyDecisionRegistryRows: loadLookupV2PolicyFamilyDecisionRegistrySync(
      baselinePolicyRegistryPath ?? policyRegistryPath,
    ),
    existingFamilyTargetRegistryRows: loadLookupV2FamilyTargetRegistrySync(familyRegistryPath),
    existingPolicyFamilyDecisionRegistryRows: loadLookupV2PolicyFamilyDecisionRegistrySync(policyRegistryPath),
    exactSafeRegistryRows: await loadLookupExactSafeRegistry(exactSafeRegistryPath),
    runtimeOwnerEvidence: loadLookupV2RuntimeSurfaceOwnerEvidenceSync(),
  });

  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_auto_targetable=${summary.baseline.draft.autoTargetable}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_auto_targetable=${summary.overlay.draft.autoTargetable}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_policy_review=${summary.baseline.draft.policyReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_policy_review=${summary.overlay.draft.policyReview}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] baseline_manual_target=${summary.baseline.draft.manualTarget}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] overlay_manual_target=${summary.overlay.draft.manualTarget}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] family_registry_inserted=${summary.familyTargetRegistryApply.registryInsertedRows}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] policy_registry_inserted=${summary.policyFamilyDecisionRegistryApply.registryInsertedRows}`);
  console.log(`[elv2-reviewed-registry-overlay-verify] output=${summary.outputSummaryPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
