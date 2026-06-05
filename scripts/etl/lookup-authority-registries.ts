import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type {
  LookupAmbiguityRuntimeEntry,
  LookupConceptRedirectRuntimeEntry,
} from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';

export interface LookupAmbiguityRegistryRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly ambiguityTypes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
  readonly sourceEvidence: string;
  readonly reviewedAt: string;
}

export interface LookupConceptRedirectRegistryRow {
  readonly surface: string;
  readonly locale: 'ko' | 'global';
  readonly conceptClass: LookupConceptRedirectRuntimeEntry['conceptClass'];
  readonly redirectReason: LookupConceptRedirectRuntimeEntry['redirectReason'];
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

export const DEFAULT_LOOKUP_AMBIGUITY_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-ambiguity-registry-v1.jsonl',
);

export const DEFAULT_LOOKUP_CONCEPT_REDIRECT_REGISTRY_PATH = path.join(
  DATA_DIR,
  'lookup-concept-redirect-registry-v1.jsonl',
);

interface RawLookupAmbiguityRegistryRow {
  readonly surface?: unknown;
  readonly locale?: unknown;
  readonly ambiguityTypes?: unknown;
  readonly severity?: unknown;
  readonly sourceEvidence?: unknown;
  readonly reviewedAt?: unknown;
}

interface RawLookupConceptRedirectRegistryRow {
  readonly surface?: unknown;
  readonly locale?: unknown;
  readonly conceptClass?: unknown;
  readonly redirectReason?: unknown;
  readonly sourceEvidence?: unknown;
  readonly reviewedAt?: unknown;
}

function parseReviewedAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} has invalid reviewedAt`);
  }
  return value;
}

function parseLocale(value: unknown, label: string): 'ko' | 'global' {
  if (value !== 'ko' && value !== 'global') {
    throw new Error(`${label} has invalid locale`);
  }
  return value;
}

function parseSurface(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing surface`);
  }
  return value.trim();
}

function parseSourceEvidence(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing sourceEvidence`);
  }
  return value.trim();
}

function parseAmbiguityTypes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} missing ambiguityTypes`);
  }
  const parsed = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (parsed.length !== value.length) {
    throw new Error(`${label} has invalid ambiguityTypes`);
  }
  return [...new Set(parsed.map((entry) => entry.trim()))].sort();
}

function parseAmbiguitySeverity(value: unknown, label: string): 'low' | 'medium' | 'high' {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new Error(`${label} has invalid severity`);
  }
  return value;
}

function parseConceptClass(
  value: unknown,
  label: string,
): LookupConceptRedirectRuntimeEntry['conceptClass'] {
  if (
    value !== 'grape'
    && value !== 'region'
    && value !== 'style'
    && value !== 'recommendation'
    && value !== 'pairing'
    && value !== 'generic'
  ) {
    throw new Error(`${label} has invalid conceptClass`);
  }
  return value;
}

function parseRedirectReason(
  value: unknown,
  label: string,
): LookupConceptRedirectRuntimeEntry['redirectReason'] {
  if (value !== 'concept_query' && value !== 'generic_non_entity_query') {
    throw new Error(`${label} has invalid redirectReason`);
  }
  return value;
}

function parseLookupAmbiguityRegistryRow(
  raw: RawLookupAmbiguityRegistryRow,
  lineNo: number,
): LookupAmbiguityRegistryRow {
  const label = `lookup ambiguity registry row ${lineNo}`;
  return {
    surface: parseSurface(raw.surface, label),
    locale: parseLocale(raw.locale, label),
    ambiguityTypes: parseAmbiguityTypes(raw.ambiguityTypes, label),
    severity: parseAmbiguitySeverity(raw.severity, label),
    sourceEvidence: parseSourceEvidence(raw.sourceEvidence, label),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
  };
}

function parseLookupConceptRedirectRegistryRow(
  raw: RawLookupConceptRedirectRegistryRow,
  lineNo: number,
): LookupConceptRedirectRegistryRow {
  const label = `lookup concept redirect registry row ${lineNo}`;
  return {
    surface: parseSurface(raw.surface, label),
    locale: parseLocale(raw.locale, label),
    conceptClass: parseConceptClass(raw.conceptClass, label),
    redirectReason: parseRedirectReason(raw.redirectReason, label),
    sourceEvidence: parseSourceEvidence(raw.sourceEvidence, label),
    reviewedAt: parseReviewedAt(raw.reviewedAt, label),
  };
}

async function loadJsonlRows<T>(
  filePath: string,
  parser: (raw: Record<string, unknown>, lineNo: number) => T,
): Promise<readonly T[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const rows: T[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push(parser(JSON.parse(trimmed) as Record<string, unknown>, index + 1));
  }
  return rows;
}

export async function loadLookupAmbiguityRegistry(
  registryPath: string = DEFAULT_LOOKUP_AMBIGUITY_REGISTRY_PATH,
): Promise<readonly LookupAmbiguityRegistryRow[]> {
  const rows = await loadJsonlRows<LookupAmbiguityRegistryRow>(
    registryPath,
    (raw, lineNo) => parseLookupAmbiguityRegistryRow(raw, lineNo),
  );
  const owners = new Map<string, LookupAmbiguityRegistryRow>();
  for (const row of rows) {
    const normalizedForm = normalizeForMatch(row.surface);
    if (normalizedForm.length === 0) {
      throw new Error(`lookup ambiguity registry row "${row.surface}" normalizes to empty`);
    }
    const existing = owners.get(normalizedForm);
    if (existing !== undefined) {
      throw new Error(
        `lookup ambiguity registry collision on "${row.surface}" vs "${existing.surface}" (${normalizedForm})`,
      );
    }
    owners.set(normalizedForm, row);
  }
  return rows;
}

export async function loadLookupConceptRedirectRegistry(
  registryPath: string = DEFAULT_LOOKUP_CONCEPT_REDIRECT_REGISTRY_PATH,
): Promise<readonly LookupConceptRedirectRegistryRow[]> {
  const rows = await loadJsonlRows<LookupConceptRedirectRegistryRow>(
    registryPath,
    (raw, lineNo) => parseLookupConceptRedirectRegistryRow(raw, lineNo),
  );
  const owners = new Map<string, LookupConceptRedirectRegistryRow>();
  for (const row of rows) {
    const normalizedForm = normalizeForMatch(row.surface);
    if (normalizedForm.length === 0) {
      throw new Error(`lookup concept redirect registry row "${row.surface}" normalizes to empty`);
    }
    const existing = owners.get(normalizedForm);
    if (existing !== undefined) {
      throw new Error(
        `lookup concept redirect registry collision on "${row.surface}" vs "${existing.surface}" (${normalizedForm})`,
      );
    }
    owners.set(normalizedForm, row);
  }
  return rows;
}

export function buildLookupAmbiguityRegistryEntries(
  rows: readonly LookupAmbiguityRegistryRow[],
): readonly LookupAmbiguityRuntimeEntry[] {
  return rows
    .map((row) => ({
      normalizedForm: normalizeForMatch(row.surface),
      types: [...row.ambiguityTypes],
      severity: row.severity,
    }))
    .sort((left, right) => left.normalizedForm.localeCompare(right.normalizedForm));
}

export function buildLookupConceptRedirectRegistryEntries(
  rows: readonly LookupConceptRedirectRegistryRow[],
): readonly LookupConceptRedirectRuntimeEntry[] {
  return rows
    .map((row) => ({
      normalizedForm: normalizeForMatch(row.surface),
      locale: row.locale,
      conceptClass: row.conceptClass,
      redirectReason: row.redirectReason,
      sourceEvidence: row.sourceEvidence,
    }))
    .sort((left, right) => left.normalizedForm.localeCompare(right.normalizedForm));
}
