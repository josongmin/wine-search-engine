import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { parseNdjson } from './ndjson.js';
import type { EnrichedSilverRecord } from './types.js';

export const DEFAULT_CANONICAL_ENRICHMENT_OVERLAY_PATH =
  resolveDataPath('data/silver-final.ndjson');

export interface CanonicalEnrichmentOverlayOptions {
  readonly path?: string;
  readonly required?: boolean;
}

export type CanonicalEnrichmentOverlayRecord = Pick<
  EnrichedSilverRecord,
  | 'sourceId'
  | 'country'
  | 'region'
  | 'appellation'
  | 'regionHierarchy'
  | 'grapePrimary'
  | 'grapes'
  | 'wineType'
  | 'flavorProfiles'
  | 'pairingTags'
  | 'searchTextKo'
>;

export type CanonicalEnrichmentOverlayMap =
  ReadonlyMap<string, CanonicalEnrichmentOverlayRecord>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

export async function loadCanonicalEnrichmentOverlay(
  options: CanonicalEnrichmentOverlayOptions = {},
): Promise<CanonicalEnrichmentOverlayMap> {
  const overlayPath = options.path ?? DEFAULT_CANONICAL_ENRICHMENT_OVERLAY_PATH;
  if (!existsSync(overlayPath)) {
    if (options.required === true) {
      throw new Error(`Canonical enrichment overlay missing: ${overlayPath}`);
    }
    return new Map();
  }

  const raw = await fs.readFile(overlayPath, 'utf8');
  const records = parseNdjson<EnrichedSilverRecord>(raw, overlayPath).records;
  return new Map(records.map((record) => [
    record.sourceId,
    {
      sourceId: record.sourceId,
      country: record.country,
      region: record.region,
      appellation: record.appellation,
      regionHierarchy: record.regionHierarchy,
      grapePrimary: record.grapePrimary,
      grapes: record.grapes,
      wineType: record.wineType,
      flavorProfiles: record.flavorProfiles,
      pairingTags: record.pairingTags,
      searchTextKo: record.searchTextKo,
    } satisfies CanonicalEnrichmentOverlayRecord,
  ]));
}

export function applyCanonicalEnrichmentOverlay(
  record: EnrichedSilverRecord,
  overlayMap: CanonicalEnrichmentOverlayMap,
): EnrichedSilverRecord {
  const overlay = overlayMap.get(record.sourceId);
  if (overlay === undefined) {
    return record;
  }

  const next: Partial<Mutable<EnrichedSilverRecord>> = {};

  if (isNonEmptyString(overlay.country)) {
    next.country = overlay.country;
  }
  if (isNonEmptyString(overlay.region)) {
    next.region = overlay.region;
  }
  if (isNonEmptyString(overlay.appellation)) {
    next.appellation = overlay.appellation;
  }
  if (isNonEmptyStringArray(overlay.regionHierarchy)) {
    next.regionHierarchy = [...overlay.regionHierarchy];
  }
  if (isNonEmptyString(overlay.grapePrimary)) {
    next.grapePrimary = overlay.grapePrimary;
  }
  if (isNonEmptyStringArray(overlay.grapes)) {
    next.grapes = [...overlay.grapes];
  }
  if (isNonEmptyString(overlay.wineType)) {
    next.wineType = overlay.wineType;
  }
  if (isNonEmptyStringArray(overlay.flavorProfiles)) {
    next.flavorProfiles = [...overlay.flavorProfiles];
  }
  if (isNonEmptyStringArray(overlay.pairingTags)) {
    next.pairingTags = [...overlay.pairingTags];
  }
  if (isNonEmptyString(overlay.searchTextKo)) {
    next.searchTextKo = overlay.searchTextKo;
  }

  return Object.keys(next).length > 0
    ? { ...record, ...next }
    : record;
}

export function reconcileCanonicalEnrichmentRecords(
  records: readonly EnrichedSilverRecord[],
  overlayMap: CanonicalEnrichmentOverlayMap,
): readonly EnrichedSilverRecord[] {
  return records.map((record) => applyCanonicalEnrichmentOverlay(record, overlayMap));
}
