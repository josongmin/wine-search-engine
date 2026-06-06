import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

export interface LookupV2FamilySupportRegistryRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly supportStatus: 'active_catalog_absent' | 'vintage_anchor_absent' | 'secondary_line_only';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'catalog_support_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_FAMILY_SUPPORT_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-family-support-registry-v1.jsonl',
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

function parseSupportStatus(
  value: unknown,
  label: string,
): LookupV2FamilySupportRegistryRow['supportStatus'] {
  if (
    value !== 'active_catalog_absent'
    && value !== 'vintage_anchor_absent'
    && value !== 'secondary_line_only'
  ) {
    throw new Error(`${label} has invalid supportStatus`);
  }
  return value;
}

function parseEvidenceClass(
  value: unknown,
  label: string,
): LookupV2FamilySupportRegistryRow['evidenceClass'] {
  if (value !== 'catalog_support_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2FamilySupportRegistryRow {
  const label = `lookup family support registry row ${lineNo}`;
  return {
    benchmarkGoldHint: parseNonEmptyString(raw.benchmarkGoldHint, `${label} benchmarkGoldHint`),
    normalizedBenchmarkGoldHint: parseNonEmptyString(raw.normalizedBenchmarkGoldHint, `${label} normalizedBenchmarkGoldHint`),
    supportStatus: parseSupportStatus(raw.supportStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function assertLookupV2FamilySupportRegistryRowsValid(args: {
  readonly rows: readonly LookupV2FamilySupportRegistryRow[];
}): void {
  const seen = new Set<string>();
  for (const row of args.rows) {
    const normalizedBenchmarkGoldHint = normalizeForMatch(row.benchmarkGoldHint);
    if (normalizedBenchmarkGoldHint.length === 0) {
      throw new Error(`lookup family support registry row "${row.benchmarkGoldHint}" normalizes to empty`);
    }
    if (row.normalizedBenchmarkGoldHint !== normalizedBenchmarkGoldHint) {
      throw new Error(
        `lookup family support registry normalizedBenchmarkGoldHint mismatch for benchmarkGoldHint=${JSON.stringify(row.benchmarkGoldHint)}`,
      );
    }
    if (seen.has(row.normalizedBenchmarkGoldHint)) {
      throw new Error(
        `lookup family support registry duplicate normalizedBenchmarkGoldHint=${JSON.stringify(row.normalizedBenchmarkGoldHint)}`,
      );
    }
    seen.add(row.normalizedBenchmarkGoldHint);
  }
}

export function loadLookupV2FamilySupportRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_SUPPORT_REGISTRY_PATH,
): readonly LookupV2FamilySupportRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2FamilySupportRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2FamilySupportRegistryRowsValid({ rows });
  return rows.sort((left, right) =>
    left.normalizedBenchmarkGoldHint.localeCompare(right.normalizedBenchmarkGoldHint)
    || left.reviewedAt.localeCompare(right.reviewedAt),
  );
}

export function buildLookupV2FamilySupportRegistryMap(
  rows: readonly LookupV2FamilySupportRegistryRow[],
): ReadonlyMap<string, LookupV2FamilySupportRegistryRow> {
  return new Map(rows.map((row) => [row.normalizedBenchmarkGoldHint, row] as const));
}

export function loadLookupV2FamilySupportRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_FAMILY_SUPPORT_REGISTRY_PATH,
): ReadonlyMap<string, LookupV2FamilySupportRegistryRow> {
  return buildLookupV2FamilySupportRegistryMap(loadLookupV2FamilySupportRegistrySync(registryPath));
}
