import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import {
  DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH,
  buildLookupV2ScopeSurfaceRowKey,
  loadLookupV2LocalizedScopeSurfaceRegistrySync,
  serializeLookupV2LocalizedScopeSurfaceRegistryRows,
  type LookupV2LocalizedScopeSurfaceRegistryRow,
} from './lookup-v2-localized-scope-surface-registry.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetApprovedMapSync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';

interface LocalizedScopeSurfaceSyncResult {
  readonly mergedRows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[];
  readonly candidateDraftRows: number;
  readonly approvedScopeRows: number;
  readonly insertedRows: number;
  readonly skippedExistingRows: number;
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['surface'] === 'string'
    && typeof row['locale'] === 'string'
    && typeof row['semanticScopeKey'] === 'string'
    && typeof row['scopeAxis'] === 'string'
    && typeof row['familyKey'] === 'string'
    && typeof row['surfaceFormKind'] === 'string'
    && typeof row['triageBucket'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDraftJsonl(filePath: string): readonly LookupV2CurationDraftRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2CurationDraftRow);
}

function isApprovedKoreanFamilySurfaceDraftRow(
  row: LookupV2CurationDraftRow,
): boolean {
  return row.locale === 'ko'
    && row.scopeAxis === 'family'
    && row.lineKey === undefined
    && row.regionKey === undefined
    && row.appellationKey === undefined
    && row.vintage === undefined;
}

function buildLocalizedScopeSurfaceRowsFromDraft(args: {
  readonly row: LookupV2CurationDraftRow;
  readonly approvedScopeRow: LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string };
}): readonly LookupV2LocalizedScopeSurfaceRegistryRow[] {
  const normalizedLocalSurface = normalizeForMatch(args.row.surface);
  return [{
    componentKind: 'family',
    componentKey: args.row.familyKey,
    localSurface: args.row.surface,
    normalizedLocalSurface,
    locale: args.row.locale,
    decisionStatus: 'approved',
    reviewedBy: args.approvedScopeRow.reviewedBy,
    reviewedAt: args.approvedScopeRow.reviewedAt,
    decisionReason:
      `auto-synced localized component surface from approved semantic scope target ` +
      `semanticScopeKey=${args.approvedScopeRow.semanticScopeKey}`,
    evidenceClass: 'localized_scope_surface_review',
  }];
}

export function syncLookupV2LocalizedScopeSurfaceRegistryFromDraft(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly existingRows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[];
  readonly approvedScopeMap: ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow>;
}): LocalizedScopeSurfaceSyncResult {
  const mergedRows = args.existingRows.slice();
  const byKey = new Map(
    args.existingRows.map((row) => [buildLookupV2ScopeSurfaceRowKey(row), row] as const),
  );
  let candidateDraftRows = 0;
  let approvedScopeRows = 0;
  let insertedRows = 0;
  let skippedExistingRows = 0;

  for (const draftRow of args.draftRows) {
    if (!isApprovedKoreanFamilySurfaceDraftRow(draftRow)) {
      continue;
    }
    candidateDraftRows += 1;
    const approvedScopeRow = args.approvedScopeMap.get(draftRow.semanticScopeKey);
    if (approvedScopeRow?.entityId === undefined) {
      continue;
    }
    approvedScopeRows += 1;
    for (const localizedRow of buildLocalizedScopeSurfaceRowsFromDraft({
      row: draftRow,
      approvedScopeRow,
    })) {
      const key = buildLookupV2ScopeSurfaceRowKey(localizedRow);
      if (byKey.has(key)) {
        skippedExistingRows += 1;
        continue;
      }
      byKey.set(key, localizedRow);
      mergedRows.push(localizedRow);
      insertedRows += 1;
    }
  }

  return {
    mergedRows,
    candidateDraftRows,
    approvedScopeRows,
    insertedRows,
    skippedExistingRows,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: '/tmp/lookup-v2-drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH },
      semanticScopeRegistry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-localized-scope-surface-registry-merged.jsonl' },
      write: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input ?? '/tmp/lookup-v2-drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl';
  const registryPath = values.registry ?? DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH;
  const semanticScopeRegistryPath = values.semanticScopeRegistry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const outputPath = values.output ?? '/tmp/lookup-localized-scope-surface-registry-merged.jsonl';

  const result = syncLookupV2LocalizedScopeSurfaceRegistryFromDraft({
    draftRows: parseDraftJsonl(inputPath),
    existingRows: loadLookupV2LocalizedScopeSurfaceRegistrySync(registryPath),
    approvedScopeMap: loadLookupV2SemanticScopeTargetApprovedMapSync(semanticScopeRegistryPath),
  });

  const targetPath = values.write ? registryPath : outputPath;
  writeFileSync(targetPath, serializeLookupV2LocalizedScopeSurfaceRegistryRows(result.mergedRows), 'utf8');

  console.log(`[elv2-localized-scope-surface-sync] candidate_draft_rows=${result.candidateDraftRows}`);
  console.log(`[elv2-localized-scope-surface-sync] approved_scope_rows=${result.approvedScopeRows}`);
  console.log(`[elv2-localized-scope-surface-sync] inserted_rows=${result.insertedRows}`);
  console.log(`[elv2-localized-scope-surface-sync] skipped_existing_rows=${result.skippedExistingRows}`);
  console.log(`[elv2-localized-scope-surface-sync] output=${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
