import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import {
  buildLookupV2CurationDraftRows,
  type LookupV2CurationDraftRow,
} from './export-lookup-v2-curation-drafts.js';
import {
  buildLookupExactSafeProposalPacketRows,
  type LookupExactSafeProposalPacketRow,
} from './export-lookup-v2-exact-safe-proposal-packet.js';
import { approveLookupV2ReviewedAuthorityExactSafeProposalPacket } from './approve-lookup-v2-reviewed-authority-exact-safe-proposal-packet.js';
import {
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
  loadLookupV2BenchmarkGoldHintMapSync,
} from './lookup-v2-benchmark-gold-map.js';
import type { LookupV2FamilyTargetRegistryRow } from './lookup-v2-family-target-registry.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetApprovedMapSync,
} from './lookup-v2-family-target-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import {
  loadLookupPolicyConflictBenchmarkHintOwnerMapSync,
} from './lookup-v2-policy-conflict-registry.js';
import type { LookupV2PolicyFamilyDecisionRegistryRow } from './lookup-v2-policy-family-decision-registry.js';
import {
  DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  loadLookupV2PolicyFamilyDecisionMapSync,
} from './lookup-v2-policy-family-decision-registry.js';
import type { LookupExactSafeRegistryRow } from '../etl/lookup-exact-safe-registry.js';
import {
  DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
  loadLookupExactSafeRegistry,
} from '../etl/lookup-exact-safe-registry.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import {
  loadLookupV2RuntimeSurfaceOwnerEvidenceSync,
} from './lookup-v2-runtime-surface-owner-evidence.js';

interface LookupV2StretchCoverageArtifact {
  readonly generatedAt?: string;
  readonly curationTasks?: readonly CurationTask[];
}

interface LookupV2StretchWritePlaneOutputPaths {
  readonly draft: string;
  readonly exactSafePacket: string;
  readonly reviewedAuthorityApprovedExactSafePacket: string;
  readonly exactSafeFamilyReviewPacket: string;
  readonly exactSafeFamilySuggestions: string;
  readonly exactSafeFamilySuggestedDecisions: string;
  readonly policyReviewPacket: string;
  readonly policyFamilyReviewPacket: string;
  readonly policyFamilySuggestions: string;
  readonly policyFamilySuggestedDecisions: string;
  readonly manualTargetFamilyReviewPacket: string;
  readonly manualTargetFamilySuggestions: string;
  readonly manualTargetFamilySuggestedDecisions: string;
  readonly manualTargetBatchDir: string;
  readonly summary: string;
}

export interface LookupV2StretchWritePlaneRefreshSummary {
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly outputPaths: LookupV2StretchWritePlaneOutputPaths;
  readonly draft: {
    readonly rows: number;
    readonly autoTargetable: number;
    readonly policyReview: number;
    readonly manualTarget: number;
  };
  readonly exactSafe: {
    readonly packetRows: number;
    readonly approvedRows: number;
    readonly pendingRows: number;
    readonly bySource: Record<string, number>;
    readonly familyReviewRows: number;
    readonly familySuggestions: {
      readonly suggestApprove: number;
      readonly manualReview: number;
    };
  };
  readonly policy: {
    readonly reviewRows: number;
    readonly familyReviewRows: number;
    readonly suggestions: {
      readonly keepPolicyConflict: number;
      readonly manualReview: number;
    };
  };
  readonly manualTarget: {
    readonly batchIndex: LookupV2ManualTargetBatchIndex;
    readonly familyReviewRows: number;
    readonly suggestions: {
      readonly candidateUniqueOwner: number;
      readonly collisionCandidates: number;
      readonly missingRuntimeOwner: number;
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
    exactSafeFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl'),
    exactSafeFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl'),
    exactSafeFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl'),
    policyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl'),
    policyFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl'),
    policyFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl'),
    policyFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl'),
    manualTargetFamilyReviewPacket: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl'),
    manualTargetFamilySuggestions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl'),
    manualTargetFamilySuggestedDecisions: path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl'),
    manualTargetBatchDir: path.join(outputDir, 'manual-target-batches'),
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

export async function refreshLookupV2StretchWritePlaneArtifacts(args: {
  readonly tasks: readonly CurationTask[];
  readonly inputArtifact: string;
  readonly generatedAt: string;
  readonly outputDir: string;
  readonly benchmarkGoldHintMap?: ReadonlyMap<string, string>;
  readonly familyTargetApprovedMap?: ReadonlyMap<string, LookupV2FamilyTargetRegistryRow>;
  readonly policyConflictOwners?: ReadonlyMap<string, LookupPolicyConflictRegistryRow>;
  readonly policyFamilyDecisionMap?: ReadonlyMap<string, LookupV2PolicyFamilyDecisionRegistryRow>;
  readonly exactSafeRegistryRows?: readonly LookupExactSafeRegistryRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
}): Promise<LookupV2StretchWritePlaneRefreshSummary> {
  const outputPaths = buildOutputPaths(args.outputDir);
  const draftRows = buildLookupV2CurationDraftRows(
    args.tasks,
    args.inputArtifact,
    args.generatedAt,
    args.benchmarkGoldHintMap,
    args.familyTargetApprovedMap,
    args.policyConflictOwners,
    args.policyFamilyDecisionMap,
  );
  writeJsonl(outputPaths.draft, draftRows);

  const exactSafeRegistryRows = args.exactSafeRegistryRows ?? [];
  const exactSafePacketRows = buildLookupExactSafeProposalPacketRows({
    draftRows,
    existingRegistryRows: exactSafeRegistryRows,
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

  const exactSafeFamilyReviewRows = buildLookupV2ExactSafeFamilyReviewPacketRows({
    packetRows: exactSafePacketRows,
  });
  writeJsonl(outputPaths.exactSafeFamilyReviewPacket, exactSafeFamilyReviewRows);
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
  });
  writeJsonl(outputPaths.manualTargetFamilyReviewPacket, manualTargetFamilyReviewRows);
  const manualTargetFamilySuggestionRows = buildLookupV2ManualTargetFamilySuggestions(
    manualTargetFamilyReviewRows,
    runtimeOwnerEvidence,
  );
  writeJsonl(outputPaths.manualTargetFamilySuggestions, manualTargetFamilySuggestionRows);
  const manualTargetSuggestedDecisionRows = buildLookupV2ManualTargetSuggestedDecisionRows(manualTargetFamilySuggestionRows);
  writeJsonl(outputPaths.manualTargetFamilySuggestedDecisions, manualTargetSuggestedDecisionRows);

  const summary: LookupV2StretchWritePlaneRefreshSummary = {
    inputArtifact: args.inputArtifact,
    generatedAt: args.generatedAt,
    outputPaths,
    draft: {
      rows: draftRows.length,
      autoTargetable: draftRows.filter((row) => row.triageBucket === 'auto_targetable').length,
      policyReview: draftRows.filter((row) => row.triageBucket === 'policy_review').length,
      manualTarget: draftRows.filter((row) => row.triageBucket === 'manual_target').length,
    },
    exactSafe: {
      packetRows: exactSafePacketRows.length,
      approvedRows: reviewedAuthorityApprovedExactSafePacketRows.filter((row) => row.proposalStatus === 'approved').length,
      pendingRows: reviewedAuthorityApprovedExactSafePacketRows.filter((row) => row.proposalStatus === 'needs_review').length,
      bySource: countBy(exactSafePacketRows, (row) => row.benchmarkGoldEntityIdSource),
      familyReviewRows: exactSafeFamilyReviewRows.length,
      familySuggestions: {
        suggestApprove: exactSafeFamilySuggestionRows.filter((row) => row.suggestionStatus === 'suggest_approve').length,
        manualReview: exactSafeFamilySuggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length,
      },
    },
    policy: {
      reviewRows: policyReviewRows.length,
      familyReviewRows: policyFamilyReviewRows.length,
      suggestions: {
        keepPolicyConflict: policyFamilySuggestionRows.filter((row) => row.suggestionStatus === 'suggest_keep_policy_conflict').length,
        manualReview: policyFamilySuggestionRows.filter((row) => row.suggestionStatus === 'manual_review').length,
      },
    },
    manualTarget: {
      batchIndex: manualTargetBatchIndex,
      familyReviewRows: manualTargetFamilyReviewRows.length,
      suggestions: {
        candidateUniqueOwner: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'candidate_unique_owner').length,
        collisionCandidates: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'collision_candidates').length,
        missingRuntimeOwner: manualTargetFamilySuggestionRows.filter((row) => row.suggestionStatus === 'missing_runtime_owner').length,
      },
    },
  };

  writeFileSync(outputPaths.summary, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json' },
      outputDir: { type: 'string', default: 'data/lookup-v2/drafts' },
      familyTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      policyFamilyDecisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH },
      exactSafeRegistry: { type: 'string', default: DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json';
  const outputDir = values.outputDir ?? 'data/lookup-v2/drafts';
  const familyTargetRegistryPath = values.familyTargetRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH;
  const policyFamilyDecisionRegistryPath = values.policyFamilyDecisionRegistry ?? DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH;
  const exactSafeRegistryPath = values.exactSafeRegistry ?? DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;

  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as LookupV2StretchCoverageArtifact;
  const summary = await refreshLookupV2StretchWritePlaneArtifacts({
    tasks: parsed.curationTasks ?? [],
    inputArtifact: inputPath,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    outputDir,
    benchmarkGoldHintMap: loadLookupV2BenchmarkGoldHintMapSync(),
    familyTargetApprovedMap: loadLookupV2FamilyTargetApprovedMapSync(familyTargetRegistryPath),
    policyConflictOwners: loadLookupPolicyConflictBenchmarkHintOwnerMapSync(),
    policyFamilyDecisionMap: loadLookupV2PolicyFamilyDecisionMapSync(policyFamilyDecisionRegistryPath),
    exactSafeRegistryRows: await loadLookupExactSafeRegistry(exactSafeRegistryPath),
    runtimeOwnerEvidence: loadLookupV2RuntimeSurfaceOwnerEvidenceSync(),
  });

  console.log(`[elv2-stretch-write-plane-refresh] draft_rows=${summary.draft.rows}`);
  console.log(`[elv2-stretch-write-plane-refresh] auto_targetable=${summary.draft.autoTargetable}`);
  console.log(`[elv2-stretch-write-plane-refresh] policy_review=${summary.draft.policyReview}`);
  console.log(`[elv2-stretch-write-plane-refresh] manual_target=${summary.draft.manualTarget}`);
  console.log(`[elv2-stretch-write-plane-refresh] exact_safe_packet_rows=${summary.exactSafe.packetRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] reviewed_authority_approved_rows=${summary.exactSafe.approvedRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] policy_family_rows=${summary.policy.familyReviewRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] manual_target_family_rows=${summary.manualTarget.familyReviewRows}`);
  console.log(`[elv2-stretch-write-plane-refresh] summary=${summary.outputPaths.summary}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
