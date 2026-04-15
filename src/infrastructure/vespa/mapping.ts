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
import { createCanonicalEntityId } from '../../domain/shared/types/entity-id.js';
import {
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
} from '../../domain/shared/constants.js';
import {
  type SearchConstraints,
  krwToUsd,
} from '../../domain/query/service/search-constraint-extractor.js';
import { parseSourceRecordRefsFromVespa } from '../../domain/entity/model/source-record-ref.js';
import { stableJsonStringify } from '../../shared/utils/stable-json.js';

/** Decimal radix for parseInt on external filter tokens. */
const DECIMAL_RADIX = 10;
/** Clamp for 0–10 sensor-style fields in YQL (acidity, tannin, finish). */
const WINE_SENSOR_SCALE_MIN = 0;
const WINE_SENSOR_SCALE_MAX = 10;
/** Absurd price filter cap — avoids scientific notation in YQL. */
const MAX_PRICE_USD_YQL_CLAMP = 1_000_000;
/** Physical ceiling for wine ABV in filter clamps (% vol). */
const MAX_ALCOHOL_PCT_YQL_CLAMP = 25;
/** Fraction digits when interpolating normalized critic/prestige scores into YQL. */
const NORMALIZED_SCORE_YQL_DECIMAL_PLACES = 4;
/** Pipe-delimited `_in` token key suffix length (`foo_in`). */
const SPARSE_IN_SUFFIX_LENGTH = 3;
/** Safety cap on parsed sparse tensor cell count to prevent memory exhaustion on corrupt/hostile documents. */
const MAX_SPARSE_TENSOR_CELLS = 10_000;
/** `_not` suffix length when deriving field name for NOT-IN clauses. */
const SPARSE_NOT_FIELD_SUFFIX_LENGTH = 4;

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
  // isFinite guard required: NaN/Infinity have typeof 'number' but are not valid
  // embedding values. Consistent with isNumber which already includes isFinite.
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && isFinite(x));
}

function getRequiredString(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (isString(v) && v.length > 0) return v;
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

function getRequiredNumber(fields: Record<string, unknown>, key: string): number {
  const v = fields[key];
  if (isNumber(v)) return v;
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

function getRequiredBoolean(fields: Record<string, unknown>, key: string): boolean {
  const v = fields[key];
  if (isBoolean(v)) return v;
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

function getRequiredStringArray(fields: Record<string, unknown>, key: string): readonly string[] {
  const v = fields[key];
  if (isStringArray(v)) return v;
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
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
  // Guard against memory exhaustion from corrupt or adversarially large Vespa documents.
  if (cells.length > MAX_SPARSE_TENSOR_CELLS) return undefined;

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

function getOptionalStringStrict(
  fields: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in fields) || fields[key] === undefined) {
    return undefined;
  }
  const value = fields[key];
  if (isString(value)) {
    return value;
  }
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

function getOptionalNumberStrict(
  fields: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in fields) || fields[key] === undefined) {
    return undefined;
  }
  const value = fields[key];
  if (isNumber(value)) {
    return value;
  }
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

function getOptionalStringArrayStrict(
  fields: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  if (!(key in fields) || fields[key] === undefined) {
    return undefined;
  }
  const value = fields[key];
  if (isStringArray(value)) {
    return value;
  }
  throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
}

type RetrievalSummaryFieldKind = 'string' | 'number' | 'string_array';
type VespaRetrievalSummaryFieldSpec = {
  readonly vespaField: string;
  readonly kind: RetrievalSummaryFieldKind;
};
type RetrievalDocumentSummaryKey = Extract<RetrievalHitSummaryKey, keyof RetrievalDocument>;
const VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS = {
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
  flavorProfiles: { vespaField: 'flavor_profiles', kind: 'string_array' },
} as const satisfies Record<RetrievalHitSummaryKey, VespaRetrievalSummaryFieldSpec>;

/**
 * Vespa field names consumed by {@link readRawVespaRetrievalSummary} (summary specs
 * plus lineage JSON). Used by meta tests to keep `wine_entity.sd` `hit_summary`
 * aligned with {@link VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS}.
 */
export const VESPA_READ_RAW_RETRIEVAL_SUMMARY_FIELD_NAMES: readonly string[] = (() => {
  const names: string[] = [];
  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    names.push(VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS[key].vespaField);
  }
  names.push('source_record_refs_json');
  return names;
})();

function readRawVespaRetrievalSummaryField(
  fields: Record<string, unknown>,
  spec: VespaRetrievalSummaryFieldSpec,
): RetrievalHitSummary[RetrievalHitSummaryKey] | undefined {
  switch (spec.kind) {
    case 'string':
      return getOptionalStringStrict(fields, spec.vespaField);
    case 'number':
      return getOptionalNumberStrict(fields, spec.vespaField);
    case 'string_array':
      return getOptionalStringArrayStrict(fields, spec.vespaField);
  }
}

export function readRawVespaRetrievalSummary(
  fields: Record<string, unknown>,
): Partial<RetrievalHitSummary> {
  const summary: Partial<RetrievalHitSummary> = {};
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

  const lineageRefs = parseSourceRecordRefsFromVespa(fields['source_record_refs_json']);
  if (lineageRefs !== undefined && lineageRefs.length > 0) {
    (summary as Record<string, unknown>).sourceRecordRefs = lineageRefs;
  }

  return summary;
}

function writeVespaRetrievalSummaryFields(
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
    semantic_summary: doc.semanticSummary,
    availability: doc.availability,
    popularity_score: doc.popularityScore,
  };

  if (doc.searchSnapshotId !== undefined) {
    fields['search_snapshot_id'] = doc.searchSnapshotId;
  }

  writeVespaRetrievalSummaryFields(fields, doc);

  if (doc.sourceRecordRefs !== undefined && doc.sourceRecordRefs.length > 0) {
    fields['source_record_refs_json'] = stableJsonStringify([...doc.sourceRecordRefs]);
  }

  if (doc.embedding !== undefined) {
    // Vespa dense tensor format: { values: number[] }
    fields['embedding'] = { values: [...doc.embedding] };
  }

  // SOTA++ taxonomy fields
  // Note: flavorProfiles is written via writeVespaRetrievalSummaryFields above
  // (VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS includes flavorProfiles → 'flavor_profiles').
  // Do NOT write it again here — that would double-write the field.
  if (doc.oakTreatment !== undefined) fields['oak_treatment'] = doc.oakTreatment;

  // Doc2Query synthetic queries — emit only when non-empty so existing
  // documents without an expansion pass don't carry an empty field.
  if (doc.syntheticQueries !== undefined && doc.syntheticQueries.length > 0) {
    fields['synthetic_queries'] = [...doc.syntheticQueries];
  }

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
  // flavorProfiles is read via readRawVespaRetrievalSummary above (summary.flavorProfiles).
  // Do NOT read fields['flavor_profiles'] again here — use summary.flavorProfiles to stay
  // consistent with VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS as the SSoT for the field mapping.
  const oakTreatment = getOptionalString(fields, 'oak_treatment');

  // Doc2Query synthetic queries
  const syntheticQueriesRaw = fields['synthetic_queries'];
  const syntheticQueries = isStringArray(syntheticQueriesRaw) ? syntheticQueriesRaw : undefined;

  // Learned sparse weights
  const learnedSparseWeights = parseSparseWeightsTensor(fields['learned_sparse_weights']);

  // Validate entity_id before calling createCanonicalEntityId: a missing or
  // non-string entity_id would produce createCanonicalEntityId('') which throws
  // "EntityId cannot be an empty string" with no indication of which
  // document was malformed. Fail early. Field keys are NOT included in the
  // error message — they leak the internal schema to clients via 500
  // responses. Operators can find the full key list in structured logs.
  const rawEntityId = fields['entity_id'];
  if (typeof rawEntityId !== 'string' || rawEntityId.length === 0) {
    throw new Error('fromVespaFields: malformed Vespa document — required retrieval payload missing or invalid');
  }

  const lineageRefsFromFields = parseSourceRecordRefsFromVespa(fields['source_record_refs_json']);

  return {
    entityId: createCanonicalEntityId(rawEntityId),
    entityType: getRequiredString(fields, 'entity_type'),
    ...(getOptionalString(fields, 'search_snapshot_id') !== undefined
      ? { searchSnapshotId: getOptionalString(fields, 'search_snapshot_id') }
      : {}),
    canonicalLabel: getRequiredString(fields, 'canonical_label'),
    aliasesIdentitySafe: getRequiredStringArray(fields, 'aliases_identity_safe'),
    aliasesNoisyRecall: getRequiredStringArray(fields, 'aliases_noisy_recall'),
    producer: getRequiredString(fields, 'producer'),
    region: getRequiredString(fields, 'region'),
    grapes: getRequiredStringArray(fields, 'grapes'),
    searchTextKo: getRequiredString(fields, 'search_text_ko'),
    searchTextEn: getRequiredString(fields, 'search_text_en'),
    semanticSummary: getRequiredString(fields, 'semantic_summary'),
    // E1-P3-7: body/sweetness use conditional spread to distinguish "no data" (field absent)
    // from "value is 0" (field present with value 0). exactOptionalPropertyTypes:
    // omit key when undefined.
    ...(summary.body !== undefined ? { body: summary.body } : {}),
    ...(summary.sweetness !== undefined ? { sweetness: summary.sweetness } : {}),
    style: getRequiredString(fields, 'style'),
    priceBand: getRequiredString(fields, 'price_band'),
    pairing: getRequiredStringArray(fields, 'pairing'),
    ...(summary.occasion !== undefined ? { occasion: [...summary.occasion] } : {}),
    availability: getRequiredBoolean(fields, 'availability'),
    popularityScore: getRequiredNumber(fields, 'popularity_score'),
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
    // SOTA++ taxonomy fields — read from summary (via VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS SSoT)
    ...(summary.flavorProfiles !== undefined && { flavorProfiles: summary.flavorProfiles }),
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
    ...(syntheticQueries !== undefined && { syntheticQueries }),
    ...(lineageRefsFromFields !== undefined && lineageRefsFromFields.length > 0
      ? { sourceRecordRefs: lineageRefsFromFields }
      : {}),
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
    ...(doc.sourceRecordRefs !== undefined && doc.sourceRecordRefs.length > 0
      ? { sourceRecordRefs: doc.sourceRecordRefs }
      : {}),
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
    // E1-P3-7: use != null (not !== 0) to distinguish "no data" from "value is 0".
    // body/sweetness are [0,1] normalised floats — 0 is a valid value (light body,
    // bone-dry sweetness). The prior `!== 0` guard silently dropped valid zero values,
    // corrupting feature projections and downstream LTR signals.
    ...(doc.body != null ? { body: doc.body } : {}),
    ...(doc.tannin != null ? { tannin: doc.tannin } : {}),
    ...(doc.acidity != null ? { acidity: doc.acidity } : {}),
    ...(doc.sweetness != null ? { sweetness: doc.sweetness } : {}),
    // Use != null consistently for all numeric projection fields (covers both null and
    // undefined). criticScoreNormalized is also [0,1] normalised — 0 is a valid score.
    // drinkingWindowStart/End are year integers (>1800) so 0 cannot occur, but != null
    // keeps the pattern uniform and guards against explicit null from partial documents.
    ...(doc.criticScoreNormalized != null
      ? { criticScoreNormalized: doc.criticScoreNormalized }
      : {}),
    ...(doc.drinkingWindowStart != null
      ? { drinkingWindowStart: doc.drinkingWindowStart }
      : {}),
    ...(doc.drinkingWindowEnd != null ? { drinkingWindowEnd: doc.drinkingWindowEnd } : {}),
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
  const lineageRefs = parseSourceRecordRefsFromVespa(raw['source_record_refs_json']);

  return {
    entityId: createCanonicalEntityId(entityIdRaw),
    ...(canonicalLabel !== undefined ? { canonicalLabel } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(appellation !== undefined ? { appellation } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
    ...(vintageYear !== undefined ? { vintageYear } : {}),
    ...(searchTextEn !== undefined ? { searchTextEn } : {}),
    ...(producerPrestige !== undefined ? { producerPrestige } : {}),
    ...(lineageRefs !== undefined && lineageRefs.length > 0 ? { sourceRecordRefs: lineageRefs } : {}),
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
      ? createCanonicalEntityId(entityIdRaw)
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
  // Strip control characters before escaping:
  //   \x00-\x1F  — ASCII C0 control chars (NUL, TAB, LF, CR, …)
  //   \x7F       — DEL
  //   \x80-\x9F  — C1 control chars (U+0080–U+009F, includes U+0085 NEL)
  //               Can confuse YQL parsers and terminal emulators; no legit use.
  //   \u2028     — Unicode Line Separator (valid JS line-terminator, breaks YQL)
  //   \u2029     — Unicode Paragraph Separator (same)
  //   \uFEFF     — BOM / Zero Width No-Break Space
  // eslint-disable-next-line no-control-regex -- intentionally strips ASCII/Unicode control chars
  const sanitized = value.replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029\uFEFF]/gu, '');
  return `"${sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @internal Alias for filter builders within this module.
 */
const yqlString = yqlEscapeString;

// ---------------------------------------------------------------------------
// Filter Token Registry
// ---------------------------------------------------------------------------
// SSoT for the mapping between sparse filter token keys and their Vespa YQL
// clause generators. Adding a new token REQUIRES an entry here — unknown tokens
// are blocked and logged, never silently passed through.
//
// Token types:
//   'contains'        → field contains "value"                (indexed or attribute)
//   'matches'         → field matches "escaped_regex"          (attribute-only; regex substring)
//   'num_gte'         → field >= clamped_number
//   'num_lte'         → field <= clamped_number
//   'int_gte'         → field >= clamped_int
//   'int_lte'         → field <= clamped_int
//   'bool'            → field = true|false
//   'drinking_window' → special: drinking_window_start <= n AND drinking_window_end >= n
//   'grape_or'        → special: (grape_primary contains v OR grapes contains v)
//   'not_contains'    → !(field contains "value")
//   'not_matches'     → !(field matches "escaped_regex")   (attribute-only; regex substring NOT)
//
// clamp: [min, max] applied before number interpolation into YQL.

/** TokenSpec variants — discriminated union ensures clamp is required for numeric types.
 *
 * `grape_or` has no `field` property: it always emits a compound OR across both
 * `grape_primary` and `grapes` schema fields — there is no single Vespa field to name.
 * `drinking_window` similarly: it emits TWO clauses (start <=, end >=). The `field`
 * property names the start field only, for documentation purposes.
 */
type TokenSpec =
  | { readonly type: 'contains' | 'matches' | 'not_contains' | 'not_matches' | 'bool'; readonly field: string }
  | { readonly type: 'drinking_window'; readonly field: string } // field = 'drinking_window_start' (doc only)
  | { readonly type: 'grape_or' }                                // no field — always targets grape_primary + grapes
  | { readonly type: 'num_gte' | 'num_lte'; readonly field: string; readonly clamp: readonly [number, number]; readonly decimals: number }
  | { readonly type: 'int_gte' | 'int_lte'; readonly field: string; readonly clamp: readonly [number, number] };

/**
 * Declares every valid sparse filter token and its YQL generation rule.
 *
 * ADDING A NEW FILTER TOKEN:
 *   1. Add an entry here with the correct type, field, and clamp.
 *   2. Add a corresponding case in `constraint-to-sparse-filter-tokens.ts`.
 *   3. Add a regression test in `vespa-mapping-sparse-filters.test.ts`.
 *   4. If multi-value (_in / _not_in) is needed, add the base key to ALLOWED_SPARSE_IN_FIELDS below.
 *
 * Unknown tokens are blocked — they never reach Vespa.
 */
const FILTER_TOKEN_REGISTRY: ReadonlyMap<string, TokenSpec> = new Map([
  // String equality / substring filters (attribute | index fields → contains)
  ['wine_type',        { type: 'contains',  field: 'wine_type' }],
  ['country',          { type: 'contains',  field: 'country' }],
  ['region',           { type: 'contains',  field: 'region' }],
  ['appellation',      { type: 'contains',  field: 'appellation' }],
  ['pairing',          { type: 'contains',  field: 'pairing' }],
  ['occasion',         { type: 'contains',  field: 'occasion' }],
  ['grape_primary',    { type: 'contains',  field: 'grape_primary' }],
  ['price_band',       { type: 'contains',  field: 'price_band' }],
  ['flavor_profile',   { type: 'contains',  field: 'flavor_profiles' }],
  ['classification',   { type: 'contains',  field: 'classification' }],
  ['certification',    { type: 'contains',  field: 'certifications' }],
  ['soil_type',        { type: 'contains',  field: 'soil_type' }],
  ['producer_type',    { type: 'contains',  field: 'producer_type' }],
  ['grape_family',     { type: 'contains',  field: 'grape_family' }],
  // Legacy style:  kept ONLY because NOT-exclusion (style_not:) still uses contains for exact NOT.
  // Positive style matching MUST use style_matches: (see below).
  ['style',            { type: 'contains',  field: 'style' }],

  // Regex substring match (attribute-only fields whose values are multi-token compounds).
  // style field stores "medium red", "bold red" etc. — contains fails; matches works.
  ['style_matches',    { type: 'matches',   field: 'style' }],

  // Special compound tokens
  ['grape_or',         { type: 'grape_or' }],  // targets both grape_primary AND grapes — no single field
  ['availability',     { type: 'bool',      field: 'availability' }],
  ['drinking_window_now', { type: 'drinking_window', field: 'drinking_window_start' }],

  // Numeric range filters — clamped before YQL interpolation
  ['body_min',              { type: 'num_gte', field: 'body',                    clamp: [0, 1],                          decimals: 3 }],
  ['body_max',              { type: 'num_lte', field: 'body',                    clamp: [0, 1],                          decimals: 3 }],
  ['acidity_min',           { type: 'num_gte', field: 'acidity',                 clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['acidity_max',           { type: 'num_lte', field: 'acidity',                 clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['tannin_min',            { type: 'num_gte', field: 'tannin',                  clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['tannin_max',            { type: 'num_lte', field: 'tannin',                  clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['finish_length_min',     { type: 'num_gte', field: 'finish_length',           clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['finish_length_max',     { type: 'num_lte', field: 'finish_length',           clamp: [WINE_SENSOR_SCALE_MIN, WINE_SENSOR_SCALE_MAX], decimals: 3 }],
  ['price_usd_min',         { type: 'num_gte', field: 'price_usd',               clamp: [WINE_SENSOR_SCALE_MIN, MAX_PRICE_USD_YQL_CLAMP], decimals: 2 }],
  ['price_usd_max',         { type: 'num_lte', field: 'price_usd',               clamp: [WINE_SENSOR_SCALE_MIN, MAX_PRICE_USD_YQL_CLAMP], decimals: 2 }],
  ['critic_score_min',      { type: 'num_gte', field: 'critic_score_normalized', clamp: [0, 1],                          decimals: NORMALIZED_SCORE_YQL_DECIMAL_PLACES }],
  ['producer_prestige_min', { type: 'num_gte', field: 'producer_prestige',       clamp: [0, 1],                          decimals: NORMALIZED_SCORE_YQL_DECIMAL_PLACES }],
  ['alcohol_min',           { type: 'num_gte', field: 'alcohol_pct',             clamp: [WINE_SENSOR_SCALE_MIN, MAX_ALCOHOL_PCT_YQL_CLAMP], decimals: 2 }],
  ['alcohol_max',           { type: 'num_lte', field: 'alcohol_pct',             clamp: [WINE_SENSOR_SCALE_MIN, MAX_ALCOHOL_PCT_YQL_CLAMP], decimals: 2 }],
  ['vintage_year_min',      { type: 'int_gte', field: 'vintage_year',            clamp: [MIN_PRODUCED_VINTAGE_YEAR, MAX_PRODUCED_VINTAGE_YEAR] }],
  ['vintage_year_max',      { type: 'int_lte', field: 'vintage_year',            clamp: [MIN_PRODUCED_VINTAGE_YEAR, MAX_PRODUCED_VINTAGE_YEAR] }],

  // NOT-exclusion tokens (field_not: prefix)
  ['grape_primary_not', { type: 'not_contains', field: 'grape_primary' }],
  ['grapes_not',        { type: 'not_contains', field: 'grapes' }],
  ['wine_type_not',     { type: 'not_contains', field: 'wine_type' }],
  ['country_not',       { type: 'not_contains', field: 'country' }],
  ['region_not',        { type: 'not_contains', field: 'region' }],
  ['appellation_not',   { type: 'not_contains', field: 'appellation' }],
  ['pairing_not',       { type: 'not_contains', field: 'pairing' }],
  ['occasion_not',      { type: 'not_contains', field: 'occasion' }],
  // style field is attribute-only — `contains` does NOT do substring matching on multi-token
  // values like "full red". Must use `matches` (regex substring) so exclusions like
  // `style_not:full` correctly produce `!(style matches "full")` and exclude "full red" wines.
  ['style_not',         { type: 'not_matches',  field: 'style' }],
  ['price_band_not',    { type: 'not_contains', field: 'price_band' }],
  ['flavor_profile_not',    { type: 'not_contains', field: 'flavor_profiles' }],
  ['classification_not',    { type: 'not_contains', field: 'classification' }],
  ['certification_not',     { type: 'not_contains', field: 'certifications' }],
  ['soil_type_not',         { type: 'not_contains', field: 'soil_type' }],
  ['producer_type_not',     { type: 'not_contains', field: 'producer_type' }],
  ['grape_family_not',      { type: 'not_contains', field: 'grape_family' }],
]);

/**
 * Whitelist of base field names valid for multi-value `_in` / `_not_in` tokens.
 * Derived from FILTER_TOKEN_REGISTRY: only keys that have a contains/not_contains/grape_or
 * entry are safe to use as the base of a multi-value OR clause.
 *
 * Must stay in sync with FILTER_TOKEN_REGISTRY — validated by unit tests.
 */
const ALLOWED_SPARSE_IN_FIELDS: ReadonlySet<string> = new Set([
  'wine_type', 'country', 'region', 'appellation', 'pairing', 'occasion', 'grape_primary', 'style',
  'style_matches', 'price_band', 'flavor_profile', 'classification', 'certification',
  'soil_type', 'producer_type', 'grape_family', 'grape_or',
  // Negation variants
  'wine_type_not', 'country_not', 'region_not', 'appellation_not', 'pairing_not', 'occasion_not',
  'grape_primary_not', 'grapes_not',
  'style_not', 'price_band_not', 'flavor_profile_not', 'classification_not',
  'certification_not', 'soil_type_not', 'producer_type_not', 'grape_family_not',
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
 * - `grape_or:<value>`          → `(grape_primary contains "value" OR grapes contains "value")`
 * - `grape_or_in:<v1>|<v2>`    → `((gp contains "v1" OR grapes contains "v1") OR (gp contains "v2" OR grapes contains "v2"))`
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
/**
 * Escapes special regex metacharacters in a string so it can be used as a
 * literal substring pattern in a Vespa `matches` clause.
 * Prevents regex injection when user-supplied constraint values are interpolated
 * into YQL `style matches "..."` expressions.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNum(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clampNum(value, min, max));
}

/**
 * Builds YQL AND filter clauses directly from a {@link SearchConstraints} object
 * for price (KRW → USD) and vintage year numeric range filters.
 *
 * This is the Phase 1-B injection path: constraints extracted lexically from the
 * raw query (via `extractSearchConstraints`) are injected as hard YQL numeric
 * predicates, bypassing the soft/hard classification in the planner.
 *
 * Vespa fields used:
 *   - `price_usd`    (float) — Korean KRW prices converted via {@link krwToUsd}
 *   - `vintage_year` (int)   — vintage year range, clamped to domain bounds
 *
 * @param constraints - Structured constraints from `extractSearchConstraints`.
 * @returns A YQL fragment starting with ` AND ` for each active filter, or `""` if none.
 *
 * @example
 * buildNumericRangeFilters({ maxPriceKrw: 50_000 })
 * // → ' AND price_usd <= 37.04'
 *
 * buildNumericRangeFilters({ vintageMin: 2015, vintageMax: 2020 })
 * // → ' AND vintage_year >= 2015 AND vintage_year <= 2020'
 */
export function buildNumericRangeFilters(constraints: SearchConstraints): string {
  const clauses: string[] = [];

  // Price range: KRW → USD, clamped to [0, MAX_PRICE_USD_YQL_CLAMP].
  if (constraints.minPriceKrw !== undefined) {
    const usd = krwToUsd(constraints.minPriceKrw);
    if (Number.isFinite(usd)) {
      const clamped = clampNum(usd, 0, MAX_PRICE_USD_YQL_CLAMP);
      clauses.push(`price_usd >= ${clamped.toFixed(2)}`);
    }
  }

  if (constraints.maxPriceKrw !== undefined) {
    const usd = krwToUsd(constraints.maxPriceKrw);
    if (Number.isFinite(usd)) {
      const clamped = clampNum(usd, 0, MAX_PRICE_USD_YQL_CLAMP);
      clauses.push(`price_usd <= ${clamped.toFixed(2)}`);
    }
  }

  // Vintage year range: integer, clamped to domain bounds.
  if (constraints.vintageMin !== undefined) {
    const yr = clampInt(
      constraints.vintageMin,
      MIN_PRODUCED_VINTAGE_YEAR,
      MAX_PRODUCED_VINTAGE_YEAR,
    );
    clauses.push(`vintage_year >= ${yr}`);
  }

  if (constraints.vintageMax !== undefined) {
    const yr = clampInt(
      constraints.vintageMax,
      MIN_PRODUCED_VINTAGE_YEAR,
      MAX_PRODUCED_VINTAGE_YEAR,
    );
    clauses.push(`vintage_year <= ${yr}`);
  }

  if (clauses.length === 0) return '';
  return ' AND ' + clauses.join(' AND ');
}

/**
 * Builds a single YQL clause from a known token spec and its value.
 * Returns null if the value is invalid for the spec type (e.g. non-finite number).
 */
function buildTokenClause(_key: string, spec: TokenSpec, value: string): string | null {
  switch (spec.type) {
    case 'contains':
      return `${spec.field} contains ${yqlString(value)}`;
    case 'matches':
      return `${spec.field} matches ${yqlString(escapeRegex(value))}`;
    case 'not_contains':
      return `!(${spec.field} contains ${yqlString(value)})`;
    case 'not_matches':
      // Attribute-only fields (e.g. style) whose values are multi-token compounds:
      // `contains` does exact-token match and silently no-ops on "full red" vs "full".
      // `matches` does regex substring, so `!(style matches "full")` correctly excludes
      // any wine with "full" in the style field (e.g. "full red", "full white").
      return `!(${spec.field} matches ${yqlString(escapeRegex(value))})`;
    case 'bool':
      return `${spec.field} = ${value === 'true' ? 'true' : 'false'}`;
    case 'grape_or':
      // No single `field` — always targets both grape_primary and grapes.
      return `(grape_primary contains ${yqlString(value)} OR grapes contains ${yqlString(value)})`;
    case 'drinking_window':
      // Two-clause special: handled directly in buildSparseFilters, not here.
      // buildTokenClause cannot return multiple clauses — caller must branch on spec.type === 'drinking_window'.
      return null;
    case 'num_gte': {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) return null;
      const [lo, hi] = spec.clamp; // clamp is required by discriminated union — no ! needed
      return `${spec.field} >= ${clampNum(n, lo, hi).toFixed(spec.decimals)}`;
    }
    case 'num_lte': {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) return null;
      const [lo, hi] = spec.clamp;
      return `${spec.field} <= ${clampNum(n, lo, hi).toFixed(spec.decimals)}`;
    }
    case 'int_gte': {
      const n = parseInt(value, DECIMAL_RADIX);
      if (!Number.isFinite(n)) return null;
      const [lo, hi] = spec.clamp;
      return `${spec.field} >= ${clampInt(n, lo, hi)}`;
    }
    case 'int_lte': {
      const n = parseInt(value, DECIMAL_RADIX);
      if (!Number.isFinite(n)) return null;
      const [lo, hi] = spec.clamp;
      return `${spec.field} <= ${clampInt(n, lo, hi)}`;
    }
    default: {
      // Exhaustiveness guard — TypeScript should catch new TokenSpec variants at compile time
      const _never: never = spec;
      void _never;
      return null;
    }
  }
}

export function buildSparseFilters(filters: readonly string[]): string {
  if (filters.length === 0) return '';

  const clauses: string[] = [];

  for (const token of filters) {
    const { key, value } = parseFilterToken(token);
    if (value === '') continue; // skip empty filter values

    const spec = FILTER_TOKEN_REGISTRY.get(key);
    if (spec !== undefined) {
      // drinking_window emits TWO clauses (start <= yr AND end >= yr).
      // Handle directly here so buildTokenClause stays single-clause.
      if (spec.type === 'drinking_window') {
        const n = parseInt(value, DECIMAL_RADIX);
        if (Number.isFinite(n)) {
          const yr = clampInt(n, MIN_PRODUCED_VINTAGE_YEAR, MAX_PRODUCED_VINTAGE_YEAR);
          clauses.push(`drinking_window_start <= ${yr}`);
          clauses.push(`drinking_window_end >= ${yr}`);
        }
        continue;
      }
      // All other known tokens — delegate to registry-driven builder
      const clause = buildTokenClause(key, spec, value);
      if (clause !== null) clauses.push(clause);
      continue;
    }

    // Multi-value IN / NOT-IN tokens: key ends with _in, value is pipe-delimited.
    // Positive (_in): produces a Vespa OR clause: (field contains "a" OR field contains "b").
    // Negation (_not_in): produces individual AND NOT clauses — Vespa has no NOT-IN shorthand.
    // The base field name (with optional _not suffix) is validated against ALLOWED_SPARSE_IN_FIELDS.
    if (key.endsWith('_in')) {
      const fieldWithSuffix = key.slice(0, -SPARSE_IN_SUFFIX_LENGTH);
      if (!ALLOWED_SPARSE_IN_FIELDS.has(fieldWithSuffix)) {
        // Unknown field — block and skip. This is the injection prevention gate.
        continue;
      }
      const vals = value.split('|').filter((v) => v.length > 0);
      if (vals.length === 0) continue;
      if (fieldWithSuffix.endsWith('_not')) {
        // Negation NOT-IN: !(field contains "v1") AND !(field contains "v2")
        // OR for not_matches fields: !(field matches "v1") AND !(field matches "v2")
        // Derive the actual Vespa field name from the registry (handles field name remapping,
        // e.g. flavor_profile_not → flavor_profiles).
        const baseKey = fieldWithSuffix.slice(0, -SPARSE_NOT_FIELD_SUFFIX_LENGTH);
        const notSpec = FILTER_TOKEN_REGISTRY.get(fieldWithSuffix);
        // Use registry field name (handles remapping: flavor_profile_not → flavor_profiles).
        // grape_or has no field property — excluded from ALLOWED_SPARSE_IN_FIELDS _not variants.
        const actualField = notSpec !== undefined && 'field' in notSpec ? notSpec.field : baseKey;
        // Use matches (regex substring) for not_matches fields (e.g. style_not_in) — `contains`
        // on attribute-only multi-token fields silently no-ops ("full" vs "full red").
        const useNotMatches = notSpec?.type === 'not_matches';
        for (const v of vals) {
          clauses.push(
            useNotMatches
              ? `!(${actualField} matches ${yqlString(escapeRegex(v))})`
              : `!(${actualField} contains ${yqlString(v)})`,
          );
        }
      } else if (fieldWithSuffix === 'grape_or') {
        // grape_or_in: each value must match grape_primary OR grapes (blend coverage)
        const disjuncts = vals.map(
          (v) => `(grape_primary contains ${yqlString(v)} OR grapes contains ${yqlString(v)})`,
        );
        clauses.push(vals.length === 1 ? disjuncts[0]! : `(${disjuncts.join(' OR ')})`);
      } else {
        // Positive IN: use the registered operator for this base key.
        // CRITICAL: style_matches_in must use `matches`, not `contains` — look up the
        // base spec to determine the correct YQL operator instead of hardcoding `contains`.
        const baseSpec = FILTER_TOKEN_REGISTRY.get(fieldWithSuffix);
        const useMatches = baseSpec?.type === 'matches';
        const vespaField = baseSpec !== undefined && 'field' in baseSpec ? baseSpec.field : fieldWithSuffix;
        const disjuncts = useMatches
          ? vals.map((v) => `${vespaField} matches ${yqlString(escapeRegex(v))}`)
          : vals.map((v) => `${vespaField} contains ${yqlString(v)}`);
        clauses.push(vals.length === 1 ? disjuncts[0]! : `(${disjuncts.join(' OR ')})`);
      }
      continue;
    }

    // Unknown token — blocked. Never reaches Vespa.
    // No log here (hot path) — callers should validate tokens before this point.
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
