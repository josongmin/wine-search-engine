/**
 * Pure field-mapping functions between the domain {@link RetrievalDocument}
 * and Vespa document fields.
 *
 * No I/O occurs in this module — all functions are deterministic transforms.
 */

import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
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
    canonical_label: doc.canonicalLabel,
    aliases_identity_safe: [...doc.aliasesIdentitySafe],
    aliases_noisy_recall: [...doc.aliasesNoisyRecall],
    producer: doc.producer,
    region: doc.region,
    grapes: [...doc.grapes],
    search_text_ko: doc.searchTextKo,
    search_text_en: doc.searchTextEn,
    semantic_summary: doc.semanticSummary,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    price_band: doc.priceBand,
    pairing: [...doc.pairing],
    occasion: [...doc.occasion],
    availability: doc.availability,
    popularity_score: doc.popularityScore,
  };

  if (doc.embedding !== undefined) {
    // Vespa dense tensor format: { values: number[] }
    fields['embedding'] = { values: [...doc.embedding] };
  }

  // New wine-domain fields — omit key entirely when value is absent so that
  // exactOptionalPropertyTypes semantics are preserved end-to-end.
  if (doc.vintageYear !== undefined) fields['vintage_year'] = doc.vintageYear;
  if (doc.acidity !== undefined) fields['acidity'] = doc.acidity;
  if (doc.tannin !== undefined) fields['tannin'] = doc.tannin;
  if (doc.finishLength !== undefined) fields['finish_length'] = doc.finishLength;
  if (doc.wineType !== undefined) fields['wine_type'] = doc.wineType;
  if (doc.grapePrimary !== undefined) fields['grape_primary'] = doc.grapePrimary;
  if (doc.country !== undefined) fields['country'] = doc.country;
  if (doc.appellation !== undefined) fields['appellation'] = doc.appellation;
  if (doc.producerPrestige !== undefined) fields['producer_prestige'] = doc.producerPrestige;
  if (doc.criticScoreNormalized !== undefined) fields['critic_score_normalized'] = doc.criticScoreNormalized;
  if (doc.priceUsd !== undefined) fields['price_usd'] = doc.priceUsd;

  // SOTA++ taxonomy fields
  if (doc.flavorProfiles !== undefined) fields['flavor_profiles'] = [...doc.flavorProfiles];
  if (doc.classification !== undefined) fields['classification'] = doc.classification;
  if (doc.alcoholPct !== undefined) fields['alcohol_pct'] = doc.alcoholPct;
  if (doc.drinkingWindowStart !== undefined) fields['drinking_window_start'] = doc.drinkingWindowStart;
  if (doc.drinkingWindowEnd !== undefined) fields['drinking_window_end'] = doc.drinkingWindowEnd;
  if (doc.oakTreatment !== undefined) fields['oak_treatment'] = doc.oakTreatment;
  if (doc.certifications !== undefined) fields['certifications'] = [...doc.certifications];
  if (doc.soilType !== undefined) fields['soil_type'] = doc.soilType;
  if (doc.producerType !== undefined) fields['producer_type'] = doc.producerType;

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

  // Resolve optional wine-domain fields using narrowing helpers.
  // getOptionalNumber / getOptionalString return the narrowed value or
  // undefined, allowing clean conditional spreads that satisfy
  // exactOptionalPropertyTypes without redundant `as` casts.
  const vintageYear = getOptionalNumber(fields, 'vintage_year');
  const acidity = getOptionalNumber(fields, 'acidity');
  const tannin = getOptionalNumber(fields, 'tannin');
  const finishLength = getOptionalNumber(fields, 'finish_length');
  const wineType = getOptionalString(fields, 'wine_type');
  const grapePrimary = getOptionalString(fields, 'grape_primary');
  const country = getOptionalString(fields, 'country');
  const appellation = getOptionalString(fields, 'appellation');
  const producerPrestige = getOptionalNumber(fields, 'producer_prestige');
  const criticScoreNormalized = getOptionalNumber(fields, 'critic_score_normalized');
  const priceUsd = getOptionalNumber(fields, 'price_usd');

  // SOTA++ taxonomy fields
  const flavorProfilesRaw = fields['flavor_profiles'];
  const flavorProfiles = isStringArray(flavorProfilesRaw) ? flavorProfilesRaw : undefined;
  const classification = getOptionalString(fields, 'classification');
  const alcoholPct = getOptionalNumber(fields, 'alcohol_pct');
  const drinkingWindowStart = getOptionalNumber(fields, 'drinking_window_start');
  const drinkingWindowEnd = getOptionalNumber(fields, 'drinking_window_end');
  const oakTreatment = getOptionalString(fields, 'oak_treatment');
  const certificationsRaw = fields['certifications'];
  const certifications = isStringArray(certificationsRaw) ? certificationsRaw : undefined;
  const soilType = getOptionalString(fields, 'soil_type');
  const producerType = getOptionalString(fields, 'producer_type');

  return {
    entityId: createEntityId(getString(fields, 'entity_id')),
    entityType: getString(fields, 'entity_type'),
    canonicalLabel: getString(fields, 'canonical_label'),
    aliasesIdentitySafe: getStringArray(fields, 'aliases_identity_safe'),
    aliasesNoisyRecall: getStringArray(fields, 'aliases_noisy_recall'),
    producer: getString(fields, 'producer'),
    region: getString(fields, 'region'),
    grapes: getStringArray(fields, 'grapes'),
    searchTextKo: getString(fields, 'search_text_ko'),
    searchTextEn: getString(fields, 'search_text_en'),
    semanticSummary: getString(fields, 'semantic_summary'),
    body: getNumber(fields, 'body'),
    sweetness: getNumber(fields, 'sweetness'),
    style: getString(fields, 'style'),
    priceBand: getString(fields, 'price_band'),
    pairing: getStringArray(fields, 'pairing'),
    occasion: getStringArray(fields, 'occasion'),
    availability: getBoolean(fields, 'availability'),
    popularityScore: getNumber(fields, 'popularity_score'),
    ...(embedding !== undefined && { embedding }),
    // New wine-domain optional fields — key is omitted (not set to undefined)
    // when the value is absent, satisfying exactOptionalPropertyTypes.
    ...(vintageYear !== undefined && { vintageYear }),
    ...(acidity !== undefined && { acidity }),
    ...(tannin !== undefined && { tannin }),
    ...(finishLength !== undefined && { finishLength }),
    ...(wineType !== undefined && { wineType }),
    ...(grapePrimary !== undefined && { grapePrimary }),
    ...(country !== undefined && { country }),
    ...(appellation !== undefined && { appellation }),
    ...(producerPrestige !== undefined && { producerPrestige }),
    ...(criticScoreNormalized !== undefined && { criticScoreNormalized }),
    ...(priceUsd !== undefined && { priceUsd }),
    // SOTA++ taxonomy fields
    ...(flavorProfiles !== undefined && { flavorProfiles }),
    ...(classification !== undefined && { classification }),
    ...(alcoholPct !== undefined && { alcoholPct }),
    ...(drinkingWindowStart !== undefined && { drinkingWindowStart }),
    ...(drinkingWindowEnd !== undefined && { drinkingWindowEnd }),
    ...(oakTreatment !== undefined && { oakTreatment }),
    ...(certifications !== undefined && { certifications }),
    ...(soilType !== undefined && { soilType }),
    ...(producerType !== undefined && { producerType }),
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
 * Wraps a string value for inclusion in a YQL predicate, escaping
 * double-quote characters.
 */
function yqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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
export function buildSparseFilters(filters: readonly string[]): string {
  if (filters.length === 0) return '';

  const clauses: string[] = [];

  for (const token of filters) {
    const { key, value } = parseFilterToken(token);
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
        if (isFinite(n)) clauses.push(`body >= ${n}`);
        break;
      }
      case 'body_max': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`body <= ${n}`);
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

      // New wine-domain numeric range filters
      case 'vintage_year_min': {
        const n = parseInt(value, 10);
        if (isFinite(n)) clauses.push(`vintage_year >= ${n}`);
        break;
      }
      case 'vintage_year_max': {
        const n = parseInt(value, 10);
        if (isFinite(n)) clauses.push(`vintage_year <= ${n}`);
        break;
      }
      case 'acidity_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`acidity >= ${n}`);
        break;
      }
      case 'tannin_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`tannin >= ${n}`);
        break;
      }
      case 'finish_length_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`finish_length >= ${n}`);
        break;
      }
      case 'price_usd_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`price_usd >= ${n}`);
        break;
      }
      case 'price_usd_max': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`price_usd <= ${n}`);
        break;
      }
      case 'critic_score_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`critic_score_normalized >= ${n}`);
        break;
      }
      case 'producer_prestige_min': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`producer_prestige >= ${n}`);
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
        if (isFinite(n)) clauses.push(`alcohol_pct >= ${n}`);
        break;
      }
      case 'alcohol_max': {
        const n = parseFloat(value);
        if (isFinite(n)) clauses.push(`alcohol_pct <= ${n}`);
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
        if (isFinite(n)) {
          clauses.push(`drinking_window_start <= ${n}`);
          clauses.push(`drinking_window_end >= ${n}`);
        }
        break;
      }

      default:
        // Unrecognised tokens are silently skipped to avoid breaking queries.
        break;
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
