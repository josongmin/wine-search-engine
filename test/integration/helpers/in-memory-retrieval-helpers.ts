/**
 * Shared helpers for the in-memory retrieval stubs — sparse-filter-token
 * parser that mirrors the production `buildSparseFilters` semantics
 * (`wine_type:red`, `region:Burgundy`, `style_matches:bold`, etc.) on the
 * in-memory document shape.
 *
 * Exists so the in-memory `denseSearch` / `sparseSearch` / `retrieveSimilar`
 * paths honor hard-constraint structure the same way the Vespa adapter does.
 * Without this the stubs returned filter-ignoring results, which silently
 * broke any e2e test that depended on hard-constraint filtering (mixed-route
 * `similar_items` with a `wine_type` constraint, ETC.).
 */

import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';

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
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly finishLength?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly producerPrestige?: number | undefined;
  readonly priceUsd?: number | undefined;
  readonly giftSuitabilityScore?: number | undefined;
  readonly beginnerSuitabilityScore?: number | undefined;
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
    ...(candidate.body !== undefined ? { body: candidate.body } : {}),
    ...(candidate.tannin !== undefined ? { tannin: candidate.tannin } : {}),
    ...(candidate.acidity !== undefined ? { acidity: candidate.acidity } : {}),
    ...(candidate.sweetness !== undefined ? { sweetness: candidate.sweetness } : {}),
    ...(candidate.finishLength !== undefined ? { finishLength: candidate.finishLength } : {}),
    ...(candidate.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: candidate.criticScoreNormalized }
      : {}),
    ...(candidate.producerPrestige !== undefined ? { producerPrestige: candidate.producerPrestige } : {}),
    ...(candidate.priceUsd !== undefined ? { priceUsd: candidate.priceUsd } : {}),
    ...(candidate.giftSuitabilityScore !== undefined
      ? { giftSuitabilityScore: candidate.giftSuitabilityScore }
      : {}),
    ...(candidate.beginnerSuitabilityScore !== undefined
      ? { beginnerSuitabilityScore: candidate.beginnerSuitabilityScore }
      : {}),
  };
}

const SENSORY_RAW_SCALE_MAX = 5;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeSensory01(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 1) {
    return Math.max(0, value);
  }
  return clamp01(value / SENSORY_RAW_SCALE_MAX);
}

function normalizeUnitInterval(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 1) {
    return Math.max(0, value);
  }
  if (value <= 100) {
    return clamp01(value / 100);
  }
  return value;
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

function inferCountryFromRegion(region: string | undefined): string | undefined {
  if (region === undefined) return undefined;
  const lower = region.toLowerCase();
  if (lower.includes('napa') || lower.includes('california')) return 'united states';
  if (lower.includes('bordeaux') || lower.includes('burgundy') || lower.includes('champagne')) return 'france';
  if (lower.includes('tuscany') || lower.includes('piedmont') || lower.includes('veneto')) return 'italy';
  if (lower.includes('barossa') || lower.includes('south australia') || lower.includes('south eastern australia')) return 'australia';
  if (lower.includes('marlborough')) return 'new zealand';
  return undefined;
}

function normaliseDocFieldValues(doc: FilterableDoc, key: string): readonly string[] {
  switch (key) {
    case 'wine_type': {
      if (doc.wineType !== undefined) return [doc.wineType.toLowerCase()];
      const inferred = inferWineTypeFromStyle(doc.style);
      return inferred !== undefined ? [inferred] : [];
    }
    case 'country':
      if (doc.country !== undefined) return [doc.country.toLowerCase()];
      return inferCountryFromRegion(doc.region) !== undefined
        ? [inferCountryFromRegion(doc.region)!]
        : [];
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
    case 'body':
      return normalizeSensory01(doc.body);
    case 'tannin':
      return normalizeSensory01(doc.tannin);
    case 'acidity':
      return normalizeSensory01(doc.acidity);
    case 'sweetness':
      return normalizeSensory01(doc.sweetness);
    case 'finish_length':
      return normalizeSensory01(doc.finishLength);
    case 'critic_score':
      return normalizeUnitInterval(doc.criticScoreNormalized);
    case 'producer_prestige':
      return normalizeUnitInterval(doc.producerPrestige);
    case 'price_usd':
      return doc.priceUsd;
    case 'gift_suitability':
      return normalizeUnitInterval(doc.giftSuitabilityScore);
    case 'beginner_suitability':
      return normalizeUnitInterval(doc.beginnerSuitabilityScore);
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
