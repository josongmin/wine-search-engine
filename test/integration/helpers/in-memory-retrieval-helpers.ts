/**
 * Shared helpers for the in-memory retrieval stubs:
 *  - hash-based query-aware embedding (parity with `InMemoryEmbeddingService`)
 *  - cosine similarity for dense ranking
 *  - sparse-filter-token parser that mirrors the production
 *    `buildSparseFilters` semantics (`wine_type:red`, `region:Burgundy`,
 *    `style_matches:bold`, etc.) on the in-memory document shape.
 *
 * These exist so the in-memory `denseSearch` / `sparseSearch` /
 * `retrieveSimilar` paths honor query + hard-constraint structure the same
 * way the Vespa adapter does. Without them the stubs returned popularity-
 * sorted, filter-ignoring results, which silently broke any e2e test that
 * depended on hard-constraint filtering (mixed-route `similar_items` with a
 * `wine_type` constraint, hybrid-route ranking against an alias-matched
 * canonical, etc.).
 */

import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';

/** Vector dimension. Matches `InMemoryEmbeddingService.DIM` so the query
 *  embedding and document embedding live in the same space. */
const VECTOR_DIM = 1024;

/**
 * Deterministic hash → unit vector. SAME algorithm as
 * `InMemoryEmbeddingService.hashText` (in-memory-adapters.ts:305-315) so a
 * query embedding produced by the embedding service and a document
 * embedding produced here are directly comparable. The function is
 * intentionally permutation-sensitive on the character-position weight
 * (`code * (i+1)`), which gives "romanee conti" and "romanee-conti-2019"
 * higher overlap than "romanee conti" and "opus-one-2018".
 */
export function hashTextToVector(text: string): readonly number[] {
  const vec = new Array<number>(VECTOR_DIM).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    const idx = (code * (i + 1)) % VECTOR_DIM;
    vec[idx] = ((vec[idx] ?? 0) + code / 255) % 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Cosine similarity over two unit vectors. Returns 0 when either vector is
 * empty / dimension-mismatched rather than throwing — the in-memory stubs
 * never want to abort a search on a malformed query vector.
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * Subset of the document shape we need for filter predicate evaluation.
 * Both `RetrievalDocument` (search-index path) and `HybridCandidate`
 * (similar-retrieval path) project into this — keeping the predicate
 * agnostic to which shape the caller has.
 */
interface FilterableDoc {
  readonly wineType?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly style?: string | undefined;
  readonly priceBand?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly grapes?: readonly string[] | undefined;
  readonly grapeFamily?: string | undefined;
  readonly flavorProfile?: string | undefined;
  readonly classification?: string | undefined;
  readonly certification?: string | undefined;
  readonly soilType?: string | undefined;
  readonly producerType?: string | undefined;
  readonly pairing?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly vintageYear?: number | undefined;
  readonly alcoholPct?: number | undefined;
}

/**
 * Maps a `HybridCandidate` to the filter-predicate input shape. Production
 * `VespaSimilarRetrieval` filters at the Vespa layer; in-memory we filter
 * post-seed because the seeded neighborhood is already materialised.
 */
export function hybridCandidateToFilterableDoc(
  candidate: HybridCandidate,
): FilterableDoc {
  return {
    ...(candidate.wineType !== undefined ? { wineType: candidate.wineType } : {}),
    ...(candidate.country !== undefined ? { country: candidate.country } : {}),
    ...(candidate.region !== undefined ? { region: candidate.region } : {}),
    ...(candidate.appellation !== undefined ? { appellation: candidate.appellation } : {}),
    ...(candidate.style !== undefined ? { style: candidate.style } : {}),
    ...(candidate.priceBand !== undefined ? { priceBand: candidate.priceBand } : {}),
    ...(candidate.grapePrimary !== undefined ? { grapePrimary: candidate.grapePrimary } : {}),
    ...(candidate.grapes !== undefined ? { grapes: candidate.grapes } : {}),
    ...(candidate.vintageYear !== undefined ? { vintageYear: candidate.vintageYear } : {}),
    ...(candidate.alcoholPct !== undefined ? { alcoholPct: candidate.alcoholPct } : {}),
  };
}

interface ParsedFilter {
  readonly key: string;
  readonly modifier: 'eq' | 'in' | 'not' | 'not_in' | 'min' | 'max' | 'matches' | 'matches_in';
  readonly values: readonly string[];
}

/**
 * Parse a single sparse-filter token (e.g. `wine_type:red`, `wine_type_in:red|white`,
 * `style_matches:bold`, `vintage_year_min:2015`) into an internal `ParsedFilter`.
 *
 * Token grammar (mirrors `buildSparseFilters` in `infrastructure/vespa/mapping.ts`):
 *   <attribute>[_modifier]:<value-or-pipe-list>
 *
 * Recognised modifiers: `_in`, `_not`, `_not_in`, `_min`, `_max`, `_matches`,
 * `_matches_in`. Tokens that don't match this shape are dropped (returning
 * `null`) so an unknown token doesn't accidentally zero out the result set.
 */
function parseFilterToken(token: string): ParsedFilter | null {
  const colon = token.indexOf(':');
  if (colon <= 0 || colon === token.length - 1) return null;
  const head = token.slice(0, colon);
  const tail = token.slice(colon + 1);
  const values = tail.split('|').filter((v) => v.length > 0);
  if (values.length === 0) return null;

  // Order matters: check longer suffixes first so `_not_in` is recognised
  // before `_not`, etc.
  const SUFFIXES: readonly { suffix: string; modifier: ParsedFilter['modifier'] }[] = [
    { suffix: '_matches_in', modifier: 'matches_in' },
    { suffix: '_matches', modifier: 'matches' },
    { suffix: '_not_in', modifier: 'not_in' },
    { suffix: '_not', modifier: 'not' },
    { suffix: '_in', modifier: 'in' },
    { suffix: '_min', modifier: 'min' },
    { suffix: '_max', modifier: 'max' },
  ];
  for (const { suffix, modifier } of SUFFIXES) {
    if (head.endsWith(suffix)) {
      return { key: head.slice(0, -suffix.length), modifier, values };
    }
  }
  return { key: head, modifier: 'eq', values };
}

/**
 * Infer wine_type from style — TEST_DOCUMENTS leave `wineType` undefined and
 * encode the type implicitly in the style string ("bold red", "crisp white",
 * "sparkling"). The same inference lives in `test-fixtures.ts`'s
 * `inferWineType`; we duplicate it here (1) because the filter helper is in a
 * different module and (2) to keep the in-memory filter SELF-CONTAINED so a
 * stub-doc-only test (no fixture pipeline) still gets a sensible wine_type.
 * Production Vespa stores wine_type explicitly via ETL — no inference there.
 */
function inferWineTypeFromStyle(style: string | undefined): string | undefined {
  if (style === undefined) return undefined;
  const lower = style.toLowerCase();
  if (lower.includes('sparkling')) return 'sparkling';
  if (lower.includes('white')) return 'white';
  if (lower.includes('rosé') || lower.includes('rose')) return 'rose';
  if (lower.includes('dessert')) return 'dessert';
  if (lower.includes('fortified')) return 'fortified';
  // Default fallthrough mirrors `inferWineType` (test-fixtures.ts:315-319):
  // every other style is treated as red.
  return 'red';
}

function normaliseDocFieldValues(doc: FilterableDoc, key: string): readonly string[] {
  switch (key) {
    case 'wine_type': {
      if (doc.wineType !== undefined) return [doc.wineType.toLowerCase()];
      const inferred = inferWineTypeFromStyle(doc.style);
      return inferred !== undefined ? [inferred] : [];
    }
    case 'country':
      return doc.country !== undefined ? [doc.country.toLowerCase()] : [];
    case 'region':
      return doc.region !== undefined ? [doc.region.toLowerCase()] : [];
    case 'appellation':
      return doc.appellation !== undefined ? [doc.appellation.toLowerCase()] : [];
    case 'style':
      return doc.style !== undefined ? [doc.style.toLowerCase()] : [];
    case 'price_band':
      return doc.priceBand !== undefined ? [doc.priceBand.toLowerCase()] : [];
    case 'grape_primary':
      return doc.grapePrimary !== undefined ? [doc.grapePrimary.toLowerCase()] : [];
    case 'grape_or':
      // Special combined token: matches against grape_primary OR grapes[].
      return [
        ...(doc.grapePrimary !== undefined ? [doc.grapePrimary.toLowerCase()] : []),
        ...(doc.grapes !== undefined ? doc.grapes.map((g) => g.toLowerCase()) : []),
      ];
    case 'grapes':
      return doc.grapes !== undefined ? doc.grapes.map((g) => g.toLowerCase()) : [];
    case 'grape_family':
      return doc.grapeFamily !== undefined ? [doc.grapeFamily.toLowerCase()] : [];
    case 'flavor_profile':
      return doc.flavorProfile !== undefined ? [doc.flavorProfile.toLowerCase()] : [];
    case 'classification':
      return doc.classification !== undefined ? [doc.classification.toLowerCase()] : [];
    case 'certification':
      return doc.certification !== undefined ? [doc.certification.toLowerCase()] : [];
    case 'soil_type':
      return doc.soilType !== undefined ? [doc.soilType.toLowerCase()] : [];
    case 'producer_type':
      return doc.producerType !== undefined ? [doc.producerType.toLowerCase()] : [];
    case 'pairing':
      return doc.pairing !== undefined ? doc.pairing.map((p) => p.toLowerCase()) : [];
    case 'occasion':
      return doc.occasion !== undefined ? doc.occasion.map((o) => o.toLowerCase()) : [];
    default:
      return [];
  }
}

function evaluateFilter(doc: FilterableDoc, filter: ParsedFilter): boolean {
  // Numeric bounds — vintage_year / alcohol / price_usd.
  if (filter.modifier === 'min' || filter.modifier === 'max') {
    const numeric = numericFieldValue(doc, filter.key);
    if (numeric === undefined) return false;
    const bound = Number.parseFloat(filter.values[0] ?? '');
    if (!Number.isFinite(bound)) return true; // malformed bound → don't filter
    return filter.modifier === 'min' ? numeric >= bound : numeric <= bound;
  }

  const docValues = normaliseDocFieldValues(doc, filter.key).map((v) => v.toLowerCase());
  const filterValues = filter.values.map((v) => v.toLowerCase());

  switch (filter.modifier) {
    case 'eq':
    case 'in':
      // Doc must contain at least one of the filter values.
      return docValues.some((dv) => filterValues.includes(dv));
    case 'not':
    case 'not_in':
      return !docValues.some((dv) => filterValues.includes(dv));
    case 'matches':
      // Substring match (regex literals are normalised to safe tokens by the
      // SSoT `constraint-to-sparse-filter-tokens.ts`, so we only need a
      // case-insensitive substring check here).
      return docValues.some((dv) => filterValues.some((fv) => dv.includes(fv)));
    case 'matches_in':
      return docValues.some((dv) => filterValues.some((fv) => dv.includes(fv)));
    default:
      return true;
  }
}

function numericFieldValue(doc: FilterableDoc, key: string): number | undefined {
  switch (key) {
    case 'vintage_year':
      return doc.vintageYear;
    case 'alcohol':
    case 'alcohol_pct':
      return doc.alcoholPct;
    default:
      return undefined;
  }
}

/**
 * Build a `(doc) => boolean` predicate from an array of sparse-filter
 * tokens. The predicate AND-combines tokens (every filter must pass)
 * because Vespa filters are AND-combined in the production WHERE clause.
 *
 * Returns `() => true` when `filters` is empty/undefined so callers can
 * unconditionally invoke the predicate.
 */
export function buildFilterPredicate(
  filters: readonly string[] | undefined,
): (doc: FilterableDoc | RetrievalDocument) => boolean {
  if (filters === undefined || filters.length === 0) {
    return () => true;
  }
  const parsed = filters
    .map((token) => parseFilterToken(token))
    .filter((f): f is ParsedFilter => f !== null);
  if (parsed.length === 0) {
    return () => true;
  }
  return (doc) => {
    for (const filter of parsed) {
      if (!evaluateFilter(doc as FilterableDoc, filter)) return false;
    }
    return true;
  };
}
