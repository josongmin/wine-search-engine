import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

export const LOOKUP_V2_LOCALIZED_SURFACE_CLASSES = [
  'family',
  'line',
  'region',
  'appellation',
] as const;
export type LookupV2LocalizedSurfaceClass = (typeof LOOKUP_V2_LOCALIZED_SURFACE_CLASSES)[number];

export const LOOKUP_V2_LOCALIZED_SURFACE_DECISION_STATUSES = [
  'approved',
  'rejected',
] as const;
export type LookupV2LocalizedSurfaceDecisionStatus = (typeof LOOKUP_V2_LOCALIZED_SURFACE_DECISION_STATUSES)[number];

export interface LookupV2LocalizedSurfaceRegistryRow {
  readonly localSurface: string;
  readonly normalizedLocalSurface: string;
  readonly locale: 'ko' | 'global';
  readonly latinSurface: string;
  readonly surfaceClass: LookupV2LocalizedSurfaceClass;
  readonly decisionStatus: LookupV2LocalizedSurfaceDecisionStatus;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'localized_surface_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_LOCALIZED_SURFACE_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-localized-surface-registry-v1.jsonl',
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

function parseLocale(value: unknown, label: string): LookupV2LocalizedSurfaceRegistryRow['locale'] {
  if (value !== 'ko' && value !== 'global') {
    throw new Error(`${label} has invalid locale`);
  }
  return value;
}

function parseSurfaceClass(value: unknown, label: string): LookupV2LocalizedSurfaceClass {
  if (!LOOKUP_V2_LOCALIZED_SURFACE_CLASSES.includes(value as LookupV2LocalizedSurfaceClass)) {
    throw new Error(`${label} has invalid surfaceClass`);
  }
  return value as LookupV2LocalizedSurfaceClass;
}

function parseDecisionStatus(value: unknown, label: string): LookupV2LocalizedSurfaceDecisionStatus {
  if (!LOOKUP_V2_LOCALIZED_SURFACE_DECISION_STATUSES.includes(value as LookupV2LocalizedSurfaceDecisionStatus)) {
    throw new Error(`${label} has invalid decisionStatus`);
  }
  return value as LookupV2LocalizedSurfaceDecisionStatus;
}

function parseEvidenceClass(
  value: unknown,
  label: string,
): LookupV2LocalizedSurfaceRegistryRow['evidenceClass'] {
  if (value !== 'localized_surface_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2LocalizedSurfaceRegistryRow {
  const label = `lookup localized surface registry row ${lineNo}`;
  return {
    localSurface: parseNonEmptyString(raw.localSurface, `${label} localSurface`),
    normalizedLocalSurface: parseNonEmptyString(raw.normalizedLocalSurface, `${label} normalizedLocalSurface`),
    locale: parseLocale(raw.locale, label),
    latinSurface: parseNonEmptyString(raw.latinSurface, `${label} latinSurface`),
    surfaceClass: parseSurfaceClass(raw.surfaceClass, label),
    decisionStatus: parseDecisionStatus(raw.decisionStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function buildLookupV2LocalizedSurfaceRegistryKey(args: {
  readonly normalizedLocalSurface: string;
  readonly locale: LookupV2LocalizedSurfaceRegistryRow['locale'];
}): string {
  return `${args.locale}::${args.normalizedLocalSurface}`;
}

export function assertLookupV2LocalizedSurfaceRegistryRowsValid(args: {
  readonly rows: readonly LookupV2LocalizedSurfaceRegistryRow[];
}): void {
  const seen = new Set<string>();
  for (const row of args.rows) {
    const normalizedLocalSurface = normalizeForMatch(row.localSurface);
    if (normalizedLocalSurface.length === 0) {
      throw new Error(`lookup localized surface registry row "${row.localSurface}" normalizes to empty`);
    }
    if (row.normalizedLocalSurface !== normalizedLocalSurface) {
      throw new Error(
        `lookup localized surface registry normalizedLocalSurface mismatch for localSurface=${JSON.stringify(row.localSurface)}`,
      );
    }
    if (normalizeForMatch(row.latinSurface).length === 0) {
      throw new Error(
        `lookup localized surface registry latinSurface normalizes to empty for localSurface=${JSON.stringify(row.localSurface)}`,
      );
    }
    const key = buildLookupV2LocalizedSurfaceRegistryKey({
      normalizedLocalSurface: row.normalizedLocalSurface,
      locale: row.locale,
    });
    if (seen.has(key)) {
      throw new Error(`lookup localized surface registry duplicate localized surface key=${JSON.stringify(key)}`);
    }
    seen.add(key);
  }
}

export function loadLookupV2LocalizedSurfaceRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_LOCALIZED_SURFACE_REGISTRY_PATH,
): readonly LookupV2LocalizedSurfaceRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2LocalizedSurfaceRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2LocalizedSurfaceRegistryRowsValid({ rows });
  return rows.sort((left, right) =>
    left.locale.localeCompare(right.locale)
    || left.normalizedLocalSurface.localeCompare(right.normalizedLocalSurface)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}

export function buildLookupV2LocalizedSurfaceRegistryMap(
  rows: readonly LookupV2LocalizedSurfaceRegistryRow[],
): ReadonlyMap<string, LookupV2LocalizedSurfaceRegistryRow> {
  return new Map(
    rows.map((row) => [
      buildLookupV2LocalizedSurfaceRegistryKey({
        normalizedLocalSurface: row.normalizedLocalSurface,
        locale: row.locale,
      }),
      row,
    ] as const),
  );
}

export function buildLookupV2ApprovedLocalizedSurfacesByLatinSurfaceMap(
  rows: readonly LookupV2LocalizedSurfaceRegistryRow[],
): ReadonlyMap<string, readonly LookupV2LocalizedSurfaceRegistryRow[]> {
  const grouped = new Map<string, LookupV2LocalizedSurfaceRegistryRow[]>();
  for (const row of rows) {
    if (row.decisionStatus !== 'approved') {
      continue;
    }
    const normalizedLatinSurface = normalizeForMatch(row.latinSurface);
    const existing = grouped.get(normalizedLatinSurface) ?? [];
    existing.push(row);
    grouped.set(normalizedLatinSurface, existing);
  }
  return new Map(
    [...grouped.entries()]
      .map(([normalizedLatinSurface, surfaceRows]) => [
        normalizedLatinSurface,
        surfaceRows.slice().sort((left, right) =>
          left.normalizedLocalSurface.localeCompare(right.normalizedLocalSurface)
          || left.reviewedAt.localeCompare(right.reviewedAt),
        ),
      ] as const),
  );
}

export function loadLookupV2LocalizedSurfaceRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_LOCALIZED_SURFACE_REGISTRY_PATH,
): ReadonlyMap<string, LookupV2LocalizedSurfaceRegistryRow> {
  return buildLookupV2LocalizedSurfaceRegistryMap(loadLookupV2LocalizedSurfaceRegistrySync(registryPath));
}

export function loadLookupV2ApprovedLocalizedSurfacesByLatinSurfaceMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_LOCALIZED_SURFACE_REGISTRY_PATH,
): ReadonlyMap<string, readonly LookupV2LocalizedSurfaceRegistryRow[]> {
  return buildLookupV2ApprovedLocalizedSurfacesByLatinSurfaceMap(
    loadLookupV2LocalizedSurfaceRegistrySync(registryPath),
  );
}
