import fs from 'node:fs';
import path from 'node:path';

/**
 * Reviewed scope-level support / NIL truth (final architecture L3 / Support SoT).
 *
 * Keyed by semanticScopeKey (NOT benchmarkGoldHint / family) so a vintage hole
 * is expressed at the correct granularity — "the 2012 anchor is absent" is a
 * property of `line::angelus::...::2012::...`, not of the whole angelus family.
 * Supersedes the legacy family-level support registry.
 */
export const LOOKUP_V2_SCOPE_SUPPORT_STATUSES = [
  'active_entity_absent',
  'vintage_anchor_absent',
  'secondary_line_only',
] as const;
export type LookupV2ScopeSupportStatus = (typeof LOOKUP_V2_SCOPE_SUPPORT_STATUSES)[number];

export interface LookupV2SemanticScopeSupportRegistryRow {
  readonly semanticScopeKey: string;
  readonly supportStatus: LookupV2ScopeSupportStatus;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
  readonly evidenceClass: 'scope_support_review';
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-semantic-scope-support-registry-v1.jsonl',
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

function parseSupportStatus(value: unknown, label: string): LookupV2ScopeSupportStatus {
  if (!LOOKUP_V2_SCOPE_SUPPORT_STATUSES.includes(value as LookupV2ScopeSupportStatus)) {
    throw new Error(`${label} has invalid supportStatus`);
  }
  return value as LookupV2ScopeSupportStatus;
}

function parseEvidenceClass(
  value: unknown,
  label: string,
): LookupV2SemanticScopeSupportRegistryRow['evidenceClass'] {
  if (value !== 'scope_support_review') {
    throw new Error(`${label} has invalid evidenceClass`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2SemanticScopeSupportRegistryRow {
  const label = `lookup semantic scope support registry row ${lineNo}`;
  return {
    semanticScopeKey: parseNonEmptyString(raw.semanticScopeKey, `${label} semanticScopeKey`),
    supportStatus: parseSupportStatus(raw.supportStatus, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
    evidenceClass: parseEvidenceClass(raw.evidenceClass, `${label} evidenceClass`),
  };
}

export function assertLookupV2SemanticScopeSupportRegistryRowsValid(args: {
  readonly rows: readonly LookupV2SemanticScopeSupportRegistryRow[];
}): void {
  const seen = new Set<string>();
  for (const row of args.rows) {
    if (seen.has(row.semanticScopeKey)) {
      throw new Error(`lookup semantic scope support registry duplicate semanticScopeKey=${JSON.stringify(row.semanticScopeKey)}`);
    }
    seen.add(row.semanticScopeKey);
  }
}

export function loadLookupV2SemanticScopeSupportRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
): readonly LookupV2SemanticScopeSupportRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2SemanticScopeSupportRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2SemanticScopeSupportRegistryRowsValid({ rows });
  return rows.slice().sort((left, right) => left.semanticScopeKey.localeCompare(right.semanticScopeKey));
}

export function loadLookupV2SemanticScopeSupportRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_SUPPORT_REGISTRY_PATH,
): ReadonlyMap<string, LookupV2SemanticScopeSupportRegistryRow> {
  return buildLookupV2SemanticScopeSupportRegistryMap(loadLookupV2SemanticScopeSupportRegistrySync(registryPath));
}

export function buildLookupV2SemanticScopeSupportRegistryMap(
  rows: readonly LookupV2SemanticScopeSupportRegistryRow[],
): ReadonlyMap<string, LookupV2SemanticScopeSupportRegistryRow> {
  return new Map(rows.map((row) => [row.semanticScopeKey, row] as const));
}

export function serializeLookupV2SemanticScopeSupportRegistryRows(
  rows: readonly LookupV2SemanticScopeSupportRegistryRow[],
): string {
  const ordered = rows.slice().sort((left, right) => left.semanticScopeKey.localeCompare(right.semanticScopeKey));
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
