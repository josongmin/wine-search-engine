import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2BenchmarkGoldHintMapSync } from './lookup-v2-benchmark-gold-map.js';
import type { LookupV2FamilyTargetRegistryRow } from './lookup-v2-family-target-registry.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetApprovedMapSync,
} from './lookup-v2-family-target-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from './lookup-v2-policy-conflict-registry.js';
import type { LookupV2PolicyFamilyDecisionRegistryRow } from './lookup-v2-policy-family-decision-registry.js';
import {
  buildLookupV2PolicyFamilyDecisionKey,
  DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  loadLookupV2PolicyFamilyDecisionMapSync,
} from './lookup-v2-policy-family-decision-registry.js';

export interface LookupV2CurationDraftRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly suggestedAliasType: CurationTask['suggestedAliasType'];
  readonly holeClass: string;
  readonly observedStatus: string;
  readonly benchmarkGoldHint?: string | undefined;
  readonly benchmarkGoldEntityId?: string | undefined;
  readonly benchmarkGoldEntityIdSource?: 'fixture_exact' | 'policy_registry_authority' | 'family_target_registry' | 'policy_family_decision_registry' | undefined;
  readonly benchmarkGoldEntityIdSuggestion?: string | undefined;
  readonly benchmarkGoldEntityIdSuggestionSource?: 'hint_resolution' | undefined;
  readonly triageBucket: 'auto_targetable' | 'policy_review' | 'manual_target';
  readonly policyConflictHint?: string | undefined;
  readonly sourceArtifact: string;
  readonly sourceEvidence: string;
  readonly reviewedAt: string;
}

export function inferDraftLocale(surface: string): 'ko' | 'global' {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u.test(surface) ? 'ko' : 'global';
}

export function buildLookupV2CurationDraftRows(
  tasks: readonly CurationTask[],
  sourceArtifact: string,
  reviewedAt: string,
  benchmarkGoldHintMap: ReadonlyMap<string, string> = loadLookupV2BenchmarkGoldHintMapSync(),
  familyTargetRegistryApprovedMap: ReadonlyMap<string, LookupV2FamilyTargetRegistryRow> = loadLookupV2FamilyTargetApprovedMapSync(),
  policyConflictBenchmarkOwners: ReadonlyMap<string, LookupPolicyConflictRegistryRow> = loadLookupPolicyConflictBenchmarkHintOwnerMapSync(),
  policyFamilyDecisionMap: ReadonlyMap<string, LookupV2PolicyFamilyDecisionRegistryRow> = loadLookupV2PolicyFamilyDecisionMapSync(),
): readonly LookupV2CurationDraftRow[] {
  return tasks.flatMap((task) => {
    const normalizedBenchmarkHint = task.benchmarkGoldHint !== undefined
      ? normalizeForMatch(task.benchmarkGoldHint)
      : undefined;
    const familyTargetRegistryRow = normalizedBenchmarkHint !== undefined
      ? familyTargetRegistryApprovedMap.get(normalizedBenchmarkHint)
      : undefined;
    const policyConflictOwner = normalizedBenchmarkHint !== undefined
      ? policyConflictBenchmarkOwners.get(normalizedBenchmarkHint)
      : undefined;
    const policyFamilyDecision = policyConflictOwner !== undefined
      ? policyFamilyDecisionMap.get(
          buildLookupV2PolicyFamilyDecisionKey(
            policyConflictOwner.surface,
            policyConflictOwner.authorityEntityId,
          ),
        )
      : undefined;
    const hintResolvedEntityId = normalizedBenchmarkHint !== undefined
      ? benchmarkGoldHintMap.get(normalizedBenchmarkHint)
      : undefined;
    const policyPromotedEntityId = policyFamilyDecision?.decision === 'promote_exact_safe'
      ? policyFamilyDecision.entityId
      : undefined;
    const isPendingPolicyReview = policyConflictOwner !== undefined && policyFamilyDecision === undefined;
    const reviewedAuthorityEntityId = task.benchmarkGoldEntityId
      ?? familyTargetRegistryRow?.entityId
      ?? policyPromotedEntityId;
    const rowBenchmarkGoldEntityId = isPendingPolicyReview
      ? policyConflictOwner?.authorityEntityId
      : reviewedAuthorityEntityId;
    const benchmarkGoldEntityIdSource = task.benchmarkGoldEntityId !== undefined
      ? 'fixture_exact'
      : familyTargetRegistryRow?.entityId !== undefined
        ? 'family_target_registry'
        : policyPromotedEntityId !== undefined
          ? 'policy_family_decision_registry'
          : policyConflictOwner?.authorityEntityId !== undefined
            ? 'policy_registry_authority'
            : undefined;
    const benchmarkGoldEntityIdSuggestion = task.benchmarkGoldEntityId === undefined
      && hintResolvedEntityId !== undefined
      && hintResolvedEntityId !== rowBenchmarkGoldEntityId
      ? hintResolvedEntityId
      : undefined;
    if (policyFamilyDecision?.decision === 'keep_policy_conflict' || policyFamilyDecision?.decision === 'needs_target') {
      return [];
    }
    const triageBucket = isPendingPolicyReview
      ? 'policy_review'
      : reviewedAuthorityEntityId !== undefined
        ? 'auto_targetable'
        : 'manual_target';
    return [{
      surface: task.surfaceForm,
      locale: inferDraftLocale(task.surfaceForm),
      suggestedAliasType: task.suggestedAliasType,
      holeClass: task.holeClass,
      observedStatus: task.observedStatus,
      ...(task.benchmarkGoldHint !== undefined ? { benchmarkGoldHint: task.benchmarkGoldHint } : {}),
      ...(rowBenchmarkGoldEntityId !== undefined
        ? { benchmarkGoldEntityId: rowBenchmarkGoldEntityId }
        : {}),
      ...(benchmarkGoldEntityIdSource !== undefined ? { benchmarkGoldEntityIdSource } : {}),
      ...(benchmarkGoldEntityIdSuggestion !== undefined ? { benchmarkGoldEntityIdSuggestion } : {}),
      ...(benchmarkGoldEntityIdSuggestion !== undefined ? { benchmarkGoldEntityIdSuggestionSource: 'hint_resolution' as const } : {}),
      triageBucket,
      ...(isPendingPolicyReview && task.benchmarkGoldHint !== undefined ? { policyConflictHint: task.benchmarkGoldHint } : {}),
      sourceArtifact,
      sourceEvidence: task.reason,
      reviewedAt,
    }];
  });
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-curation-draft.jsonl' },
      familyTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      policyFamilyDecisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-curation-draft.jsonl';
  const familyTargetRegistryPath = values.familyTargetRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH;
  const policyFamilyDecisionRegistryPath = values.policyFamilyDecisionRegistry ?? DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH;
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as {
    generatedAt?: string;
    curationTasks?: readonly CurationTask[];
  };
  const tasks = parsed.curationTasks ?? [];
  const reviewedAt = parsed.generatedAt ?? new Date().toISOString();
  const rows = buildLookupV2CurationDraftRows(
    tasks,
    inputPath,
    reviewedAt,
    undefined,
    loadLookupV2FamilyTargetApprovedMapSync(familyTargetRegistryPath),
    undefined,
    loadLookupV2PolicyFamilyDecisionMapSync(policyFamilyDecisionRegistryPath),
  );
  const autoTargetable = rows.filter((row) => row.triageBucket === 'auto_targetable').length;
  const policyReview = rows.filter((row) => row.triageBucket === 'policy_review').length;

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-curation-draft] tasks=${tasks.length}`);
  console.log(`[elv2-curation-draft] rows=${rows.length}`);
  console.log(`[elv2-curation-draft] auto_targetable=${autoTargetable}`);
  console.log(`[elv2-curation-draft] policy_review=${policyReview}`);
  console.log(`[elv2-curation-draft] manual_target=${rows.length - autoTargetable - policyReview}`);
  console.log(`[elv2-curation-draft] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
