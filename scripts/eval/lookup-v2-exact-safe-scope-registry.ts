import fs from 'node:fs';
import path from 'node:path';
import {
  buildLookupV2ExactSafeReviewScopeKey,
} from './export-lookup-v2-exact-safe-family-review-packet.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

export interface LookupV2ExactSafeScopeRegistryRow {
  readonly reviewScopeKey: string;
  readonly entityId: string;
  readonly scopeHoleClass: string;
  readonly scopeSuggestedAliasType: 'canonical' | 'translation';
  readonly decisionStatus: 'approved' | 'rejected';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'exact_safe_family_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-exact-safe-scope-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseScopeSuggestedAliasType(
  value: unknown,
  label: string,
): LookupV2ExactSafeScopeRegistryRow['scopeSuggestedAliasType'] {
  if (value !== 'canonical' && value !== 'translation') {
    throw new Error(`${label} has invalid scopeSuggestedAliasType`);
  }
  return value;
}

function parseDecisionStatus(
  value: unknown,
  label: string,
): LookupV2ExactSafeScopeRegistryRow['decisionStatus'] {
  if (value !== 'approved' && value !== 'rejected') {
    throw new Error(`${label} has invalid decisionStatus`);
  }
  return value;
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseEvidenceClass(value: unknown, label: string): LookupV2ExactSafeScopeRegistryRow['evidenceClass'] {
  if (value !== 'exact_safe_family_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2ExactSafeScopeRegistryRow {
  const label = `lookup exact-safe scope registry row ${lineNo}`;
  return {
    reviewScopeKey: parseNonEmptyString(raw.reviewScopeKey, `${label} reviewScopeKey`),
    entityId: parseNonEmptyString(raw.entityId, `${label} entityId`),
    scopeHoleClass: parseNonEmptyString(raw.scopeHoleClass, `${label} scopeHoleClass`),
    scopeSuggestedAliasType: parseScopeSuggestedAliasType(raw.scopeSuggestedAliasType, `${label} scopeSuggestedAliasType`),
    decisionStatus: parseDecisionStatus(raw.decisionStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function assertLookupV2ExactSafeScopeRegistryRowsValid(args: {
  readonly rows: readonly LookupV2ExactSafeScopeRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): void {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const existing = new Map<string, LookupV2ExactSafeScopeRegistryRow>();
  for (const row of args.rows) {
    if (!knownEntityIds.has(row.entityId)) {
      throw new Error(
        `lookup exact-safe scope registry references unknown entityId=${JSON.stringify(row.entityId)}`,
      );
    }
    const expectedReviewScopeKey = buildLookupV2ExactSafeReviewScopeKey({
      entityId: row.entityId,
      holeClass: row.scopeHoleClass,
      suggestedAliasType: row.scopeSuggestedAliasType,
    });
    if (row.reviewScopeKey !== expectedReviewScopeKey) {
      throw new Error(
        `lookup exact-safe scope registry reviewScopeKey mismatch for entityId=${JSON.stringify(row.entityId)}`,
      );
    }
    const duplicate = existing.get(row.reviewScopeKey);
    if (duplicate !== undefined) {
      throw new Error(
        `lookup exact-safe scope registry duplicate reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`,
      );
    }
    existing.set(row.reviewScopeKey, row);
  }
}

export function loadLookupV2ExactSafeScopeRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): readonly LookupV2ExactSafeScopeRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2ExactSafeScopeRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2ExactSafeScopeRegistryRowsValid({ rows, knownEntityIds });
  return rows;
}

export function buildLookupV2ExactSafeScopeRegistryMap(
  rows: readonly LookupV2ExactSafeScopeRegistryRow[],
): ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow> {
  return new Map(rows.map((row) => [row.reviewScopeKey, row] as const));
}

export function loadLookupV2ExactSafeScopeRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_EXACT_SAFE_SCOPE_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): ReadonlyMap<string, LookupV2ExactSafeScopeRegistryRow> {
  return buildLookupV2ExactSafeScopeRegistryMap(
    loadLookupV2ExactSafeScopeRegistrySync(registryPath, knownEntityIds),
  );
}

export function sortLookupV2ExactSafeScopeRegistryRows(
  rows: readonly LookupV2ExactSafeScopeRegistryRow[],
): readonly LookupV2ExactSafeScopeRegistryRow[] {
  return rows.slice().sort((left, right) =>
    left.reviewScopeKey.localeCompare(right.reviewScopeKey)
    || left.decisionStatus.localeCompare(right.decisionStatus)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}

export function serializeLookupV2ExactSafeScopeRegistryRows(
  rows: readonly LookupV2ExactSafeScopeRegistryRow[],
): string {
  const ordered = sortLookupV2ExactSafeScopeRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
