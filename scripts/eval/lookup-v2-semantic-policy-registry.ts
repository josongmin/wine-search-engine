import fs from 'node:fs';
import path from 'node:path';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

export interface LookupV2SemanticPolicyRegistryRow {
  readonly semanticConflictKey: string;
  readonly conflictClass: 'short_form_collision' | 'broad_icon_collision' | 'family_collision';
  readonly entityId: string;
  readonly decision: 'promote_exact_safe' | 'keep_ambiguous' | 'needs_scope_target';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly decisionReason: string;
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-semantic-policy-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseConflictClass(value: unknown, label: string): LookupV2SemanticPolicyRegistryRow['conflictClass'] {
  if (value !== 'short_form_collision' && value !== 'broad_icon_collision' && value !== 'family_collision') {
    throw new Error(`${label} has invalid conflictClass`);
  }
  return value;
}

function parseDecision(value: unknown, label: string): LookupV2SemanticPolicyRegistryRow['decision'] {
  if (value !== 'promote_exact_safe' && value !== 'keep_ambiguous' && value !== 'needs_scope_target') {
    throw new Error(`${label} has invalid decision`);
  }
  return value;
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2SemanticPolicyRegistryRow {
  const label = `lookup semantic policy registry row ${lineNo}`;
  return {
    semanticConflictKey: parseNonEmptyString(raw.semanticConflictKey, `${label} semanticConflictKey`),
    conflictClass: parseConflictClass(raw.conflictClass, label),
    entityId: parseNonEmptyString(raw.entityId, `${label} entityId`),
    decision: parseDecision(raw.decision, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
  };
}

export function buildLookupV2SemanticPolicyRegistryKey(
  semanticConflictKey: string,
  entityId: string,
): string {
  return `${semanticConflictKey}::${entityId}`;
}

export function assertLookupV2SemanticPolicyRegistryRowsValid(args: {
  readonly rows: readonly LookupV2SemanticPolicyRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): void {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const keys = new Set<string>();
  for (const row of args.rows) {
    if (!knownEntityIds.has(row.entityId)) {
      throw new Error(`lookup semantic policy registry references unknown entityId=${JSON.stringify(row.entityId)} for semanticConflictKey=${JSON.stringify(row.semanticConflictKey)}`);
    }
    const key = buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.entityId);
    if (keys.has(key)) {
      throw new Error(`lookup semantic policy registry duplicate key=${JSON.stringify(key)}`);
    }
    keys.add(key);
  }
}

export function loadLookupV2SemanticPolicyRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): readonly LookupV2SemanticPolicyRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const rows: LookupV2SemanticPolicyRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  assertLookupV2SemanticPolicyRegistryRowsValid({ rows, knownEntityIds });
  return rows;
}

export function buildLookupV2SemanticPolicyRegistryMap(
  rows: readonly LookupV2SemanticPolicyRegistryRow[],
): ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow> {
  return new Map(
    rows.map((row) => [buildLookupV2SemanticPolicyRegistryKey(row.semanticConflictKey, row.entityId), row] as const),
  );
}

export function loadLookupV2SemanticPolicyRegistryMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_SEMANTIC_POLICY_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): ReadonlyMap<string, LookupV2SemanticPolicyRegistryRow> {
  return buildLookupV2SemanticPolicyRegistryMap(
    loadLookupV2SemanticPolicyRegistrySync(registryPath, knownEntityIds),
  );
}

export function sortLookupV2SemanticPolicyRegistryRows(
  rows: readonly LookupV2SemanticPolicyRegistryRow[],
): readonly LookupV2SemanticPolicyRegistryRow[] {
  return rows
    .slice()
    .sort((left, right) =>
      left.semanticConflictKey.localeCompare(right.semanticConflictKey)
      || left.entityId.localeCompare(right.entityId)
      || left.decision.localeCompare(right.decision)
      || left.reviewedAt.localeCompare(right.reviewedAt),
    );
}

export function serializeLookupV2SemanticPolicyRegistryRows(
  rows: readonly LookupV2SemanticPolicyRegistryRow[],
): string {
  const ordered = sortLookupV2SemanticPolicyRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
