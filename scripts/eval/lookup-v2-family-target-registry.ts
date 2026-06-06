import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

export interface LookupV2FamilyTargetRegistryRow {
  readonly reviewScopeKey: string;
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly scopeHoleClass: string;
  readonly scopeSuggestedAliasType: 'canonical' | 'translation';
  readonly entityId?: string | undefined;
  readonly decisionStatus: 'approved' | 'rejected';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: string;
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-family-target-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseDecisionStatus(value: unknown, label: string): LookupV2FamilyTargetRegistryRow['decisionStatus'] {
  if (value !== 'approved' && value !== 'rejected') {
    throw new Error(`${label} has invalid decisionStatus`);
  }
  return value;
}

function parseScopeSuggestedAliasType(
  value: unknown,
  label: string,
): LookupV2FamilyTargetRegistryRow['scopeSuggestedAliasType'] {
  if (value !== 'canonical' && value !== 'translation') {
    throw new Error(`${label} has invalid scopeSuggestedAliasType`);
  }
  return value;
}

function parseEntityId(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} has invalid entityId`);
  }
  return value.trim();
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2FamilyTargetRegistryRow {
  const label = `lookup family target registry row ${lineNo}`;
  const reviewScopeKey = parseNonEmptyString(raw.reviewScopeKey, `${label} reviewScopeKey`);
  const benchmarkGoldHint = parseNonEmptyString(raw.benchmarkGoldHint, `${label} benchmarkGoldHint`);
  const normalizedBenchmarkGoldHint = parseNonEmptyString(
    raw.normalizedBenchmarkGoldHint,
    `${label} normalizedBenchmarkGoldHint`,
  );
  const scopeHoleClass = parseNonEmptyString(raw.scopeHoleClass, `${label} scopeHoleClass`);
  const scopeSuggestedAliasType = parseScopeSuggestedAliasType(
    raw.scopeSuggestedAliasType,
    `${label} scopeSuggestedAliasType`,
  );
  const decisionStatus = parseDecisionStatus(raw.decisionStatus, label);
  const entityId = parseEntityId(raw.entityId, label);
  if (decisionStatus === 'approved' && entityId === undefined) {
    throw new Error(`${label} approved row is missing entityId`);
  }

  return {
    reviewScopeKey,
    benchmarkGoldHint,
    normalizedBenchmarkGoldHint,
    scopeHoleClass,
    scopeSuggestedAliasType,
    ...(entityId !== undefined ? { entityId } : {}),
    decisionStatus,
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseNonEmptyString(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function buildLookupV2FamilyTargetReviewScopeKey(args: {
  readonly benchmarkGoldHint: string;
  readonly holeClass: string;
  readonly suggestedAliasType: LookupV2FamilyTargetRegistryRow['scopeSuggestedAliasType'];
}): string {
  return `${normalizeForMatch(args.benchmarkGoldHint)}::${args.suggestedAliasType}::${args.holeClass}`;
}

export function assertLookupV2FamilyTargetRegistryRowsValid(args: {
  readonly rows: readonly LookupV2FamilyTargetRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): void {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const owners = new Map<string, LookupV2FamilyTargetRegistryRow>();

  for (const row of args.rows) {
    const normalizedHint = normalizeForMatch(row.benchmarkGoldHint);
    if (normalizedHint.length === 0) {
      throw new Error(`lookup family target registry row "${row.benchmarkGoldHint}" normalizes to empty`);
    }
    if (row.normalizedBenchmarkGoldHint !== normalizedHint) {
      throw new Error(
        `lookup family target registry normalizedBenchmarkGoldHint mismatch for hint=${JSON.stringify(row.benchmarkGoldHint)}`,
      );
    }
    const expectedScopeKey = buildLookupV2FamilyTargetReviewScopeKey({
      benchmarkGoldHint: row.benchmarkGoldHint,
      holeClass: row.scopeHoleClass,
      suggestedAliasType: row.scopeSuggestedAliasType,
    });
    if (row.reviewScopeKey !== expectedScopeKey) {
      throw new Error(
        `lookup family target registry reviewScopeKey mismatch for hint=${JSON.stringify(row.benchmarkGoldHint)}`,
      );
    }
    const existing = owners.get(row.reviewScopeKey);
    if (existing !== undefined) {
      throw new Error(
        `lookup family target registry duplicate reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`,
      );
    }
    owners.set(row.reviewScopeKey, row);

    if (row.entityId !== undefined && !knownEntityIds.has(row.entityId)) {
      throw new Error(
        `lookup family target registry references unknown entityId=${JSON.stringify(row.entityId)} for hint=${JSON.stringify(row.benchmarkGoldHint)}`,
      );
    }
  }
}

export function loadLookupV2FamilyTargetRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): readonly LookupV2FamilyTargetRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  const rows: LookupV2FamilyTargetRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }

  assertLookupV2FamilyTargetRegistryRowsValid({ rows, knownEntityIds });
  return rows;
}

export function buildLookupV2FamilyTargetApprovedMap(
  rows: readonly LookupV2FamilyTargetRegistryRow[],
): ReadonlyMap<string, LookupV2FamilyTargetRegistryRow> {
  return new Map(
    rows
      .filter((row): row is LookupV2FamilyTargetRegistryRow & { readonly entityId: string } =>
        row.decisionStatus === 'approved' && row.entityId !== undefined,
      )
      .map((row) => [row.reviewScopeKey, row] as const),
  );
}

export function buildLookupV2FamilyTargetRejectedMap(
  rows: readonly LookupV2FamilyTargetRegistryRow[],
): ReadonlyMap<string, LookupV2FamilyTargetRegistryRow> {
  return new Map(
    rows
      .filter((row) => row.decisionStatus === 'rejected')
      .map((row) => [row.reviewScopeKey, row] as const),
  );
}

export function loadLookupV2FamilyTargetApprovedMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): ReadonlyMap<string, LookupV2FamilyTargetRegistryRow> {
  return buildLookupV2FamilyTargetApprovedMap(
    loadLookupV2FamilyTargetRegistrySync(registryPath, knownEntityIds),
  );
}

export function loadLookupV2FamilyTargetRejectedMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_TARGET_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): ReadonlyMap<string, LookupV2FamilyTargetRegistryRow> {
  return buildLookupV2FamilyTargetRejectedMap(
    loadLookupV2FamilyTargetRegistrySync(registryPath, knownEntityIds),
  );
}

export function sortLookupV2FamilyTargetRegistryRows(
  rows: readonly LookupV2FamilyTargetRegistryRow[],
): readonly LookupV2FamilyTargetRegistryRow[] {
  return rows
    .slice()
    .sort((left, right) =>
      left.reviewScopeKey.localeCompare(right.reviewScopeKey)
      || left.decisionStatus.localeCompare(right.decisionStatus)
      || (left.entityId ?? '').localeCompare(right.entityId ?? '')
      || left.reviewedAt.localeCompare(right.reviewedAt),
    );
}

export function serializeLookupV2FamilyTargetRegistryRows(
  rows: readonly LookupV2FamilyTargetRegistryRow[],
): string {
  const ordered = sortLookupV2FamilyTargetRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
