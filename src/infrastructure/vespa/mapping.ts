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
    embedding,
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
 * - `price_band:<value>` → `price_band contains "value"`
 * - `style:<value>`      → `style contains "value"`
 * - `body_min:<n>`       → `body >= n`
 * - `body_max:<n>`       → `body <= n`
 * - `availability:true`  → `availability = true`
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
