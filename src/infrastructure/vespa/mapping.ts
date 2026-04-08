/**
 * Pure field-mapping functions between the domain {@link RetrievalDocument}
 * and Vespa document fields.
 *
 * No I/O occurs in this module — all functions are deterministic transforms.
 */

import type {
  RetrievalDocument,
  DocumentSparseVector,
  RetrievalHitProjection,
  RetrievalFeatureProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import {
  RETRIEVAL_HIT_SUMMARY_KEYS,
  type RetrievalHitSummary,
  type RetrievalHitSummaryKey,
} from '../../domain/retrieval/port/search-index.port.js';
import { createEntityId } from '../../domain/shared/types/entity-id.js';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function getString(
  fields: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const v = fields[key];
  return isString(v) ? v : fallback;
}

function getNumber(
  fields: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const v = fields[key];
  return isNumber(v) ? v : fallback;
}

function getBoolean(
  fields: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const v = fields[key];
  return isBoolean(v) ? v : fallback;
}

function getStringArray(
  fields: Record<string, unknown>,
  key: string,
): readonly string[] {
  const v = fields[key];
  return isStringArray(v) ? v : [];
}

/**
 * Parses a Vespa mapped sparse tensor (tensor<float>(token{})) back into a
 * {@link DocumentSparseVector}. Returns `undefined` for absent or malformed values.
 */
function parseSparseWeightsTensor(raw: unknown): DocumentSparseVector | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const cells = obj['cells'];
  if (!Array.isArray(cells)) return undefined;

  const entries: { token: string; weight: number }[] = [];
  for (const cell of cells) {
    if (typeof cell !== 'object' || cell === null) continue;
    const c = cell as Record<string, unknown>;
    const address = c['address'];
    const value = c['value'];
    if (
      typeof address !== 'object' ||
      address === null ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) continue;
    const token = (address as Record<string, unknown>)['token'];
    if (typeof token !== 'string') continue;
    entries.push({ token, weight: value });
  }

  if (entries.length === 0) return undefined;
  const weightSum = entries.reduce((s, e) => s + e.weight, 0);
  const modelId = isString(obj['modelId']) ? obj['modelId'] : '';
  const rawVersion = obj['schemaVersion'];
  const schemaVersion = isNumber(rawVersion) ? rawVersion : 1;
  return { entries, weightSum, modelId, schemaVersion };
}

/**
 * Returns the field value as a number if present and finite, otherwise
 * `undefined`. Used for optional numeric fields to satisfy
 * `exactOptionalPropertyTypes` without redundant casts.
 */
function getOptionalNumber(
  fields: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = fields[key];
  return isNumber(v) ? v : undefined;
}

/**
 * Returns the field value as a string if present, otherwise `undefined`.
 * Used for optional string fields to satisfy `exactOptionalPropertyTypes`.
 */
function getOptionalString(
  fields: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = fields[key];
  return isString(v) ? v : undefined;
}

type RetrievalSummaryFieldKind = 'string' | 'number' | 'string_array';
type VespaRetrievalSummaryFieldSpec = {
  readonly vespaField: string;
  readonly kind: RetrievalSummaryFieldKind;
};
type RetrievalDocumentSummaryKey = Extract<RetrievalHitSummaryKey, keyof RetrievalDocument>;
type RawRetrievalHitSummary = {
  [Key in RetrievalHitSummaryKey]?: RetrievalHitSummary[Key] | undefined;
};

export const VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS = {
  canonicalLabel: { vespaField: 'canonical_label', kind: 'string' },
  producer: { vespaField: 'producer', kind: 'string' },
  region: { vespaField: 'region', kind: 'string' },
  searchTextEn: { vespaField: 'search_text_en', kind: 'string' },
  grapePrimary: { vespaField: 'grape_primary', kind: 'string' },
  style: { vespaField: 'style', kind: 'string' },
  priceBand: { vespaField: 'price_band', kind: 'string' },
  pairing: { vespaField: 'pairing', kind: 'string_array' },
  occasion: { vespaField: 'occasion', kind: 'string_array' },
  vintageYear: { vespaField: 'vintage_year', kind: 'number' },
  body: { vespaField: 'body', kind: 'number' },
  tannin: { vespaField: 'tannin', kind: 'number' },
  acidity: { vespaField: 'acidity', kind: 'number' },
  sweetness: { vespaField: 'sweetness', kind: 'number' },
  finishLength: { vespaField: 'finish_length', kind: 'number' },
  wineType: { vespaField: 'wine_type', kind: 'string' },
  criticScoreNormalized: { vespaField: 'critic_score_normalized', kind: 'number' },
  producerPrestige: { vespaField: 'producer_prestige', kind: 'number' },
  country: { vespaField: 'country', kind: 'string' },
  appellation: { vespaField: 'appellation', kind: 'string' },
  classification: { vespaField: 'classification', kind: 'string' },
  alcoholPct: { vespaField: 'alcohol_pct', kind: 'number' },
  drinkingWindowStart: { vespaField: 'drinking_window_start', kind: 'number' },
  drinkingWindowEnd: { vespaField: 'drinking_window_end', kind: 'number' },
  drinkingWindowModelVersion: { vespaField: 'drinking_window_model_version', kind: 'string' },
  priceUsd: { vespaField: 'price_usd', kind: 'number' },
  certifications: { vespaField: 'certifications', kind: 'string_array' },
  soilType: { vespaField: 'soil_type', kind: 'string' },
  producerType: { vespaField: 'producer_type', kind: 'string' },
  grapeFamily: { vespaField: 'grape_family', kind: 'string' },
  regionHierarchy: { vespaField: 'region_hierarchy', kind: 'string_array' },
  priceBandNumeric: { vespaField: 'price_band_numeric', kind: 'number' },
  searchTextKo: { vespaField: 'search_text_ko', kind: 'string' },
} as const satisfies Record<RetrievalHitSummaryKey, VespaRetrievalSummaryFieldSpec>;

function readRawVespaRetrievalSummaryField(
  fields: Record<string, unknown>,
  spec: VespaRetrievalSummaryFieldSpec,
): RetrievalHitSummary[RetrievalHitSummaryKey] | undefined {
  switch (spec.kind) {
    case 'string':
      return getOptionalString(fields, spec.vespaField);
    case 'number':
      return getOptionalNumber(fields, spec.vespaField);
    case 'string_array': {
      const value = fields[spec.vespaField];
      return isStringArray(value) ? value : undefined;
    }
  }
}

export function readRawVespaRetrievalSummary(
  fields: Record<string, unknown>,
): RawRetrievalHitSummary {
  const summary: RawRetrievalHitSummary = {};
  const summaryRecord = summary as Record<RetrievalHitSummaryKey, unknown>;

  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    const value = readRawVespaRetrievalSummaryField(
      fields,
      VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS[key],
    );
    if (value !== undefined) {
      summaryRecord[key] = value;
    }
  }

  return summary;
}

export function writeVespaRetrievalSummaryFields(
  target: Record<string, unknown>,
  source: Pick<RetrievalDocument, RetrievalDocumentSummaryKey>,
): void {
  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    const spec = VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS[key];
    const value = source[key as RetrievalDocumentSummaryKey];
    if (value === undefined) continue;

    if (spec.kind === 'string_array') {
      target[spec.vespaField] = [...(value as readonly string[])];
      continue;
    }

    target[spec.vespaField] = value;
  }
}

// ---------------------------------------------------------------------------
// Domain → Vespa
// ---------------------------------------------------------------------------

/**
 * Maps a {@link RetrievalDocument} to a flat record of Vespa document fields.
 * camelCase domain properties are converted to snake_case Vespa field names.
 *
 * @param doc - The domain document to convert.
 * @returns A plain object suitable for the Vespa Document v1 API body.
 */
export function toVespaFields(
  doc: RetrievalDocument,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    entity_id: doc.entityId,
    entity_type: doc.entityType,
    aliases_identity_safe: [...doc.aliasesIdentitySafe],
    aliases_noisy_recall: [...doc.aliasesNoisyRecall],
    grapes: [...doc.grapes],
    search_text_ko: doc.searchTextKo,
    semantic_summary: doc.semanticSummary,
    availability: doc.availability,
    popularity_score: doc.popularityScore,
  };

  writeVespaRetrievalSummaryFields(fields, doc);

  if (doc.embedding !== undefined) {
    // Vespa dense tensor format: { values: number[] }
    fields['embedding'] = { values: [...doc.embedding] };
  }

  // SOTA++ taxonomy fields
  if (doc.flavorProfiles !== undefined) fields['flavor_profiles'] = [...doc.flavorProfiles];
  if (doc.oakTreatment !== undefined) fields['oak_treatment'] = doc.oakTreatment;

  // Learned sparse weights: serialize as Vespa mapped tensor cells.
  // Skip when entries is empty — an empty tensor cell array is a no-op in Vespa
  // and causes parseSparseWeightsTensor to return undefined on roundtrip anyway.
  if (doc.learnedSparseWeights !== undefined && doc.learnedSparseWeights.entries.length > 0) {
    fields['learned_sparse_weights'] = {
      cells: doc.learnedSparseWeights.entries.map((e) => ({
        address: { token: e.token },
        value: e.weight,
      })),
    };
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Vespa → Domain
// ---------------------------------------------------------------------------

/**
 * Maps a flat record of Vespa document fields back to a {@link RetrievalDocument}.
 *
 * @param fields - The raw Vespa fields object from a GET or query response.
 * @returns A fully populated domain document.
 */
export function fromVespaFields(
  fields: Record<string, unknown>,
): RetrievalDocument {
  // Embedding: Vespa stores dense tensors as `{ values: number[] }` or
  // as a plain number array depending on the response format.
  let embedding: readonly number[] | undefined;
  const rawEmbedding = fields['embedding'];
  if (rawEmbedding !== null && rawEmbedding !== undefined) {
    if (isNumberArray(rawEmbedding)) {
      embedding = rawEmbedding;
    } else if (
      typeof rawEmbedding === 'object' &&
      !Array.isArray(rawEmbedding)
    ) {
      const obj = rawEmbedding as Record<string, unknown>;
      const values = obj['values'];
      if (isNumberArray(values)) {
        embedding = values;
      }
    }
  }

  const summary = readRawVespaRetrievalSummary(fields);

  // SOTA++ taxonomy fields
  const flavorProfilesRaw = fields['flavor_profiles'];
  const flavorProfiles = isStringArray(flavorProfilesRaw) ? flavorProfilesRaw : undefined;
  const oakTreatment = getOptionalString(fields, 'oak_treatment');

  // Learned sparse weights
  const learnedSparseWeights = parseSparseWeightsTensor(fields['learned_sparse_weights']);

  // Validate entity_id before calling createEntityId: a missing or
  // non-string entity_id would produce createEntityId('') which throws
  // "EntityId cannot be an empty string" with no indication of which
  // document was malformed. Fail early. Field keys are NOT included in the
  // error message — they leak the internal schema to clients via 500
  // responses. Operators can find the full key list in structured logs.
  const rawEntityId = fields['entity_id'];
  if (typeof rawEntityId !== 'string' || rawEntityId.length === 0) {
    throw new Error('fromVespaFields: malformed Vespa document — missing entity_id');
  }

  return {
    entityId: createEntityId(rawEntityId),
    entityType: getString(fields, 'entity_type'),
    canonicalLabel: summary.canonicalLabel ?? '',
    aliasesIdentitySafe: getStringArray(fields, 'aliases_identity_safe'),
    aliasesNoisyRecall: getStringArray(fields, 'aliases_noisy_recall'),
    producer: summary.producer ?? '',
    region: summary.region ?? '',
    grapes: getStringArray(fields, 'grapes'),
    searchTextKo: getString(fields, 'search_text_ko'),
    searchTextEn: summary.searchTextEn ?? '',
    semanticSummary: getString(fields, 'semantic_summary'),
    body: summary.body ?? 0,
    sweetness: summary.sweetness ?? 0,
    style: summary.style ?? '',
    priceBand: summary.priceBand ?? '',
    pairing: summary.pairing !== undefined ? [...summary.pairing] : [],
    occasion: summary.occasion !== undefined ? [...summary.occasion] : [],
    availability: getBoolean(fields, 'availability'),
    popularityScore: getNumber(fields, 'popularity_score'),
    ...(embedding !== undefined && { embedding }),
    // New wine-domain optional fields — key is omitted (not set to undefined)
    // when the value is absent, satisfying exactOptionalPropertyTypes.
    ...(summary.vintageYear !== undefined && { vintageYear: summary.vintageYear }),
    ...(summary.acidity !== undefined && { acidity: summary.acidity }),
    ...(summary.tannin !== undefined && { tannin: summary.tannin }),
    ...(summary.finishLength !== undefined && { finishLength: summary.finishLength }),
    ...(summary.wineType !== undefined && { wineType: summary.wineType }),
    ...(summary.grapePrimary !== undefined && { grapePrimary: summary.grapePrimary }),
    ...(summary.country !== undefined && { country: summary.country }),
    ...(summary.appellation !== undefined && { appellation: summary.appellation }),
    ...(summary.producerPrestige !== undefined && { producerPrestige: summary.producerPrestige }),
    ...(summary.criticScoreNormalized !== undefined
      && { criticScoreNormalized: summary.criticScoreNormalized }),
    ...(summary.priceUsd !== undefined && { priceUsd: summary.priceUsd }),
    // SOTA++ taxonomy fields
    ...(flavorProfiles !== undefined && { flavorProfiles }),
    ...(summary.classification !== undefined && { classification: summary.classification }),
    ...(summary.alcoholPct !== undefined && { alcoholPct: summary.alcoholPct }),
    ...(summary.drinkingWindowStart !== undefined
      && { drinkingWindowStart: summary.drinkingWindowStart }),
    ...(summary.drinkingWindowEnd !== undefined && { drinkingWindowEnd: summary.drinkingWindowEnd }),
    ...(summary.drinkingWindowModelVersion !== undefined
      && { drinkingWindowModelVersion: summary.drinkingWindowModelVersion }),
    ...(oakTreatment !== undefined && { oakTreatment }),
    ...(summary.certifications !== undefined && { certifications: [...summary.certifications] }),
    ...(summary.soilType !== undefined && { soilType: summary.soilType }),
    ...(summary.producerType !== undefined && { producerType: summary.producerType }),
    ...(summary.grapeFamily !== undefined && { grapeFamily: summary.grapeFamily }),
    ...(summary.regionHierarchy !== undefined && { regionHierarchy: [...summary.regionHierarchy] }),
    ...(summary.priceBandNumeric !== undefined && { priceBandNumeric: summary.priceBandNumeric }),
    ...(learnedSparseWeights !== undefined && { learnedSparseWeights }),
  };
}

// ---------------------------------------------------------------------------
// Projection extractors
// ---------------------------------------------------------------------------

/**
 * Extracts only the hit-projection fields from a {@link RetrievalDocument}.
 * The returned object contains exactly the fields defined by {@link RetrievalHitProjection}:
 * display / evidence fields used in summaries and response building.
 * Feature-only and payload fields are excluded.
 */
export function toRetrievalHitProjection(doc: RetrievalDocument): RetrievalHitProjection {
  const base: RetrievalHitProjection = {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
  };
  return {
    ...base,
    ...(doc.producer !== '' ? { producer: doc.producer } : {}),
    ...(doc.region !== '' ? { region: doc.region } : {}),
    ...(doc.appellation !== undefined ? { appellation: doc.appellation } : {}),
    ...(doc.grapePrimary !== undefined ? { grapePrimary: doc.grapePrimary } : {}),
    ...(doc.vintageYear !== undefined ? { vintageYear: doc.vintageYear } : {}),
    ...(doc.searchTextEn !== ''
      ? { searchTextEn: doc.searchTextEn }
      : {}),
    ...(doc.producerPrestige !== undefined ? { producerPrestige: doc.producerPrestige } : {}),
  };
}

/**
 * Extracts only the feature-projection fields from a {@link RetrievalDocument}.
 * The returned object contains exactly the fields defined by {@link RetrievalFeatureProjection}:
 * ranking runtime and ML feature fields. Display fields are excluded.
 */
export function toRetrievalFeatureProjection(doc: RetrievalDocument): RetrievalFeatureProjection {
  const base: RetrievalFeatureProjection = {
    entityId: doc.entityId,
  };
  return {
    ...base,
    ...(doc.body !== 0 ? { body: doc.body } : {}),
    ...(doc.tannin !== undefined ? { tannin: doc.tannin } : {}),
    ...(doc.acidity !== undefined ? { acidity: doc.acidity } : {}),
    ...(doc.sweetness !== 0 ? { sweetness: doc.sweetness } : {}),
    ...(doc.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: doc.criticScoreNormalized }
      : {}),
    ...(doc.drinkingWindowStart !== undefined
      ? { drinkingWindowStart: doc.drinkingWindowStart }
      : {}),
    ...(doc.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: doc.drinkingWindowEnd } : {}),
    ...(doc.drinkingWindowModelVersion !== undefined
      ? { drinkingWindowModelVersion: doc.drinkingWindowModelVersion }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Projection summary parsers (T7.2)
// ---------------------------------------------------------------------------

/**
 * Parses a Vespa `hit_summary` response object into a {@link RetrievalHitProjection}.
 *
 * Only the canonical hit-projection fields are extracted; any feature or payload
 * fields present in `raw` are ignored. Safe to call on a partial response.
 *
 * @param raw - The `fields` object from a Vespa summary hit.
 * @returns A {@link RetrievalHitProjection} containing only the hit-display fields.
 */
export function parseHitSummary(raw: Record<string, unknown>): RetrievalHitProjection {
  const entityIdRaw = raw['entity_id'];
  if (!isString(entityIdRaw) || entityIdRaw.length === 0) {
    throw new Error('parseHitSummary: missing or empty entity_id in hit_summary response');
  }
  const canonicalLabel = getOptionalString(raw, 'canonical_label');
  const producer = getOptionalString(raw, 'producer');
  const region = getOptionalString(raw, 'region');
  const appellation = getOptionalString(raw, 'appellation');
  const grapePrimary = getOptionalString(raw, 'grape_primary');
  const vintageYear = getOptionalNumber(raw, 'vintage_year');
  const searchTextEn = getOptionalString(raw, 'search_text_en');
  const producerPrestige = getOptionalNumber(raw, 'producer_prestige');

  return {
    entityId: createEntityId(entityIdRaw),
    ...(canonicalLabel !== undefined ? { canonicalLabel } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(appellation !== undefined ? { appellation } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
    ...(vintageYear !== undefined ? { vintageYear } : {}),
    ...(searchTextEn !== undefined ? { searchTextEn } : {}),
    ...(producerPrestige !== undefined ? { producerPrestige } : {}),
  };
}

/**
 * Parses a Vespa `feature_summary` response object into a {@link RetrievalFeatureProjection}.
 *
 * Only the canonical feature-projection fields are extracted; any hit-display or
 * payload fields present in `raw` are ignored. Safe to call on a partial response.
 *
 * @param raw - The `fields` object from a Vespa summary hit.
 * @returns A {@link RetrievalFeatureProjection} containing only the ML/ranking feature fields.
 */
export function parseFeatureSummary(raw: Record<string, unknown>): RetrievalFeatureProjection {
  const entityIdRaw = raw['entity_id'];
  const body = getOptionalNumber(raw, 'body');
  const tannin = getOptionalNumber(raw, 'tannin');
  const acidity = getOptionalNumber(raw, 'acidity');
  const sweetness = getOptionalNumber(raw, 'sweetness');
  const criticScoreNormalized = getOptionalNumber(raw, 'critic_score_normalized');
  const drinkingWindowStart = getOptionalNumber(raw, 'drinking_window_start');
  const drinkingWindowEnd = getOptionalNumber(raw, 'drinking_window_end');
  const drinkingWindowModelVersion = getOptionalString(raw, 'drinking_window_model_version');

  return {
    entityId: isString(entityIdRaw) && entityIdRaw.length > 0
      ? createEntityId(entityIdRaw)
      : (() => { throw new Error('parseFeatureSummary: missing or empty entity_id'); })(),
    ...(body !== undefined ? { body } : {}),
    ...(tannin !== undefined ? { tannin } : {}),
    ...(acidity !== undefined ? { acidity } : {}),
    ...(sweetness !== undefined ? { sweetness } : {}),
    ...(criticScoreNormalized !== undefined ? { criticScoreNormalized } : {}),
    ...(drinkingWindowStart !== undefined ? { drinkingWindowStart } : {}),
    ...(drinkingWindowEnd !== undefined ? { drinkingWindowEnd } : {}),
    ...(drinkingWindowModelVersion !== undefined ? { drinkingWindowModelVersion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Filter builders
// ---------------------------------------------------------------------------

/**
 * Known filter token prefixes and their Vespa field names.
 *
 * Filter tokens follow the convention: `<prefix>:<value>`, e.g.
 *   - `price_band:premium`
 *   - `style:bold red`
 *   - `body_min:2`
 *   - `body_max:4`
 */

/** @internal */
function parseFilterToken(token: string): { key: string; value: string } {
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return { key: token, value: '' };
  return {
    key: token.slice(0, colonIdx),
    value: token.slice(colonIdx + 1),
  };
}

/**
 * Wraps a string value for safe inclusion in a YQL predicate, escaping
 * backslashes and double-quote characters.
 *
 * MUST be used for any user-controlled or externally-sourced string that
 * is interpolated into a YQL string literal (e.g. IN-clause entity IDs,
 * `contains` predicates). Using raw string interpolation allows YQL
 * injection if the value contains `"` or `\`.
 *
 * @example
 * // Safe: uses this function
 * `entity_id in (${ids.map(yqlEscapeString).join(', ')})`
 *
 * // UNSAFE: raw interpolation
 * `entity_id in ("${id}")`  // breaks if id contains " or \
 */
export function yqlEscapeString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @internal Alias for filter builders within this module.
 */
const yqlString = yqlEscapeString;

/**
 * Whitelist of safe field names for `_in` (multi-value) and `_not_in` (negation
 * multi-value) sparse filter tokens.
 * Must match the producer in `domain/retrieval/service/constraint-to-sparse-filter-tokens.ts`.
 * Hoisted to module scope to avoid per-iteration allocation in `buildSparseFilters`.
 *
 * Positive fields produce Vespa OR clauses; `_not` variants produce AND NOT clauses.
 */
const ALLOWED_SPARSE_IN_FIELDS: ReadonlySet<string> = new Set([
  // Positive fields — produce Vespa OR clauses via <field>_in tokens
  'wine_type', 'country', 'region', 'appellation', 'grape_primary', 'grapes', 'style',
  'price_band', 'flavor_profile', 'classification', 'certification',
  'soil_type', 'producer_type',
  // Negation variants — used by <field>_not_in tokens (produce AND NOT clauses)
  'wine_type_not', 'country_not', 'region_not', 'appellation_not',
  'grape_primary_not', 'grapes_not',  // grapes_not needed for grape_primary not_in dual-field
  'style_not', 'price_band_not', 'flavor_profile_not', 'classification_not',
  'certification_not', 'soil_type_not', 'producer_type_not',
]);

/**
 * Builds YQL AND filter clauses from an array of filter tokens for use in
 * sparse (BM25 / lexical) queries.
 *
 * Supported tokens:
 * - `price_band:<value>`        → `price_band contains "value"`
 * - `style:<value>`             → `style contains "value"`
 * - `body_min:<n>`              → `body >= n`
 * - `body_max:<n>`              → `body <= n`
 * - `availability:true`         → `availability = true`
 * - `wine_type:<value>`         → `wine_type contains "value"`
 * - `grape_primary:<value>`     → `grape_primary contains "value"`
 * - `country:<value>`           → `country contains "value"`
 * - `appellation:<value>`       → `appellation contains "value"`
 * - `vintage_year_min:<n>`      → `vintage_year >= n`
 * - `vintage_year_max:<n>`      → `vintage_year <= n`
 * - `acidity_min:<n>`           → `acidity >= n`
 * - `tannin_min:<n>`            → `tannin >= n`
 * - `finish_length_min:<n>`     → `finish_length >= n`
 * - `price_usd_min:<n>`         → `price_usd >= n`
 * - `price_usd_max:<n>`         → `price_usd <= n`
 * - `critic_score_min:<n>`      → `critic_score_normalized >= n`
 * - `producer_prestige_min:<n>` → `producer_prestige >= n`
 * - `flavor_profile:<value>`    → `flavor_profiles contains "value"`
 * - `classification:<value>`    → `classification contains "value"`
 * - `alcohol_min:<n>`           → `alcohol_pct >= n`
 * - `alcohol_max:<n>`           → `alcohol_pct <= n`
 * - `certification:<value>`     → `certifications contains "value"`
 * - `soil_type:<value>`         → `soil_type contains "value"`
 * - `producer_type:<value>`     → `producer_type contains "value"`
 * - `drinking_window_now:<year>` → `drinking_window_start <= n AND drinking_window_end >= n`
 *
 * @param filters - Array of filter token strings.
 * @returns A YQL fragment starting with ` AND ` for each token, or `""` if empty.
 */
function clampNum(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clampNum(value, min, max));
}

export function buildSparseFilters(filters: readonly string[]): string {
  if (filters.length === 0) return '';

  const clauses: string[] = [];

  for (const token of filters) {
    const { key, value } = parseFilterToken(token);
    if (value === '') continue; // skip empty filter values
    switch (key) {
      // Original filters
      case 'price_band':
        clauses.push(`price_band contains ${yqlString(value)}`);
        break;
      case 'style':
        clauses.push(`style contains ${yqlString(value)}`);
        break;
      case 'body_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`body >= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'body_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`body <= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'availability':
        clauses.push(`availability = ${value === 'true' ? 'true' : 'false'}`);
        break;

      // New wine-domain string filters
      case 'wine_type':
        clauses.push(`wine_type contains ${yqlString(value)}`);
        break;
      case 'grape_primary':
        clauses.push(`grape_primary contains ${yqlString(value)}`);
        break;
      case 'country':
        clauses.push(`country contains ${yqlString(value)}`);
        break;
      case 'appellation':
        clauses.push(`appellation contains ${yqlString(value)}`);
        break;

      // New wine-domain numeric range filters.
      // All numeric inputs are clamped to domain bounds to prevent
      // attackers from sending extreme values (e.g., -999999999) that
      // bypass downstream filtering logic and to avoid scientific-notation
      // YQL interpolation.
      case 'vintage_year_min': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) clauses.push(`vintage_year >= ${clampInt(n, 1900, 2100)}`);
        break;
      }
      case 'vintage_year_max': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) clauses.push(`vintage_year <= ${clampInt(n, 1900, 2100)}`);
        break;
      }
      case 'acidity_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`acidity >= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'acidity_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`acidity <= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'tannin_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`tannin >= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'tannin_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`tannin <= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'finish_length_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`finish_length >= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'finish_length_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`finish_length <= ${clampNum(n, 0, 10).toFixed(3)}`);
        break;
      }
      case 'price_usd_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`price_usd >= ${clampNum(n, 0, 1_000_000).toFixed(2)}`);
        break;
      }
      case 'price_usd_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`price_usd <= ${clampNum(n, 0, 1_000_000).toFixed(2)}`);
        break;
      }
      case 'critic_score_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`critic_score_normalized >= ${clampNum(n, 0, 1).toFixed(4)}`);
        break;
      }
      case 'producer_prestige_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`producer_prestige >= ${clampNum(n, 0, 1).toFixed(4)}`);
        break;
      }

      // SOTA++ taxonomy filters
      case 'flavor_profile':
        clauses.push(`flavor_profiles contains ${yqlString(value)}`);
        break;
      case 'classification':
        clauses.push(`classification contains ${yqlString(value)}`);
        break;
      case 'alcohol_min': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`alcohol_pct >= ${clampNum(n, 0, 25).toFixed(2)}`);
        break;
      }
      case 'alcohol_max': {
        const n = parseFloat(value);
        if (Number.isFinite(n)) clauses.push(`alcohol_pct <= ${clampNum(n, 0, 25).toFixed(2)}`);
        break;
      }
      case 'certification':
        clauses.push(`certifications contains ${yqlString(value)}`);
        break;
      case 'soil_type':
        clauses.push(`soil_type contains ${yqlString(value)}`);
        break;
      case 'producer_type':
        clauses.push(`producer_type contains ${yqlString(value)}`);
        break;
      case 'drinking_window_now': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) {
          const yr = clampInt(n, 1900, 2200);
          clauses.push(`drinking_window_start <= ${yr}`);
          clauses.push(`drinking_window_end >= ${yr}`);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // NOT filters — string field exclusions via YQL !(field contains "value")
      // -----------------------------------------------------------------------
      // Emitted by constraintToSparseFilterTokens() for 'exclude'/'not_in' operators.
      // grape_primary_not also sets grapes_not to cover the array schema field.

      case 'grape_primary_not':
        clauses.push(`!(grape_primary contains ${yqlString(value)})`);
        break;

      case 'grapes_not':
        clauses.push(`!(grapes contains ${yqlString(value)})`);
        break;

      case 'wine_type_not':
        clauses.push(`!(wine_type contains ${yqlString(value)})`);
        break;

      case 'country_not':
        clauses.push(`!(country contains ${yqlString(value)})`);
        break;

      case 'region_not':
        clauses.push(`!(region contains ${yqlString(value)})`);
        break;

      case 'appellation_not':
        clauses.push(`!(appellation contains ${yqlString(value)})`);
        break;

      case 'style_not':
        clauses.push(`!(style contains ${yqlString(value)})`);
        break;

      case 'price_band_not':
        clauses.push(`!(price_band contains ${yqlString(value)})`);
        break;

      case 'flavor_profile_not':
        clauses.push(`!(flavor_profiles contains ${yqlString(value)})`);
        break;

      case 'classification_not':
        clauses.push(`!(classification contains ${yqlString(value)})`);
        break;

      case 'certification_not':
        clauses.push(`!(certifications contains ${yqlString(value)})`);
        break;

      case 'soil_type_not':
        clauses.push(`!(soil_type contains ${yqlString(value)})`);
        break;

      case 'producer_type_not':
        clauses.push(`!(producer_type contains ${yqlString(value)})`);
        break;

      default: {
        // Multi-value IN / NOT-IN tokens: key ends with _in, value is pipe-delimited.
        // Positive (_in): produces a Vespa OR clause: (field contains "a" OR field contains "b").
        // Negation (_not_in): produces individual AND NOT clauses — Vespa has no NOT-IN shorthand.
        // The base field name (with optional _not suffix) is validated against a whitelist
        // to prevent YQL injection.
        if (key.endsWith('_in')) {
          const fieldWithSuffix = key.slice(0, -3); // strip '_in' suffix
          if (!ALLOWED_SPARSE_IN_FIELDS.has(fieldWithSuffix)) break;
          const vals = value.split('|').filter((v) => v.length > 0);
          if (vals.length === 0) break;
          if (fieldWithSuffix.endsWith('_not')) {
            // Negation NOT-IN: !(field contains "v1") AND !(field contains "v2")
            const actualField = fieldWithSuffix.slice(0, -4); // strip '_not' suffix
            for (const v of vals) {
              clauses.push(`!(${actualField} contains ${yqlString(v)})`);
            }
          } else {
            // Positive IN: (field contains "a" OR field contains "b")
            const disjuncts = vals.map((v) => `${fieldWithSuffix} contains ${yqlString(v)}`);
            clauses.push(vals.length === 1 ? disjuncts[0]! : `(${disjuncts.join(' OR ')})`);
          }
        }
        // Other unrecognised tokens are silently skipped to avoid breaking queries.
        break;
      }
    }
  }

  if (clauses.length === 0) return '';
  return ' AND ' + clauses.join(' AND ');
}

/**
 * Builds YQL AND filter clauses from an array of filter tokens for use in
 * dense (ANN / nearestNeighbor) queries.
 *
 * Supports the same token vocabulary as {@link buildSparseFilters}.
 *
 * @param filters - Array of filter token strings.
 * @returns A YQL fragment starting with ` AND ` for each token, or `""` if empty.
 */
export function buildDenseFilters(filters: readonly string[]): string {
  // The filter predicate syntax is identical for ANN queries.
  return buildSparseFilters(filters);
}
