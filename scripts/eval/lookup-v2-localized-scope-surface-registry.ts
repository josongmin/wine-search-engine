import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

/**
 * Reviewed multilingual COMPONENT-surface index (final architecture L1 / Surface SoT).
 *
 * Unlike the legacy flat localized-surface registry (migration source only),
 * each row attaches a reviewed surface to ONE scope
 * COMPONENT — family / line / region / appellation — so a query can be matched
 * by composing components (e.g. "실버 오크 알렉산더 밸리 2018" = family surface
 * + line surface + vintage). This is the surface plane the semantic-scope
 * matcher reads instead of latin-literal token containment.
 *
 * Functional key: componentKind :: componentKey :: locale :: normalizedLocalSurface.
 */
export const LOOKUP_V2_SCOPE_SURFACE_COMPONENT_KINDS = [
  'family',
  'line',
  'region',
  'appellation',
] as const;
export type LookupV2ScopeSurfaceComponentKind =
  (typeof LOOKUP_V2_SCOPE_SURFACE_COMPONENT_KINDS)[number];

export const LOOKUP_V2_SCOPE_SURFACE_DECISION_STATUSES = ['approved', 'rejected'] as const;
export type LookupV2ScopeSurfaceDecisionStatus =
  (typeof LOOKUP_V2_SCOPE_SURFACE_DECISION_STATUSES)[number];

export interface LookupV2LocalizedScopeSurfaceRegistryRow {
  readonly componentKind: LookupV2ScopeSurfaceComponentKind;
  readonly componentKey: string;
  readonly localSurface: string;
  readonly normalizedLocalSurface: string;
  readonly locale: 'ko' | 'global';
  readonly decisionStatus: LookupV2ScopeSurfaceDecisionStatus;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'localized_scope_surface_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-localized-scope-surface-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseLocale(value: unknown, label: string): LookupV2LocalizedScopeSurfaceRegistryRow['locale'] {
  if (value !== 'ko' && value !== 'global') {
    throw new Error(`${label} has invalid locale`);
  }
  return value;
}

function parseComponentKind(value: unknown, label: string): LookupV2ScopeSurfaceComponentKind {
  if (!LOOKUP_V2_SCOPE_SURFACE_COMPONENT_KINDS.includes(value as LookupV2ScopeSurfaceComponentKind)) {
    throw new Error(`${label} has invalid componentKind`);
  }
  return value as LookupV2ScopeSurfaceComponentKind;
}

function parseDecisionStatus(value: unknown, label: string): LookupV2ScopeSurfaceDecisionStatus {
  if (!LOOKUP_V2_SCOPE_SURFACE_DECISION_STATUSES.includes(value as LookupV2ScopeSurfaceDecisionStatus)) {
    throw new Error(`${label} has invalid decisionStatus`);
  }
  return value as LookupV2ScopeSurfaceDecisionStatus;
}

function parseEvidenceClass(
  value: unknown,
  label: string,
): LookupV2LocalizedScopeSurfaceRegistryRow['evidenceClass'] {
  if (value !== 'localized_scope_surface_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2LocalizedScopeSurfaceRegistryRow {
  const label = `lookup localized scope surface registry row ${lineNo}`;
  return {
    componentKind: parseComponentKind(raw.componentKind, label),
    componentKey: parseNonEmptyString(raw.componentKey, `${label} componentKey`),
    localSurface: parseNonEmptyString(raw.localSurface, `${label} localSurface`),
    normalizedLocalSurface: parseNonEmptyString(raw.normalizedLocalSurface, `${label} normalizedLocalSurface`),
    locale: parseLocale(raw.locale, label),
    decisionStatus: parseDecisionStatus(raw.decisionStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function buildLookupV2ScopeSurfaceComponentKey(args: {
  readonly componentKind: LookupV2ScopeSurfaceComponentKind;
  readonly componentKey: string;
  readonly locale: LookupV2LocalizedScopeSurfaceRegistryRow['locale'];
}): string {
  return `${args.componentKind}::${args.componentKey}::${args.locale}`;
}

export function buildLookupV2ScopeSurfaceRowKey(row: LookupV2LocalizedScopeSurfaceRegistryRow): string {
  return `${buildLookupV2ScopeSurfaceComponentKey(row)}::${row.normalizedLocalSurface}`;
}

export function assertLookupV2LocalizedScopeSurfaceRegistryRowsValid(args: {
  readonly rows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[];
}): void {
  const seen = new Set<string>();
  for (const row of args.rows) {
    const normalized = normalizeForMatch(row.localSurface);
    if (normalized.length === 0) {
      throw new Error(`lookup localized scope surface registry row "${row.localSurface}" normalizes to empty`);
    }
    if (row.normalizedLocalSurface !== normalized) {
      throw new Error(
        `lookup localized scope surface registry normalizedLocalSurface mismatch for localSurface=${JSON.stringify(row.localSurface)}`,
      );
    }
    if (normalizeForMatch(row.componentKey).length === 0) {
      throw new Error(
        `lookup localized scope surface registry componentKey normalizes to empty for localSurface=${JSON.stringify(row.localSurface)}`,
      );
    }
    const key = buildLookupV2ScopeSurfaceRowKey(row);
    if (seen.has(key)) {
      throw new Error(`lookup localized scope surface registry duplicate key=${JSON.stringify(key)}`);
    }
    seen.add(key);
  }
}

export function loadLookupV2LocalizedScopeSurfaceRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_LOCALIZED_SCOPE_SURFACE_REGISTRY_PATH,
): readonly LookupV2LocalizedScopeSurfaceRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2LocalizedScopeSurfaceRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2LocalizedScopeSurfaceRegistryRowsValid({ rows });
  return rows.sort((left, right) =>
    left.componentKind.localeCompare(right.componentKind)
    || left.componentKey.localeCompare(right.componentKey)
    || left.locale.localeCompare(right.locale)
    || left.normalizedLocalSurface.localeCompare(right.normalizedLocalSurface)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}

/**
 * APPROVED component → reviewed normalized surfaces map, keyed by
 * componentKind::componentKey::locale. This is the runtime-facing shape the
 * surface-index artifact materializes and the scope matcher composes over.
 */
export function buildLookupV2ApprovedScopeSurfaceMap(
  rows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.decisionStatus !== 'approved') {
      continue;
    }
    const key = buildLookupV2ScopeSurfaceComponentKey(row);
    const existing = grouped.get(key) ?? new Set<string>();
    existing.add(row.normalizedLocalSurface);
    grouped.set(key, existing);
  }
  return grouped;
}

export function serializeLookupV2LocalizedScopeSurfaceRegistryRows(
  rows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[],
): string {
  const ordered = [...loadOrderableCopy(rows)];
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}

function loadOrderableCopy(
  rows: readonly LookupV2LocalizedScopeSurfaceRegistryRow[],
): readonly LookupV2LocalizedScopeSurfaceRegistryRow[] {
  return rows.slice().sort((left, right) =>
    left.componentKind.localeCompare(right.componentKind)
    || left.componentKey.localeCompare(right.componentKey)
    || left.locale.localeCompare(right.locale)
    || left.normalizedLocalSurface.localeCompare(right.normalizedLocalSurface)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}
