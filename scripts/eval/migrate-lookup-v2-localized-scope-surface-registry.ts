/**
 * Migration: flat reviewed localized surfaces (lookup-localized-surface-registry-v1)
 * -> component-scoped reviewed surfaces (lookup-localized-scope-surface-registry-v1).
 *
 *   surfaceClass  -> componentKind
 *   latinSurface  -> componentKey   (the family/line key the surface attaches to)
 *
 * The flat registry stays as the migration source / archive; the component
 * registry becomes the Surface SoT. Idempotent + de-duplicated. Run:
 *   node --import tsx scripts/eval/migrate-lookup-v2-localized-scope-surface-registry.ts
 */
import fs from 'node:fs';
import { loadLookupV2LocalizedSurfaceRegistrySync } from '../archive/lookup-v2-localized-surface-registry.js';
import {
  DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH,
  assertLookupV2LocalizedScopeSurfaceRegistryRowsValid,
  buildLookupV2ScopeSurfaceRowKey,
  loadLookupV2LocalizedScopeSurfaceRegistrySync,
  serializeLookupV2LocalizedScopeSurfaceRegistryRows,
  type LookupV2LocalizedScopeSurfaceRegistryRow,
  type LookupV2ScopeSurfaceComponentKind,
} from './lookup-v2-localized-scope-surface-registry.js';

function toComponentKind(surfaceClass: string): LookupV2ScopeSurfaceComponentKind {
  if (
    surfaceClass === 'family'
    || surfaceClass === 'line'
    || surfaceClass === 'region'
    || surfaceClass === 'appellation'
  ) {
    return surfaceClass;
  }
  throw new Error(`unmappable surfaceClass=${JSON.stringify(surfaceClass)}`);
}

function main(): void {
  const flat = loadLookupV2LocalizedSurfaceRegistrySync();
  const existing = loadLookupV2LocalizedScopeSurfaceRegistrySync();
  const byKey = new Map<string, LookupV2LocalizedScopeSurfaceRegistryRow>();
  for (const row of existing) {
    byKey.set(buildLookupV2ScopeSurfaceRowKey(row), row);
  }
  let added = 0;
  for (const flatRow of flat) {
    const row: LookupV2LocalizedScopeSurfaceRegistryRow = {
      componentKind: toComponentKind(flatRow.surfaceClass),
      componentKey: flatRow.latinSurface,
      localSurface: flatRow.localSurface,
      normalizedLocalSurface: flatRow.normalizedLocalSurface,
      locale: flatRow.locale,
      decisionStatus: flatRow.decisionStatus,
      reviewedBy: flatRow.reviewedBy,
      reviewedAt: flatRow.reviewedAt,
      decisionReason: flatRow.decisionReason,
      evidenceClass: 'localized_scope_surface_review',
    };
    const key = buildLookupV2ScopeSurfaceRowKey(row);
    if (!byKey.has(key)) {
      byKey.set(key, row);
      added += 1;
    }
  }
  const merged = [...byKey.values()];
  assertLookupV2LocalizedScopeSurfaceRegistryRowsValid({ rows: merged });
  fs.writeFileSync(
    DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH,
    serializeLookupV2LocalizedScopeSurfaceRegistryRows(merged),
  );
  console.log(JSON.stringify({ source: flat.length, added, totalAfter: merged.length }, null, 2));
}

main();
