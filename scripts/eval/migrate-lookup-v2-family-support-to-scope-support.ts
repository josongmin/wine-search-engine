/**
 * Migration: family-level support truth (lookup-family-support-registry-v1, keyed
 * by benchmarkGoldHint) -> scope-level support / NIL (lookup-semantic-scope-support
 * -registry-v1, keyed by semanticScopeKey). Family-level holes become the BARE
 * family scope; status names normalize to the scope vocabulary:
 *   active_catalog_absent -> active_entity_absent
 *   vintage_anchor_absent -> vintage_anchor_absent
 *   secondary_line_only   -> secondary_line_only
 *
 * The family-support registry is deprecated/archived after migration. Run:
 *   node --import tsx scripts/eval/migrate-lookup-v2-family-support-to-scope-support.ts
 */
import fs from 'node:fs';
import { buildLookupSemanticScopeKey } from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2FamilySupportRegistrySync } from '../archive/lookup-v2-family-support-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
  assertLookupV2SemanticScopeSupportRegistryRowsValid,
  loadLookupV2SemanticScopeSupportRegistrySync,
  serializeLookupV2SemanticScopeSupportRegistryRows,
  type LookupV2ScopeSupportStatus,
  type LookupV2SemanticScopeSupportRegistryRow,
} from './lookup-v2-semantic-scope-support-registry.js';

function toScopeSupportStatus(familyStatus: string): LookupV2ScopeSupportStatus {
  if (familyStatus === 'active_catalog_absent') return 'active_entity_absent';
  if (familyStatus === 'vintage_anchor_absent') return 'vintage_anchor_absent';
  if (familyStatus === 'secondary_line_only') return 'secondary_line_only';
  throw new Error(`unmappable family supportStatus=${JSON.stringify(familyStatus)}`);
}

function bareFamilyScopeKey(familyHint: string): string {
  return buildLookupSemanticScopeKey({
    scopeAxis: 'family',
    familyKey: normalizeForMatch(familyHint),
    surfaceFormKind: 'bare',
    locale: 'ko',
  });
}

function main(): void {
  const family = loadLookupV2FamilySupportRegistrySync();
  const existing = loadLookupV2SemanticScopeSupportRegistrySync();
  const byKey = new Map<string, LookupV2SemanticScopeSupportRegistryRow>();
  for (const row of existing) {
    byKey.set(row.semanticScopeKey, row);
  }
  let added = 0;
  for (const familyRow of family) {
    const semanticScopeKey = bareFamilyScopeKey(familyRow.benchmarkGoldHint);
    if (byKey.has(semanticScopeKey)) {
      continue;
    }
    byKey.set(semanticScopeKey, {
      semanticScopeKey,
      supportStatus: toScopeSupportStatus(familyRow.supportStatus),
      reviewedBy: familyRow.reviewedBy,
      reviewedAt: familyRow.reviewedAt,
      decisionReason: `${familyRow.decisionReason} (migrated from family-support benchmarkGoldHint=${familyRow.benchmarkGoldHint})`,
      evidenceClass: 'scope_support_review',
    });
    added += 1;
  }
  const merged = [...byKey.values()];
  assertLookupV2SemanticScopeSupportRegistryRowsValid({ rows: merged });
  fs.writeFileSync(
    DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
    serializeLookupV2SemanticScopeSupportRegistryRows(merged),
  );
  console.log(JSON.stringify({ source: family.length, added, totalAfter: merged.length }, null, 2));
}

main();
