import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from './lookup-v2-runtime-known-entity-ids.js';

export interface LookupV2PolicyFamilyDecisionRegistryRow {
  readonly policyConflictSurface: string;
  readonly entityId: string;
  readonly decision: 'promote_exact_safe' | 'keep_policy_conflict' | 'needs_target';
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

export const DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-policy-family-decision-registry-v1.jsonl',
);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing value`);
  }
  return value.trim();
}

function parseDecision(value: unknown, label: string): LookupV2PolicyFamilyDecisionRegistryRow['decision'] {
  if (
    value !== 'promote_exact_safe'
    && value !== 'keep_policy_conflict'
    && value !== 'needs_target'
  ) {
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

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupV2PolicyFamilyDecisionRegistryRow {
  const label = `lookup policy family decision registry row ${lineNo}`;
  return {
    policyConflictSurface: parseNonEmptyString(raw.policyConflictSurface, `${label} policyConflictSurface`),
    entityId: parseNonEmptyString(raw.entityId, `${label} entityId`),
    decision: parseDecision(raw.decision, label),
    reviewedBy: parseNonEmptyString(raw.reviewedBy, `${label} reviewedBy`),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
    decisionReason: parseNonEmptyString(raw.decisionReason, `${label} decisionReason`),
  };
}

export function buildLookupV2PolicyFamilyDecisionKey(
  policyConflictSurface: string,
  entityId: string,
): string {
  return `${normalizeForMatch(policyConflictSurface)}::${entityId}`;
}

export function assertLookupV2PolicyFamilyDecisionRegistryRowsValid(args: {
  readonly rows: readonly LookupV2PolicyFamilyDecisionRegistryRow[];
  readonly knownEntityIds?: ReadonlySet<string>;
}): void {
  const knownEntityIds = args.knownEntityIds ?? loadLookupV2RuntimeKnownEntityIdsSync();
  const keys = new Set<string>();

  for (const row of args.rows) {
    const normalizedSurface = normalizeForMatch(row.policyConflictSurface);
    if (normalizedSurface.length === 0) {
      throw new Error(`lookup policy family decision registry row "${row.policyConflictSurface}" normalizes to empty`);
    }
    if (!knownEntityIds.has(row.entityId)) {
      throw new Error(
        `lookup policy family decision registry references unknown entityId=${JSON.stringify(row.entityId)} for surface=${JSON.stringify(row.policyConflictSurface)}`,
      );
    }
    const key = buildLookupV2PolicyFamilyDecisionKey(row.policyConflictSurface, row.entityId);
    if (keys.has(key)) {
      throw new Error(
        `lookup policy family decision registry duplicate key for surface=${JSON.stringify(row.policyConflictSurface)} entityId=${JSON.stringify(row.entityId)}`,
      );
    }
    keys.add(key);
  }
}

export function loadLookupV2PolicyFamilyDecisionRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): readonly LookupV2PolicyFamilyDecisionRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  const rows: LookupV2PolicyFamilyDecisionRegistryRow[] = [];
  for (const [index, line] of fs.readFileSync(registryPath, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }

  assertLookupV2PolicyFamilyDecisionRegistryRowsValid({ rows, knownEntityIds });
  return rows;
}

export function buildLookupV2PolicyFamilyDecisionMap(
  rows: readonly LookupV2PolicyFamilyDecisionRegistryRow[],
): ReadonlyMap<string, LookupV2PolicyFamilyDecisionRegistryRow> {
  return new Map(
    rows.map((row) => [buildLookupV2PolicyFamilyDecisionKey(row.policyConflictSurface, row.entityId), row] as const),
  );
}

export function loadLookupV2PolicyFamilyDecisionMapSync(
  registryPath: string = DEFAULT_LOOKUP_V2_POLICY_FAMILY_DECISION_REGISTRY_PATH,
  knownEntityIds: ReadonlySet<string> = loadLookupV2RuntimeKnownEntityIdsSync(),
): ReadonlyMap<string, LookupV2PolicyFamilyDecisionRegistryRow> {
  return buildLookupV2PolicyFamilyDecisionMap(
    loadLookupV2PolicyFamilyDecisionRegistrySync(registryPath, knownEntityIds),
  );
}

export function sortLookupV2PolicyFamilyDecisionRegistryRows(
  rows: readonly LookupV2PolicyFamilyDecisionRegistryRow[],
): readonly LookupV2PolicyFamilyDecisionRegistryRow[] {
  return rows
    .slice()
    .sort((left, right) =>
      normalizeForMatch(left.policyConflictSurface).localeCompare(normalizeForMatch(right.policyConflictSurface))
      || left.entityId.localeCompare(right.entityId)
      || left.decision.localeCompare(right.decision)
      || left.reviewedAt.localeCompare(right.reviewedAt),
    );
}

export function serializeLookupV2PolicyFamilyDecisionRegistryRows(
  rows: readonly LookupV2PolicyFamilyDecisionRegistryRow[],
): string {
  const ordered = sortLookupV2PolicyFamilyDecisionRegistryRows(rows);
  return ordered.map((row) => JSON.stringify(row)).join('\n') + (ordered.length > 0 ? '\n' : '');
}
