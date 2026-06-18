import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildLookupQuerySemanticProbe,
  buildLookupSemanticConflictKey,
  buildLookupSemanticScopeFromProbe,
} from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { inferDraftLocale } from './export-lookup-v2-curation-drafts.js';
import {
  DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  loadLookupV2FamilyTargetRegistrySync,
} from './lookup-v2-family-target-registry.js';
import {
  DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  loadLookupV2PolicyFamilyDecisionRegistrySync,
} from './lookup-v2-policy-family-decision-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  serializeLookupV2SemanticPolicyRegistryRows,
  type LookupV2SemanticPolicyRegistryRow,
} from './lookup-v2-semantic-policy-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  serializeLookupV2SemanticScopeTargetRegistryRows,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';
import { loadLookupPolicyConflictRegistrySync } from './lookup-v2-policy-conflict-registry.js';
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from './lookup-v2-runtime-semantic-descriptors.js';

function inferScopeLocale(args: {
  readonly benchmarkGoldHint: string;
  readonly suggestedAliasType?: string | undefined;
}): 'ko' | 'global' {
  if (args.suggestedAliasType === 'translation') {
    return 'ko';
  }
  return inferDraftLocale(args.benchmarkGoldHint);
}

function migrateFamilyTargetRows(): readonly LookupV2SemanticScopeTargetRegistryRow[] {
  const descriptors = loadLookupV2RuntimeSemanticDescriptorMapSync();
  return loadLookupV2FamilyTargetRegistrySync().map((row) => {
    const locale = inferScopeLocale({
      benchmarkGoldHint: row.benchmarkGoldHint,
      suggestedAliasType: row.scopeSuggestedAliasType,
    });
    const entityDescriptor = row.entityId !== undefined
      ? descriptors.get(row.entityId)
      : undefined;
    const scope = entityDescriptor !== undefined
      ? buildLookupSemanticScopeFromProbe({
          probe: buildLookupQuerySemanticProbe({
            query: row.benchmarkGoldHint,
            locale,
          }),
          descriptor: entityDescriptor,
        })
      : {
          semanticScopeKey: '',
          scopeAxis: row.scopeHoleClass.includes('vintage') ? 'line' : 'family',
          familyKey: row.normalizedBenchmarkGoldHint,
          surfaceFormKind:
            row.scopeHoleClass.includes('mixed_script')
              ? 'mixed_script'
              : row.scopeHoleClass.includes('compact')
                ? 'compact'
                : row.scopeHoleClass.includes('vintage') || row.scopeHoleClass.includes('producer_prefixed')
                  ? 'qualified'
                  : 'bare',
          locale,
        };
    const materializedScope = scope.semanticScopeKey.length > 0
      ? scope
      : {
          ...scope,
          semanticScopeKey: buildLookupSemanticConflictKey({
            scopeAxis: scope.scopeAxis,
            familyKey: scope.familyKey,
            surfaceFormKind: scope.surfaceFormKind,
            locale: scope.locale,
          }),
        };
    return {
      semanticScopeKey: materializedScope.semanticScopeKey,
      benchmarkGoldHint: row.benchmarkGoldHint,
      normalizedBenchmarkGoldHint: row.normalizedBenchmarkGoldHint,
      scopeAxis: materializedScope.scopeAxis,
      familyKey: materializedScope.familyKey,
      ...(materializedScope.lineKey !== undefined ? { lineKey: materializedScope.lineKey } : {}),
      ...(materializedScope.regionKey !== undefined ? { regionKey: materializedScope.regionKey } : {}),
      ...(materializedScope.appellationKey !== undefined ? { appellationKey: materializedScope.appellationKey } : {}),
      ...(materializedScope.vintage !== undefined ? { vintage: materializedScope.vintage } : {}),
      surfaceFormKind: materializedScope.surfaceFormKind,
      locale: materializedScope.locale,
      ...(row.entityId !== undefined ? { entityId: row.entityId } : {}),
      decisionStatus: row.decisionStatus,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      decisionReason: row.decisionReason,
      evidenceClass: row.evidenceClass,
    } satisfies LookupV2SemanticScopeTargetRegistryRow;
  });
}

function migratePolicyRows(): readonly LookupV2SemanticPolicyRegistryRow[] {
  const descriptors = loadLookupV2RuntimeSemanticDescriptorMapSync();
  const policyConflicts = new Map(
    loadLookupPolicyConflictRegistrySync().map((row) => [row.surface, row] as const),
  );
  return loadLookupV2PolicyFamilyDecisionRegistrySync().map((row) => {
    const descriptor = descriptors.get(row.entityId);
    if (descriptor === undefined) {
      throw new Error(`semantic policy migration missing descriptor for entityId=${JSON.stringify(row.entityId)}`);
    }
    const locale = inferDraftLocale(row.policyConflictSurface);
    const scope = buildLookupSemanticScopeFromProbe({
      probe: buildLookupQuerySemanticProbe({
        query: row.policyConflictSurface,
        locale,
      }),
      descriptor,
    });
    return {
      semanticConflictKey: buildLookupSemanticConflictKey({
        scopeAxis: scope.scopeAxis,
        familyKey: scope.familyKey,
        ...(scope.lineKey !== undefined ? { lineKey: scope.lineKey } : {}),
        ...(scope.regionKey !== undefined ? { regionKey: scope.regionKey } : {}),
        ...(scope.appellationKey !== undefined ? { appellationKey: scope.appellationKey } : {}),
        ...(scope.vintage !== undefined ? { vintage: scope.vintage } : {}),
        surfaceFormKind: scope.surfaceFormKind,
        locale: scope.locale,
      }),
      conflictClass: policyConflicts.get(row.policyConflictSurface)?.conflictType ?? 'family_collision',
      entityId: row.entityId,
      decision:
        row.decision === 'promote_exact_safe'
          ? 'promote_exact_safe'
          : row.decision === 'keep_policy_conflict'
            ? 'keep_ambiguous'
            : 'needs_scope_target',
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      decisionReason: row.decisionReason,
    } satisfies LookupV2SemanticPolicyRegistryRow;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      familyTargetRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH },
      policyFamilyDecisionRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH },
      semanticTargetOutput: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      semanticPolicyOutput: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH },
    },
  });

  void values.familyTargetRegistry;
  void values.policyFamilyDecisionRegistry;
  const semanticTargetOutput = values.semanticTargetOutput ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const semanticPolicyOutput = values.semanticPolicyOutput ?? DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH;
  const targetRows = migrateFamilyTargetRows();
  const policyRows = migratePolicyRows();

  mkdirSync(path.dirname(semanticTargetOutput), { recursive: true });
  mkdirSync(path.dirname(semanticPolicyOutput), { recursive: true });
  writeFileSync(semanticTargetOutput, serializeLookupV2SemanticScopeTargetRegistryRows(targetRows), 'utf8');
  writeFileSync(semanticPolicyOutput, serializeLookupV2SemanticPolicyRegistryRows(policyRows), 'utf8');

  console.log(`[elv2-semantic-authority-migration] target_rows=${targetRows.length}`);
  console.log(`[elv2-semantic-authority-migration] policy_rows=${policyRows.length}`);
  console.log(`[elv2-semantic-authority-migration] semantic_target_output=${semanticTargetOutput}`);
  console.log(`[elv2-semantic-authority-migration] semantic_policy_output=${semanticPolicyOutput}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
