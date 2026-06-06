import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

export interface LookupV2FamilyCoreWitnessRegistryRow {
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly entityId: string;
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

export const DEFAULT_LOOKUP_V2_FAMILY_CORE_WITNESS_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-family-core-witness-registry-v1.jsonl',
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

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2FamilyCoreWitnessRegistryRow {
  const label = `lookup family core witness registry row ${lineNo}`;
  return {
    surface: parseNonEmptyString(raw.surface, `${label} surface`),
    normalizedSurface: parseNonEmptyString(raw.normalizedSurface, `${label} normalizedSurface`),
    entityId: parseNonEmptyString(raw.entityId, `${label} entityId`),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseNonEmptyString(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function assertLookupV2FamilyCoreWitnessRegistryRowsValid(args: {
  readonly rows: readonly LookupV2FamilyCoreWitnessRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): void {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const seen = new Set<string>();

  for (const row of args.rows) {
    const normalizedSurface = normalizeForMatch(row.surface);
    if (normalizedSurface.length === 0) {
      throw new Error(`lookup family core witness registry row "${row.surface}" normalizes to empty`);
    }
    if (row.normalizedSurface !== normalizedSurface) {
      throw new Error(
        `lookup family core witness registry normalizedSurface mismatch for surface=${JSON.stringify(row.surface)}`,
      );
    }
    if (!knownEntityIds.has(row.entityId)) {
      throw new Error(
        `lookup family core witness registry references unknown entityId=${JSON.stringify(row.entityId)} for surface=${JSON.stringify(row.surface)}`,
      );
    }
    const dedupeKey = `${row.normalizedSurface}::${row.entityId}`;
    if (seen.has(dedupeKey)) {
      throw new Error(
        `lookup family core witness registry duplicate normalizedSurface/entityId=${JSON.stringify(dedupeKey)}`,
      );
    }
    seen.add(dedupeKey);
  }
}

export function loadLookupV2FamilyCoreWitnessRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_CORE_WITNESS_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): readonly LookupV2FamilyCoreWitnessRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  const rows: LookupV2FamilyCoreWitnessRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }

  assertLookupV2FamilyCoreWitnessRegistryRowsValid({ rows, knownEntityIds });
  return rows.sort((left, right) =>
    left.normalizedSurface.localeCompare(right.normalizedSurface)
    || left.entityId.localeCompare(right.entityId)
    || left.surface.localeCompare(right.surface),
  );
}

export function buildLookupV2FamilyCoreWitnessRegistryMap(
  rows: readonly LookupV2FamilyCoreWitnessRegistryRow[],
): ReadonlyMap<string, readonly LookupV2FamilyCoreWitnessRegistryRow[]> {
  const byNormalizedSurface = new Map<string, LookupV2FamilyCoreWitnessRegistryRow[]>();
  for (const row of rows) {
    const existing = byNormalizedSurface.get(row.normalizedSurface) ?? [];
    existing.push(row);
    byNormalizedSurface.set(row.normalizedSurface, existing);
  }
  return new Map(
    [...byNormalizedSurface.entries()].map(([normalizedSurface, group]) => [
      normalizedSurface,
      [...group].sort((left, right) =>
        left.entityId.localeCompare(right.entityId) || left.surface.localeCompare(right.surface),
      ),
    ]),
  );
}

