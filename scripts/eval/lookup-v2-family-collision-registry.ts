import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

export interface LookupV2FamilyCollisionRegistryRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly collisionStatus: 'active_entity_collision';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'collision_support_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-family-collision-registry-v1.jsonl',
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

function parseCollisionStatus(
  value: unknown,
  label: string,
): LookupV2FamilyCollisionRegistryRow['collisionStatus'] {
  if (value !== 'active_entity_collision') {
    throw new Error(`${label} has invalid collisionStatus`);
  }
  return value;
}

function parseEvidenceClass(
  value: unknown,
  label: string,
): LookupV2FamilyCollisionRegistryRow['evidenceClass'] {
  if (value !== 'collision_support_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2FamilyCollisionRegistryRow {
  const label = `lookup family collision registry row ${lineNo}`;
  return {
    benchmarkGoldHint: parseNonEmptyString(raw.benchmarkGoldHint, `${label} benchmarkGoldHint`),
    normalizedBenchmarkGoldHint: parseNonEmptyString(raw.normalizedBenchmarkGoldHint, `${label} normalizedBenchmarkGoldHint`),
    collisionStatus: parseCollisionStatus(raw.collisionStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function assertLookupV2FamilyCollisionRegistryRowsValid(args: {
  readonly rows: readonly LookupV2FamilyCollisionRegistryRow[];
}): void {
  const seen = new Set<string>();
  for (const row of args.rows) {
    const normalizedBenchmarkGoldHint = normalizeForMatch(row.benchmarkGoldHint);
    if (normalizedBenchmarkGoldHint.length === 0) {
      throw new Error(`lookup family collision registry row "${row.benchmarkGoldHint}" normalizes to empty`);
    }
    if (row.normalizedBenchmarkGoldHint !== normalizedBenchmarkGoldHint) {
      throw new Error(
        `lookup family collision registry normalizedBenchmarkGoldHint mismatch for benchmarkGoldHint=${JSON.stringify(row.benchmarkGoldHint)}`,
      );
    }
    if (seen.has(row.normalizedBenchmarkGoldHint)) {
      throw new Error(
        `lookup family collision registry duplicate normalizedBenchmarkGoldHint=${JSON.stringify(row.normalizedBenchmarkGoldHint)}`,
      );
    }
    seen.add(row.normalizedBenchmarkGoldHint);
  }
}

export function loadLookupV2FamilyCollisionRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH,
): readonly LookupV2FamilyCollisionRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2FamilyCollisionRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2FamilyCollisionRegistryRowsValid({ rows });
  return rows.sort((left, right) =>
    left.normalizedBenchmarkGoldHint.localeCompare(right.normalizedBenchmarkGoldHint)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}

export function buildLookupV2FamilyCollisionRegistryMap(
  rows: readonly LookupV2FamilyCollisionRegistryRow[],
): ReadonlyMap<string, LookupV2FamilyCollisionRegistryRow> {
  return new Map(rows.map((row) => [row.normalizedBenchmarkGoldHint, row] as const));
}

export function loadLookupV2FamilyCollisionRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_COLLISION_REGISTRY_PATH,
): ReadonlyMap<string, LookupV2FamilyCollisionRegistryRow> {
  return buildLookupV2FamilyCollisionRegistryMap(loadLookupV2FamilyCollisionRegistrySync(registryPath));
}
