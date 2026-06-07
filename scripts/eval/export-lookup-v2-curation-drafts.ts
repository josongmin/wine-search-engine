import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CurationTask } from '../../src/domain/alias/curation/coverage-curation-task.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  buildLookupQuerySemanticProbe,
  buildLookupSemanticConflictKey,
  buildLookupSemanticScopeFromProbe,
  buildLookupSemanticScopeKey,
} from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { loadLookupV2BenchmarkGoldHintMapSync } from './lookup-v2-benchmark-gold-map.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetApprovedMapSync,
  loadLookupV2SemanticScopeTargetRejectedMapSync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import type { LookupPolicyConflictRegistryRow } from './lookup-v2-policy-conflict-registry.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from './lookup-v2-policy-conflict-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  buildLookupV2SemanticPolicyRegistryKey,
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
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from './lookup-v2-runtime-semantic-descriptors.js';

export interface LookupV2CurationDraftRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly suggestedAliasType: CurationTask['suggestedAliasType'];
  readonly holeClass: string;
  readonly observedStatus: string;
  readonly benchmarkGoldHint?: string | undefined;
  readonly semanticScopeKey: string;
  readonly scopeAxis: 'family' | 'line';
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
  readonly surfaceFormKind: 'bare' | 'qualified' | 'compact' | 'mixed_script';
  readonly benchmarkGoldEntityId?: string | undefined;
  readonly benchmarkGoldEntityIdSource?:
    | 'fixture_exact'
    | 'policy_registry_authority'
    | 'semantic_scope_target_registry'
    | 'semantic_policy_registry'
    | undefined;
  readonly benchmarkGoldEntityIdSuggestion?: string | undefined;
  readonly benchmarkGoldEntityIdSuggestionSource?: 'hint_resolution' | undefined;
  readonly triageBucket:
    | 'auto_targetable'
    | 'scope_policy_review'
    | 'localized_surface_review'
    | 'scope_target_review'
    | 'reviewed_rejected'
    | 'catalog_support_review'
    | 'reviewed_collision';
  readonly operatorBucket?:
    | 'strict_collision_ambiguous'
    | 'family_surface_gap'
    | 'qualified_scope_surface_gap'
    | 'scope_target_missing'
    | 'scope_support_needed'
    | undefined;
  readonly policyConflictHint?: string | undefined;
  readonly semanticConflictKey?: string | undefined;
  readonly supportStatus?: LookupV2SemanticScopeSupportRegistryRow['supportStatus'] | undefined;
  readonly collisionStatus?: LookupV2FamilyCollisionRegistryRow['collisionStatus'] | undefined;
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
  semanticScopeTargetApprovedMap: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> = loadLookupV2SemanticScopeTargetApprovedMapSync(),
  semanticScopeTargetRejectedMap: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> = loadLookupV2SemanticScopeTargetRejectedMapSync(),
  policyConflictBenchmarkOwners: ReadonlyMap<string, LookupPolicyConflictRegistryRow> = loadLookupPolicyConflictBenchmarkHintOwnerMapSync(),
  semanticPolicyMap: ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow> = loadLookupV2SemanticPolicyRegistryMapSync(),
  semanticScopeSupportRegistryMap: ReadonlyMap<string, LookupV2SemanticScopeSupportRegistryRow> = loadLookupV2SemanticScopeSupportRegistryMapSync(),
  familyCollisionRegistryMap: ReadonlyMap<string, LookupV2FamilyCollisionRegistryRow> = loadLookupV2FamilyCollisionRegistryMapSync(),
): readonly LookupV2CurationDraftRow[] {
  const runtimeDescriptorMap = loadLookupV2RuntimeSemanticDescriptorMapSync();
  return tasks.flatMap((task) => {
    const locale = inferDraftLocale(task.surfaceForm);
    const queryProbe = buildLookupQuerySemanticProbe({
      query: task.surfaceForm,
      locale,
    });
    const normalizedBenchmarkHint = task.benchmarkGoldHint !== undefined
      ? normalizeForMatch(task.benchmarkGoldHint)
      : undefined;
    const policyConflictOwner = normalizedBenchmarkHint !== undefined
      ? policyConflictBenchmarkOwners.get(normalizedBenchmarkHint)
      : undefined;
    const hintResolvedEntityId = normalizedBenchmarkHint !== undefined
      ? benchmarkGoldHintMap.get(normalizedBenchmarkHint)
      : undefined;
    const familyCollisionRegistryRow = normalizedBenchmarkHint !== undefined
      ? familyCollisionRegistryMap.get(normalizedBenchmarkHint)
      : undefined;
    const descriptorEntityId = task.benchmarkGoldEntityId
      ?? hintResolvedEntityId
      ?? policyConflictOwner?.authorityEntityId;
    const fallbackScope = (() => {
      const scope = {
        scopeAxis: queryProbe.vintage !== undefined ? 'line' as const : 'family' as const,
        familyKey: normalizedBenchmarkHint ?? normalizeForMatch(task.surfaceForm),
        ...(queryProbe.vintage !== undefined ? { vintage: queryProbe.vintage } : {}),
        surfaceFormKind:
          queryProbe.isMixedScript
            ? 'mixed_script' as const
            : queryProbe.isCompactish
              ? 'compact' as const
              : queryProbe.vintage !== undefined
                ? 'qualified' as const
                : 'bare' as const,
        locale,
      };
      return {
        ...scope,
        semanticScopeKey: buildLookupSemanticScopeKey(scope),
      };
    })();
    const derivedScope = descriptorEntityId !== undefined
      ? runtimeDescriptorMap.get(descriptorEntityId)
      : undefined;
    const baselineScope = derivedScope !== undefined
      ? buildLookupSemanticScopeFromProbe({
          probe: queryProbe,
          descriptor: derivedScope,
        })
      : fallbackScope;
    const approvedSemanticTarget = semanticScopeTargetApprovedMap.get(baselineScope.semanticScopeKey);
    const rejectedSemanticTarget = semanticScopeTargetRejectedMap.get(baselineScope.semanticScopeKey);
    const semanticScopeSupportRegistryRow = semanticScopeSupportRegistryMap.get(baselineScope.semanticScopeKey);
    const semanticConflictKey = policyConflictOwner !== undefined
      ? buildLookupSemanticConflictKey({
          scopeAxis: baselineScope.scopeAxis,
          familyKey: baselineScope.familyKey,
          ...(baselineScope.lineKey !== undefined ? { lineKey: baselineScope.lineKey } : {}),
          ...(baselineScope.regionKey !== undefined ? { regionKey: baselineScope.regionKey } : {}),
          ...(baselineScope.appellationKey !== undefined ? { appellationKey: baselineScope.appellationKey } : {}),
          ...(baselineScope.vintage !== undefined ? { vintage: baselineScope.vintage } : {}),
          surfaceFormKind: baselineScope.surfaceFormKind,
          locale: baselineScope.locale,
        })
      : undefined;
    const semanticPolicyDecision = policyConflictOwner !== undefined && semanticConflictKey !== undefined
      ? semanticPolicyMap.get(
          buildLookupV2SemanticPolicyRegistryKey(
            semanticConflictKey,
            policyConflictOwner.authorityEntityId,
          ),
        )
      : undefined;
    const policyPromotedEntityId = semanticPolicyDecision?.decision === 'promote_exact_safe'
      ? semanticPolicyDecision.entityId
      : undefined;
    const isPendingPolicyReview = policyConflictOwner !== undefined && semanticPolicyDecision === undefined;
    const reviewedAuthorityEntityId = task.benchmarkGoldEntityId
      ?? approvedSemanticTarget?.entityId
      ?? policyPromotedEntityId;
    const rowBenchmarkGoldEntityId = isPendingPolicyReview
      ? policyConflictOwner?.authorityEntityId
      : reviewedAuthorityEntityId;
    const benchmarkGoldEntityIdSource = task.benchmarkGoldEntityId !== undefined
      ? 'fixture_exact'
      : approvedSemanticTarget?.entityId !== undefined
        ? 'semantic_scope_target_registry'
      : policyPromotedEntityId !== undefined
          ? 'semantic_policy_registry'
          : policyConflictOwner?.authorityEntityId !== undefined
            ? 'policy_registry_authority'
            : undefined;
    const benchmarkGoldEntityIdSuggestion = task.benchmarkGoldEntityId === undefined
      && hintResolvedEntityId !== undefined
      && hintResolvedEntityId !== rowBenchmarkGoldEntityId
      ? hintResolvedEntityId
      : undefined;
    const allowsCollisionScopedReviewedAuthority =
      benchmarkGoldEntityIdSource === 'semantic_scope_target_registry'
      || benchmarkGoldEntityIdSource === 'fixture_exact';
    if (semanticScopeSupportRegistryRow !== undefined && rowBenchmarkGoldEntityId !== undefined) {
      throw new Error(
        `scope_support semantic scope support conflicts with reviewed authority for semanticScopeKey=${JSON.stringify(baselineScope.semanticScopeKey)}`,
      );
    }
    if (
      familyCollisionRegistryRow !== undefined
      && rowBenchmarkGoldEntityId !== undefined
      && !allowsCollisionScopedReviewedAuthority
    ) {
      throw new Error(
        `reviewed_collision family collision conflicts with reviewed authority for benchmarkGoldHint=${JSON.stringify(task.benchmarkGoldHint)}`,
      );
    }
    if (familyCollisionRegistryRow !== undefined && semanticScopeSupportRegistryRow !== undefined) {
      throw new Error(
        `reviewed_collision family collision conflicts with semantic scope support for semanticScopeKey=${JSON.stringify(baselineScope.semanticScopeKey)}`,
      );
    }
    if (semanticPolicyDecision?.decision === 'keep_ambiguous' || semanticPolicyDecision?.decision === 'needs_scope_target') {
      return [];
    }
    const triageBucket = rejectedSemanticTarget !== undefined
      ? 'reviewed_rejected'
      : semanticScopeSupportRegistryRow !== undefined
        ? 'catalog_support_review'
      : isPendingPolicyReview
        ? 'scope_policy_review'
        : reviewedAuthorityEntityId !== undefined
          ? 'auto_targetable'
      : familyCollisionRegistryRow?.collisionStatus === 'active_entity_collision'
        ? 'reviewed_collision'
        : task.operatorBucket === 'family_surface_gap' || task.operatorBucket === 'qualified_scope_surface_gap'
          ? 'localized_surface_review'
          : 'scope_target_review';
    return [{
      surface: task.surfaceForm,
      locale,
      suggestedAliasType: task.suggestedAliasType,
      holeClass: task.holeClass,
      observedStatus: task.observedStatus,
      ...(task.benchmarkGoldHint !== undefined ? { benchmarkGoldHint: task.benchmarkGoldHint } : {}),
      semanticScopeKey: baselineScope.semanticScopeKey,
      scopeAxis: baselineScope.scopeAxis,
      familyKey: baselineScope.familyKey,
      ...(baselineScope.lineKey !== undefined ? { lineKey: baselineScope.lineKey } : {}),
      ...(baselineScope.regionKey !== undefined ? { regionKey: baselineScope.regionKey } : {}),
      ...(baselineScope.appellationKey !== undefined ? { appellationKey: baselineScope.appellationKey } : {}),
      ...(baselineScope.vintage !== undefined ? { vintage: baselineScope.vintage } : {}),
      surfaceFormKind: baselineScope.surfaceFormKind,
      ...(rowBenchmarkGoldEntityId !== undefined
        ? { benchmarkGoldEntityId: rowBenchmarkGoldEntityId }
        : {}),
      ...(benchmarkGoldEntityIdSource !== undefined ? { benchmarkGoldEntityIdSource } : {}),
      ...(benchmarkGoldEntityIdSuggestion !== undefined ? { benchmarkGoldEntityIdSuggestion } : {}),
      ...(benchmarkGoldEntityIdSuggestion !== undefined ? { benchmarkGoldEntityIdSuggestionSource: 'hint_resolution' as const } : {}),
      triageBucket,
      ...(task.operatorBucket !== undefined ? { operatorBucket: task.operatorBucket } : {}),
      ...(isPendingPolicyReview && task.benchmarkGoldHint !== undefined ? { policyConflictHint: task.benchmarkGoldHint } : {}),
      ...(semanticConflictKey !== undefined ? { semanticConflictKey } : {}),
      ...(semanticScopeSupportRegistryRow !== undefined ? { supportStatus: semanticScopeSupportRegistryRow.supportStatus } : {}),
      ...(familyCollisionRegistryRow !== undefined ? { collisionStatus: familyCollisionRegistryRow.collisionStatus } : {}),
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
      semanticScopeTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      semanticPolicyRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
      semanticScopeSupportRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH },
      familySupportRegistry: { type: 'string' },
      familyCollisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-curation-draft.jsonl';
  const semanticScopeTargetRegistryPath = values.semanticScopeTargetRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const semanticPolicyRegistryPath = values.semanticPolicyRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const semanticScopeSupportRegistryPath = values.semanticScopeSupportRegistry
    ?? values.familySupportRegistry
    ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH;
  const familyCollisionRegistryPath = values.familyCollisionRegistry ?? DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH;
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
    loadLookupV2SemanticScopeTargetApprovedMapSync(semanticScopeTargetRegistryPath),
    loadLookupV2SemanticScopeTargetRejectedMapSync(semanticScopeTargetRegistryPath),
    undefined,
    loadLookupV2SemanticPolicyRegistryMapSync(semanticPolicyRegistryPath),
    loadLookupV2SemanticScopeSupportRegistryMapSync(semanticScopeSupportRegistryPath),
    loadLookupV2FamilyCollisionRegistryMapSync(familyCollisionRegistryPath),
  );
  const autoTargetable = rows.filter((row) => row.triageBucket === 'auto_targetable').length;
  const policyReview = rows.filter((row) => row.triageBucket === 'scope_policy_review').length;
  const localizedSurfaceReview = rows.filter((row) => row.triageBucket === 'localized_surface_review').length;
  const reviewedRejected = rows.filter((row) => row.triageBucket === 'reviewed_rejected').length;
  const catalogSupportReview = rows.filter((row) => row.triageBucket === 'catalog_support_review').length;
  const reviewedCollision = rows.filter((row) => row.triageBucket === 'reviewed_collision').length;

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
    'utf8',
  );

  console.log(`[elv2-curation-draft] tasks=${tasks.length}`);
  console.log(`[elv2-curation-draft] rows=${rows.length}`);
  console.log(`[elv2-curation-draft] auto_targetable=${autoTargetable}`);
  console.log(`[elv2-curation-draft] scope_policy_review=${policyReview}`);
  console.log(`[elv2-curation-draft] localized_surface_review=${localizedSurfaceReview}`);
  console.log(`[elv2-curation-draft] reviewed_rejected=${reviewedRejected}`);
  console.log(`[elv2-curation-draft] catalog_support_review=${catalogSupportReview}`);
  console.log(`[elv2-curation-draft] reviewed_collision=${reviewedCollision}`);
  console.log(`[elv2-curation-draft] scope_target_review=${rows.length - autoTargetable - policyReview - localizedSurfaceReview - reviewedRejected - catalogSupportReview - reviewedCollision}`);
  console.log(`[elv2-curation-draft] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
