import fs from 'node:fs';
import path from 'node:path';
import type { LookupSemanticScope, LookupSemanticScopeAxis, LookupSemanticSurfaceFormKind } from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { buildLookupSemanticScopeKey } from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from './lookup-v2-runtime-semantic-descriptors.js';

export interface LookupV2SemanticScopeTargetRegistryRow {
  readonly semanticScopeKey: string;
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly scopeAxis: LookupSemanticScopeAxis;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
  readonly surfaceFormKind: LookupSemanticSurfaceFormKind;
  readonly locale: 'ko' | 'global';
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

export const DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-semantic-scope-target-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseNonEmptyString(value, label);
}

function parseDecisionStatus(value: unknown, label: string): LookupV2SemanticScopeTargetRegistryRow['decisionStatus'] {
  if (value !== 'approved' && value !== 'rejected') {
    throw new Error(`${label} has invalid decisionStatus`);
  }
  return value;
}

function parseScopeAxis(value: unknown, label: string): LookupV2SemanticScopeTargetRegistryRow['scopeAxis'] {
  if (value !== 'family' && value !== 'line') {
    throw new Error(`${label} has invalid scopeAxis`);
  }
  return value;
}

function parseSurfaceFormKind(
  value: unknown,
  label: string,
): LookupV2SemanticScopeTargetRegistryRow['surfaceFormKind'] {
  if (value !== 'bare' && value !== 'qualified' && value !== 'compact' && value !== 'mixed_script') {
    throw new Error(`${label} has invalid surfaceFormKind`);
  }
  return value;
}

function parseLocale(value: unknown, label: string): LookupV2SemanticScopeTargetRegistryRow['locale'] {
  if (value !== 'ko' && value !== 'global') {
    throw new Error(`${label} has invalid locale`);
  }
  return value;
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseOptionalVintage(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3000) {
    throw new Error(`${label} has invalid vintage`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2SemanticScopeTargetRegistryRow {
  const label = `lookup semantic scope target registry row ${lineNo}`;
  const decisionStatus = parseDecisionStatus(raw.decisionStatus, label);
  const entityId = parseOptionalNonEmptyString(raw.entityId, `${label} entityId`);
  if (decisionStatus === 'approved' && entityId === undefined) {
    throw new Error(`${label} approved row is missing entityId`);
  }
  return {
    semanticScopeKey: parseNonEmptyString(raw.semanticScopeKey, `${label} semanticScopeKey`),
    benchmarkGoldHint: parseNonEmptyString(raw.benchmarkGoldHint, `${label} benchmarkGoldHint`),
    normalizedBenchmarkGoldHint: parseNonEmptyString(raw.normalizedBenchmarkGoldHint, `${label} normalizedBenchmarkGoldHint`),
    scopeAxis: parseScopeAxis(raw.scopeAxis, label),
    familyKey: parseNonEmptyString(raw.familyKey, `${label} familyKey`),
    ...(raw.lineKey !== undefined ? { lineKey: parseNonEmptyString(raw.lineKey, `${label} lineKey`) } : {}),
    ...(raw.regionKey !== undefined ? { regionKey: parseNonEmptyString(raw.regionKey, `${label} regionKey`) } : {}),
    ...(raw.appellationKey !== undefined ? { appellationKey: parseNonEmptyString(raw.appellationKey, `${label} appellationKey`) } : {}),
    ...(raw.vintage !== undefined ? { vintage: parseOptionalVintage(raw.vintage, label)! } : {}),
    surfaceFormKind: parseSurfaceFormKind(raw.surfaceFormKind, label),
    locale: parseLocale(raw.locale, label),
    ...(entityId !== undefined ? { entityId } : {}),
    decisionStatus,
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseNonEmptyString(raw.evidenceClass, `${label} evidenceClass`),
  };
}

function toScope(row: LookupV2SemanticScopeTargetRegistryRow): Omit<LookupSemanticScope, 'semanticScopeKey'> {
  return {
    scopeAxis: row.scopeAxis,
    familyKey: row.familyKey,
    ...(row.lineKey !== undefined ? { lineKey: row.lineKey } : {}),
    ...(row.regionKey !== undefined ? { regionKey: row.regionKey } : {}),
    ...(row.appellationKey !== undefined ? { appellationKey: row.appellationKey } : {}),
    ...(row.vintage !== undefined ? { vintage: row.vintage } : {}),
    surfaceFormKind: row.surfaceFormKind,
    locale: row.locale,
  };
}

export function lookupV2SemanticScopeTargetRowAllowsDetachedVintageAuthority(
  row: LookupV2SemanticScopeTargetRegistryRow,
): boolean {
  return (
    row.decisionStatus === 'approved'
    && row.evidenceClass === 'reviewed_collision_family_review'
    && row.scopeAxis === 'line'
    && row.vintage !== undefined
    && row.lineKey === undefined
    && row.regionKey === undefined
    && row.appellationKey === undefined
  );
}

export function assertLookupV2SemanticScopeTargetRegistryRowsValid(args: {
  readonly rows: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly runtimeDescriptorMap?: ReadonlyMap<string, {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  }>;
}): void {
  const runtimeDescriptorMap = args.runtimeDescriptorMap ?? loadLookupV2RuntimeSemanticDescriptorMapSync();
  const byScope = new Map<string, LookupV2SemanticScopeTargetRegistryRow>();

  for (const row of args.rows) {
    const expectedScopeKey = buildLookupSemanticScopeKey(toScope(row));
    if (row.semanticScopeKey !== expectedScopeKey) {
      throw new Error(`lookup semantic scope target registry semanticScopeKey mismatch for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    const existing = byScope.get(row.semanticScopeKey);
    if (existing !== undefined) {
      throw new Error(`lookup semantic scope target registry duplicate semanticScopeKey=${JSON.stringify(row.semanticScopeKey)}`);
    }
    byScope.set(row.semanticScopeKey, row);

    if (row.entityId === undefined) {
      continue;
    }
    const descriptor = runtimeDescriptorMap.get(row.entityId);
    if (descriptor === undefined) {
      throw new Error(`lookup semantic scope target registry references unknown entityId=${JSON.stringify(row.entityId)} for semanticScopeKey=${JSON.stringify(row.semanticScopeKey)}`);
    }
    if (descriptor.familyKey !== row.familyKey) {
      throw new Error(`lookup semantic scope target registry familyKey mismatch for entityId=${JSON.stringify(row.entityId)}`);
    }
    if (row.lineKey !== undefined && descriptor.lineKey !== row.lineKey) {
      throw new Error(`lookup semantic scope target registry lineKey mismatch for entityId=${JSON.stringify(row.entityId)}`);
    }
    if (row.regionKey !== undefined && descriptor.regionKey !== row.regionKey) {
      throw new Error(`lookup semantic scope target registry regionKey mismatch for entityId=${JSON.stringify(row.entityId)}`);
    }
    if (row.appellationKey !== undefined && descriptor.appellationKey !== row.appellationKey) {
      throw new Error(`lookup semantic scope target registry appellationKey mismatch for entityId=${JSON.stringify(row.entityId)}`);
    }
    if (
      row.vintage !== undefined
      && descriptor.vintage !== row.vintage
      && !lookupV2SemanticScopeTargetRowAllowsDetachedVintageAuthority(row)
    ) {
      throw new Error(`lookup semantic scope target registry vintage mismatch for entityId=${JSON.stringify(row.entityId)}`);
    }
    if (row.scopeAxis === 'line' && row.lineKey === undefined && row.vintage === undefined && row.regionKey === undefined && row.appellationKey === undefined) {
      throw new Error(`lookup semantic scope target registry line scope requires a line or qualifier semanticScopeKey=${JSON.stringify(row.semanticScopeKey)}`);
    }
  }
}

export function loadLookupV2SemanticScopeTargetRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  runtimeDescriptorMap: ReadonlyMap<string, {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  }> = loadLookupV2RuntimeSemanticDescriptorMapSync(),
): readonly LookupV2SemanticScopeTargetRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2SemanticScopeTargetRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2SemanticScopeTargetRegistryRowsValid({ rows, runtimeDescriptorMap });
  return rows;
}

export function buildLookupV2SemanticScopeTargetApprovedMap(
  rows: readonly LookupV2SemanticScopeTargetRegistryRow[],
): ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> {
  return new Map(
    rows
      .filter((row): row is LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string } =>
        row.decisionStatus === 'approved' && row.entityId !== undefined,
      )
      .map((row) => [row.semanticScopeKey, row] as const),
  );
}

export function buildLookupV2SemanticScopeTargetRejectedMap(
  rows: readonly LookupV2SemanticScopeTargetRegistryRow[],
): ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> {
  return new Map(
    rows
      .filter((row) => row.decisionStatus === 'rejected')
      .map((row) => [row.semanticScopeKey, row] as const),
  );
}

export function loadLookupV2SemanticScopeTargetApprovedMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  runtimeDescriptorMap: ReadonlyMap<string, {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  }> = loadLookupV2RuntimeSemanticDescriptorMapSync(),
): ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> {
  return buildLookupV2SemanticScopeTargetApprovedMap(
    loadLookupV2SemanticScopeTargetRegistrySync(registryPath, runtimeDescriptorMap),
  );
}

export function loadLookupV2SemanticScopeTargetRejectedMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  runtimeDescriptorMap: ReadonlyMap<string, {
    readonly familyKey: string;
    readonly lineKey?: string | undefined;
    readonly regionKey?: string | undefined;
    readonly appellationKey?: string | undefined;
    readonly vintage?: number | undefined;
  }> = loadLookupV2RuntimeSemanticDescriptorMapSync(),
): ReadonlyMap<string, LookupV2SemanticScopeTargetRegistryRow> {
  return buildLookupV2SemanticScopeTargetRejectedMap(
    loadLookupV2SemanticScopeTargetRegistrySync(registryPath, runtimeDescriptorMap),
  );
}

export function sortLookupV2SemanticScopeTargetRegistryRows(
  rows: readonly LookupV2SemanticScopeTargetRegistryRow[],
): readonly LookupV2SemanticScopeTargetRegistryRow[] {
  return rows
    .slice()
    .sort((left, right) =>
      left.semanticScopeKey.localeCompare(right.semanticScopeKey)
      || left.decisionStatus.localeCompare(right.decisionStatus)
      || (left.entityId ?? '').localeCompare(right.entityId ?? '')
      || left.reviewedAt.localeCompare(right.reviewedAt),
    );
}

export function serializeLookupV2SemanticScopeTargetRegistryRows(
  rows: readonly LookupV2SemanticScopeTargetRegistryRow[],
): string {
  const ordered = sortLookupV2SemanticScopeTargetRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
