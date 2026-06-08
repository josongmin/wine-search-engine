import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { CanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { compactForLookup } from '../../src/domain/query/service/phonetic-skeleton.js';
import { extractQueryVintageYear } from '../../src/domain/shared/utils/vintage.js';
import type { LookupIdentityCertificate } from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import type { AliasSnapshotRecord } from './search-snapshot-schema.js';

export type LookupExactSafePromotionClass = 'exact_safe' | 'compact_exact_safe';
export type LookupExactSafeLocale = 'ko' | 'global';

export interface LookupExactSafeRegistryRow {
  readonly surface: string;
  readonly entityId: CanonicalEntityId;
  readonly promotionClass: LookupExactSafePromotionClass;
  readonly locale: LookupExactSafeLocale;
  readonly sourceEvidence: string;
  readonly reviewedAt: string;
}

export interface LookupRuntimeOverlayAlias {
  readonly entityId: CanonicalEntityId;
  readonly value: string;
  readonly normalizedValue: string;
  readonly promotionClass: LookupExactSafePromotionClass;
  readonly aliasType: 'observed_query_alias';
  readonly source: 'registry:lookup_exact_safe_v1';
  readonly sourceTrust: 1;
  readonly confidencePrior: 0.98;
}

export type LookupExactSafeRegistryVintageIssueReason =
  | 'missing_entity_vintages'
  | 'entity_vintage_mismatch';

export interface LookupExactSafeRegistryVintageIssue {
  readonly row: LookupExactSafeRegistryRow;
  readonly surfaceVintage: number;
  readonly entityVintages: readonly number[];
  readonly reason: LookupExactSafeRegistryVintageIssueReason;
}

export const DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
  'korean-exact-safe-registry-v1.jsonl',
);

interface RawLookupExactSafeRegistryRow {
  readonly surface?: unknown;
  readonly entityId?: unknown;
  readonly promotionClass?: unknown;
  readonly locale?: unknown;
  readonly sourceEvidence?: unknown;
  readonly reviewedAt?: unknown;
}

function parseLookupExactSafeRegistryRow(
  raw: RawLookupExactSafeRegistryRow,
  lineNo: number,
): LookupExactSafeRegistryRow {
  if (typeof raw.surface !== 'string' || raw.surface.trim().length === 0) {
    throw new Error(`lookup exact-safe registry row ${lineNo} missing surface`);
  }
  if (typeof raw.entityId !== 'string' || raw.entityId.trim().length === 0) {
    throw new Error(`lookup exact-safe registry row ${lineNo} missing entityId`);
  }
  if (raw.promotionClass !== 'exact_safe' && raw.promotionClass !== 'compact_exact_safe') {
    throw new Error(`lookup exact-safe registry row ${lineNo} has invalid promotionClass`);
  }
  if (raw.locale !== 'ko' && raw.locale !== 'global') {
    throw new Error(`lookup exact-safe registry row ${lineNo} has invalid locale`);
  }
  if (typeof raw.sourceEvidence !== 'string' || raw.sourceEvidence.trim().length === 0) {
    throw new Error(`lookup exact-safe registry row ${lineNo} missing sourceEvidence`);
  }
  if (typeof raw.reviewedAt !== 'string' || Number.isNaN(Date.parse(raw.reviewedAt))) {
    throw new Error(`lookup exact-safe registry row ${lineNo} has invalid reviewedAt`);
  }

  return {
    surface: raw.surface.trim(),
    entityId: raw.entityId as CanonicalEntityId,
    promotionClass: raw.promotionClass,
    locale: raw.locale,
    sourceEvidence: raw.sourceEvidence.trim(),
    reviewedAt: raw.reviewedAt,
  };
}

export async function loadLookupExactSafeRegistry(
  registryPath: string = DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
): Promise<readonly LookupExactSafeRegistryRow[]> {
  if (!existsSync(registryPath)) {
    return [];
  }

  const raw = await fs.readFile(registryPath, 'utf8');
  const rows: LookupExactSafeRegistryRow[] = [];

  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseLookupExactSafeRegistryRow(
      JSON.parse(trimmed) as RawLookupExactSafeRegistryRow,
      index + 1,
    );
    rows.push(parsed);
  }

  assertLookupExactSafeRegistryRowsValid(rows);
  return rows;
}

export function assertLookupExactSafeRegistryRowsValid(
  rows: readonly LookupExactSafeRegistryRow[],
): void {
  const exactOwners = new Map<string, CanonicalEntityId>();
  const compactOwners = new Map<string, CanonicalEntityId>();

  for (const row of rows) {
    const normalized = normalizeForMatch(row.surface);
    if (normalized.length === 0) {
      throw new Error(`lookup exact-safe registry row normalizes to empty for surface=${JSON.stringify(row.surface)}`);
    }

    const exactOwner = exactOwners.get(normalized);
    if (exactOwner !== undefined && exactOwner !== row.entityId) {
      throw new Error(
        `lookup exact-safe registry exact collision on "${row.surface}" between ${exactOwner} and ${row.entityId}`,
      );
    }
    exactOwners.set(normalized, row.entityId);

    if (row.promotionClass === 'compact_exact_safe') {
      const compact = compactForLookup(normalized);
      if (compact.length === 0) {
        throw new Error(`lookup exact-safe registry compact-normalizes to empty for surface=${JSON.stringify(row.surface)}`);
      }
      const compactOwner = compactOwners.get(compact);
      if (compactOwner !== undefined && compactOwner !== row.entityId) {
        throw new Error(
          `lookup exact-safe registry compact collision on "${row.surface}" between ${compactOwner} and ${row.entityId}`,
        );
      }
      compactOwners.set(compact, row.entityId);
    }
  }
}

export function assertLookupExactSafeRegistryVintageConsistency(args: {
  readonly rows: readonly LookupExactSafeRegistryRow[];
  readonly entityVintagesById: ReadonlyMap<CanonicalEntityId, readonly number[]>;
}): void {
  const issues = collectLookupExactSafeRegistryVintageIssues(args);
  for (const issue of issues) {
    if (issue.reason === 'missing_entity_vintages') {
      throw new Error(
        `lookup exact-safe registry vintage-bearing surface is missing snapshot entity vintage `
        + `for surface=${JSON.stringify(issue.row.surface)} entityId=${JSON.stringify(issue.row.entityId)} `
        + `surfaceVintage=${issue.surfaceVintage}`,
      );
    }
    throw new Error(
      `lookup exact-safe registry vintage mismatch `
      + `for surface=${JSON.stringify(issue.row.surface)} entityId=${JSON.stringify(issue.row.entityId)} `
      + `surfaceVintage=${issue.surfaceVintage} entityVintages=${JSON.stringify(issue.entityVintages)}`,
    );
  }
}

export function collectLookupExactSafeRegistryVintageIssues(args: {
  readonly rows: readonly LookupExactSafeRegistryRow[];
  readonly entityVintagesById: ReadonlyMap<CanonicalEntityId, readonly number[]>;
}): readonly LookupExactSafeRegistryVintageIssue[] {
  const issues: LookupExactSafeRegistryVintageIssue[] = [];
  for (const row of args.rows) {
    const surfaceVintage = extractQueryVintageYear(row.surface);
    if (surfaceVintage === null) {
      continue;
    }
    const entityVintages = args.entityVintagesById.get(row.entityId);
    if (entityVintages === undefined) {
      continue;
    }
    if (entityVintages.length === 0) {
      issues.push({
        row,
        surfaceVintage,
        entityVintages,
        reason: 'missing_entity_vintages',
      });
      continue;
    }
    let hasMatch = false;
    for (const entityVintage of entityVintages) {
      if (entityVintage === surfaceVintage) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) {
      issues.push({
        row,
        surfaceVintage,
        entityVintages,
        reason: 'entity_vintage_mismatch',
      });
    }
  }
  return issues;
}

export function pruneLookupExactSafeRegistryRowsByVintageConsistency(args: {
  readonly rows: readonly LookupExactSafeRegistryRow[];
  readonly entityVintagesById: ReadonlyMap<CanonicalEntityId, readonly number[]>;
}): {
  readonly keptRows: readonly LookupExactSafeRegistryRow[];
  readonly removedIssues: readonly LookupExactSafeRegistryVintageIssue[];
} {
  const removedIssues = collectLookupExactSafeRegistryVintageIssues(args);
  const removedIssueKeys = new Set(
    removedIssues.map((issue) =>
      `${issue.row.entityId}\u0000${issue.row.surface}\u0000${issue.row.promotionClass}\u0000${issue.row.locale}`,
    ),
  );
  return {
    keptRows: args.rows.filter((row) =>
      !removedIssueKeys.has(`${row.entityId}\u0000${row.surface}\u0000${row.promotionClass}\u0000${row.locale}`),
    ),
    removedIssues,
  };
}

export function sortLookupExactSafeRegistryRows(
  rows: readonly LookupExactSafeRegistryRow[],
): readonly LookupExactSafeRegistryRow[] {
  return rows
    .slice()
    .sort((left, right) =>
      left.locale.localeCompare(right.locale)
      || left.entityId.localeCompare(right.entityId)
      || normalizeForMatch(left.surface).localeCompare(normalizeForMatch(right.surface))
      || left.surface.localeCompare(right.surface)
      || left.promotionClass.localeCompare(right.promotionClass)
      || left.reviewedAt.localeCompare(right.reviewedAt),
    );
}

export function serializeLookupExactSafeRegistryRows(
  rows: readonly LookupExactSafeRegistryRow[],
): string {
  const ordered = sortLookupExactSafeRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}

export function buildLookupRuntimeOverlayAliases(
  rows: readonly LookupExactSafeRegistryRow[],
  snapshotEntityIds: ReadonlySet<CanonicalEntityId>,
): readonly LookupRuntimeOverlayAlias[] {
  return rows
    .filter((row) => snapshotEntityIds.has(row.entityId))
    .map((row) => ({
      entityId: row.entityId,
      value: row.surface,
      normalizedValue: normalizeForMatch(row.surface),
      promotionClass: row.promotionClass,
      aliasType: 'observed_query_alias',
      source: 'registry:lookup_exact_safe_v1',
      sourceTrust: 1,
      confidencePrior: 0.98,
    }))
    .sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
      || left.normalizedValue.localeCompare(right.normalizedValue)
      || left.value.localeCompare(right.value),
    );
}

export function buildLookupIdentityCertificatesByEntity(
  rows: readonly LookupExactSafeRegistryRow[],
  snapshotEntityIds: ReadonlySet<CanonicalEntityId>,
): ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]> {
  const byEntity = new Map<CanonicalEntityId, LookupIdentityCertificate[]>();
  for (const row of rows) {
    if (!snapshotEntityIds.has(row.entityId)) {
      continue;
    }
    const next = byEntity.get(row.entityId) ?? [];
    next.push({
      kind: row.promotionClass,
      normalizedSurface: normalizeForMatch(row.surface),
      ...(row.promotionClass === 'compact_exact_safe'
        ? { compactSurface: compactForLookup(normalizeForMatch(row.surface)) }
        : {}),
      sourceTier: 'curated',
      singleton: true,
      collisionFree: true,
    });
    byEntity.set(row.entityId, next);
  }

  return new Map(
    [...byEntity.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityId, certificates]) => [
        entityId,
        certificates
          .slice()
          .sort((left, right) =>
            left.normalizedSurface.localeCompare(right.normalizedSurface)
            || left.kind.localeCompare(right.kind),
          ),
      ]),
  );
}

export function assertLookupExactSafeRegistryCompatibleWithBaseAliases(args: {
  readonly baseAliases: readonly AliasSnapshotRecord[];
  readonly registryRows: readonly LookupExactSafeRegistryRow[];
}): void {
  const exactOwners = new Map<string, CanonicalEntityId>();
  const compactOwners = new Map<string, CanonicalEntityId>();

  for (const row of args.registryRows) {
    const normalized = normalizeForMatch(row.surface);
    const exactOwner = exactOwners.get(normalized);
    if (exactOwner !== undefined && exactOwner !== row.entityId) {
      throw new Error(
        `lookup exact-safe registry exact collision on "${row.surface}" between curated owners ${exactOwner} and ${row.entityId}`,
      );
    }
    exactOwners.set(normalized, row.entityId);

    if (row.promotionClass === 'compact_exact_safe') {
      const compact = compactForLookup(normalized);
      const compactOwner = compactOwners.get(compact);
      if (compactOwner !== undefined && compactOwner !== row.entityId) {
        throw new Error(
          `lookup exact-safe registry compact collision on "${row.surface}" between curated owners ${compactOwner} and ${row.entityId}`,
        );
      }
      if (compact.length > 0) {
        compactOwners.set(compact, row.entityId);
      }
    }
  }
}
