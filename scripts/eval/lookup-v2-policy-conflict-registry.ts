import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

export interface LookupPolicyConflictRegistryRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly stretchExpectedStatus: 'ambiguous';
  readonly authorityStatus: 'resolved';
  readonly authorityEntityId: string;
  readonly conflictType: 'short_form_collision' | 'broad_icon_collision' | 'family_collision';
  readonly conflictBenchmarkHints?: readonly string[] | undefined;
  readonly sourceEvidence: string;
  readonly reviewedAt: string;
}

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'lookup-v2',
);

export const DEFAULT_LOOKUP_POLICY_CONFLICT_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-policy-conflict-registry-v1.jsonl',
);

function parseSurface(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing surface`);
  }
  return value.trim();
}

function parseLocale(value: unknown, label: string): 'ko' | 'global' {
  if (value !== 'ko' && value !== 'global') {
    throw new Error(`${label} has invalid locale`);
  }
  return value;
}

function parseStretchExpectedStatus(value: unknown, label: string): 'ambiguous' {
  if (value !== 'ambiguous') {
    throw new Error(`${label} has invalid stretchExpectedStatus`);
  }
  return value;
}

function parseAuthorityStatus(value: unknown, label: string): 'resolved' {
  if (value !== 'resolved') {
    throw new Error(`${label} has invalid authorityStatus`);
  }
  return value;
}

function parseAuthorityEntityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing authorityEntityId`);
  }
  return value.trim();
}

function parseConflictType(
  value: unknown,
  label: string,
): LookupPolicyConflictRegistryRow['conflictType'] {
  if (
    value !== 'short_form_collision'
    && value !== 'broad_icon_collision'
    && value !== 'family_collision'
  ) {
    throw new Error(`${label} has invalid conflictType`);
  }
  return value;
}

function parseConflictBenchmarkHints(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} has invalid conflictBenchmarkHints`);
  }
  const hints = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (hints.length !== value.length) {
    throw new Error(`${label} has invalid conflictBenchmarkHints`);
  }
  const normalized = new Set<string>();
  for (const hint of hints) {
    const key = normalizeForMatch(hint);
    if (key.length === 0) {
      throw new Error(`${label} has empty conflictBenchmarkHint`);
    }
    if (normalized.has(key)) {
      throw new Error(`${label} has duplicate conflictBenchmarkHint=${JSON.stringify(hint)}`);
    }
    normalized.add(key);
  }
  return hints;
}

function parseSourceEvidence(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing sourceEvidence`);
  }
  return value.trim();
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseRow(raw: Record<string, unknown>, lineNo: number): LookupPolicyConflictRegistryRow {
  const label = `lookup policy conflict registry row ${lineNo}`;
  return {
    surface: parseSurface(raw.surface, label),
    locale: parseLocale(raw.locale, label),
    stretchExpectedStatus: parseStretchExpectedStatus(raw.stretchExpectedStatus, label),
    authorityStatus: parseAuthorityStatus(raw.authorityStatus, label),
    authorityEntityId: parseAuthorityEntityId(raw.authorityEntityId, label),
    conflictType: parseConflictType(raw.conflictType, label),
    ...(raw.conflictBenchmarkHints !== undefined
      ? { conflictBenchmarkHints: parseConflictBenchmarkHints(raw.conflictBenchmarkHints, label) }
      : {}),
    sourceEvidence: parseSourceEvidence(raw.sourceEvidence, label),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
  };
}

export function loadLookupPolicyConflictRegistrySync(
  registryPath: string = DEFAULT_LOOKUP_POLICY_CONFLICT_REGISTRY_PATH,
): readonly LookupPolicyConflictRegistryRow[] {
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  const raw = fs.readFileSync(registryPath, 'utf8');
  const rows: LookupPolicyConflictRegistryRow[] = [];
  const normalizedOwners = new Map<string, LookupPolicyConflictRegistryRow>();
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const row = parseRow(JSON.parse(trimmed) as Record<string, unknown>, index + 1);
    const normalized = normalizeForMatch(row.surface);
    if (normalized.length === 0) {
      throw new Error(`lookup policy conflict registry row "${row.surface}" normalizes to empty`);
    }
    const existing = normalizedOwners.get(normalized);
    if (existing !== undefined) {
      throw new Error(
        `lookup policy conflict registry collision on "${row.surface}" vs "${existing.surface}" (${normalized})`,
      );
    }
    normalizedOwners.set(normalized, row);
    rows.push(row);
  }
  return rows;
}

export function buildLookupPolicyConflictBenchmarkHintSet(
  rows: readonly LookupPolicyConflictRegistryRow[],
): ReadonlySet<string> {
  const hints = new Set<string>();
  for (const row of rows) {
    for (const hint of row.conflictBenchmarkHints ?? []) {
      hints.add(normalizeForMatch(hint));
    }
  }
  return hints;
}

export function buildLookupPolicyConflictBenchmarkHintOwnerMap(
  rows: readonly LookupPolicyConflictRegistryRow[],
): ReadonlyMap<string, LookupPolicyConflictRegistryRow> {
  const owners = new Map<string, LookupPolicyConflictRegistryRow>();
  for (const row of rows) {
    for (const hint of row.conflictBenchmarkHints ?? []) {
      const normalized = normalizeForMatch(hint);
      const existing = owners.get(normalized);
      if (existing !== undefined) {
        throw new Error(
          `lookup policy conflict benchmark hint collision on ${JSON.stringify(hint)} between ${JSON.stringify(existing.surface)} and ${JSON.stringify(row.surface)}`,
        );
      }
      owners.set(normalized, row);
    }
  }
  return owners;
}

export function loadLookupPolicyConflictBenchmarkHintSetSync(
  registryPath: string = DEFAULT_LOOKUP_POLICY_CONFLICT_REGISTRY_PATH,
): ReadonlySet<string> {
  return buildLookupPolicyConflictBenchmarkHintSet(loadLookupPolicyConflictRegistrySync(registryPath));
}

export function loadLookupPolicyConflictBenchmarkHintOwnerMapSync(
  registryPath: string = DEFAULT_LOOKUP_POLICY_CONFLICT_REGISTRY_PATH,
): ReadonlyMap<string, LookupPolicyConflictRegistryRow> {
  return buildLookupPolicyConflictBenchmarkHintOwnerMap(loadLookupPolicyConflictRegistrySync(registryPath));
}
