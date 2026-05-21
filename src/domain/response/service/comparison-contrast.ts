/**
 * Deterministic side-by-side comparison contrast builder.
 *
 * `compare_wines` historically returned two independent search legs with no
 * comparison-specific structure — the agent had to eyeball two free-text blobs
 * and infer the deltas itself ("단순 2x search"). This module closes that gap
 * with a PURE, structural contrast: it aligns the same attribute across every
 * comparand and reports, per attribute, whether the comparands agree, differ,
 * or are only partially populated. It computes ordinal deltas for the 1–5
 * sensory scales and normalized [0,1] scores.
 *
 * Design constraints (no heuristics — purely structural):
 *  - Determinism: identical input (in any order) yields identical output.
 *  - Order-symmetry: the set of facets and the agreement/divergence verdict do
 *    NOT depend on caller-supplied entity order. Comparands inside a facet are
 *    presented in a stable order (by entityId) so compare(A,B) === compare(B,A).
 *  - Bounded comparands: at most {@link MAX_COMPARISON_COMPARANDS} are kept.
 *  - NFC normalization: every string-valued attribute is NFC-normalized so
 *    Korean labels in different Unicode normal forms compare equal.
 *  - Missing-attribute safety: a comparand lacking an attribute is recorded as
 *    `present: false`; numeric deltas are NEVER NaN (skipped instead).
 *  - Dedup: comparands sharing an entityId are collapsed (first-seen wins) so a
 *    backend that returns the same wine on both legs does not produce a
 *    degenerate "A vs A" contrast.
 *
 * This module is domain-pure: it imports only from the domain layer.
 */

import type { EntitySummary } from '../model/result-item.js';

/**
 * compare_wines is defined as a two-wine tool, but the synthesis layer accepts
 * up to this many comparands defensively so an unexpected multi-leg backend
 * response does not blow up the agent context window. Comparands beyond this
 * bound are dropped (after dedup) in stable order.
 */
export const MAX_COMPARISON_COMPARANDS = 4;

/**
 * Sensory attributes carried on an ordinal 1–5 scale. Deltas between comparands
 * are reported as integer-step differences with a direction.
 */
const ORDINAL_1_TO_5_ATTRIBUTES = [
  'body',
  'tannin',
  'acidity',
  'sweetness',
] as const;

/**
 * Numeric attributes carried on a normalized [0,1] scale. Deltas are reported as
 * floating-point differences (rounded to NUMERIC_DELTA_PRECISION decimals to
 * keep the contrast deterministic across float representations).
 */
const NORMALIZED_0_TO_1_ATTRIBUTES = [
  'criticScore',
  'finishLength',
  'producerPrestige',
  'giftSuitabilityScore',
  'beginnerSuitabilityScore',
] as const;

/** Unbounded numeric attributes (no fixed scale) reported with raw deltas. */
const RAW_NUMERIC_ATTRIBUTES = [
  'alcoholPct',
  'vintage',
] as const;

/** Single-valued string/categorical attributes compared for equality. */
const CATEGORICAL_STRING_ATTRIBUTES = [
  'producer',
  'region',
  'country',
  'appellation',
  'wineType',
  'classification',
  'style',
  'closure',
  'priceRange',
] as const;

/** Decimal places used when rounding [0,1] / raw numeric deltas. */
const NUMERIC_DELTA_PRECISION = 4;

type OrdinalAttribute = (typeof ORDINAL_1_TO_5_ATTRIBUTES)[number];
type NormalizedAttribute = (typeof NORMALIZED_0_TO_1_ATTRIBUTES)[number];
type RawNumericAttribute = (typeof RAW_NUMERIC_ATTRIBUTES)[number];
type CategoricalAttribute = (typeof CATEGORICAL_STRING_ATTRIBUTES)[number];

export type ComparisonContrastAttribute =
  | OrdinalAttribute
  | NormalizedAttribute
  | RawNumericAttribute
  | CategoricalAttribute;

export type ComparisonContrastKind = 'ordinal' | 'normalized' | 'numeric' | 'categorical';

/** Per-comparand cell within a single attribute facet. */
export interface ComparisonContrastCell {
  readonly entityId: string;
  /** Whether this comparand carries a usable (finite / non-empty) value. */
  readonly present: boolean;
  /** Numeric value for numeric facets, NFC-normalized string for categorical. */
  readonly numericValue?: number | undefined;
  readonly stringValue?: string | undefined;
}

/** Verdict for a single attribute across all comparands. */
export type ComparisonFacetVerdict =
  | 'agree' // every present comparand shares the same value
  | 'differ' // present comparands disagree
  | 'insufficient'; // fewer than two comparands carry a value

/** One attribute compared across all comparands. */
export interface ComparisonContrastFacet {
  readonly attribute: ComparisonContrastAttribute;
  readonly kind: ComparisonContrastKind;
  readonly cells: readonly ComparisonContrastCell[];
  readonly verdict: ComparisonFacetVerdict;
  /**
   * Absolute spread between the max and min present numeric values, rounded for
   * determinism. Omitted for categorical facets or when fewer than two present.
   */
  readonly numericSpread?: number | undefined;
  /** entityId carrying the max present numeric value (ties → lexicographically smallest id). */
  readonly maxEntityId?: string | undefined;
  /** entityId carrying the min present numeric value (ties → lexicographically smallest id). */
  readonly minEntityId?: string | undefined;
}

/** Discriminated result so empty/single-comparand cases are typed, never thrown. */
export type ComparisonContrast =
  | { readonly status: 'empty' }
  | { readonly status: 'single'; readonly entityId: string }
  | {
      readonly status: 'contrasted';
      readonly comparandIds: readonly string[];
      readonly facets: readonly ComparisonContrastFacet[];
      /**
       * Count of facets with verdict 'differ' — a structural measure of how much
       * the comparands actually contrast (pairwise balance signal).
       */
      readonly divergentFacetCount: number;
      /** Count of facets with verdict 'agree'. */
      readonly agreementFacetCount: number;
    };

function normalizeStringValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function roundNumericDelta(value: number): number {
  // Avoid Number.toLocaleString / locale issues; deterministic fixed precision.
  const factor = 10 ** NUMERIC_DELTA_PRECISION;
  return Math.round(value * factor) / factor;
}

/**
 * Deterministically merge a numeric attribute across duplicate copies of the
 * same entity. "First-seen wins" is order-dependent and breaks comparison
 * symmetry, so when copies disagree we keep the smaller finite value (a fixed,
 * order-independent rule). Missing/non-finite values are ignored.
 */
function mergeNumeric(left: number | undefined, right: number | undefined): number | undefined {
  const l = typeof left === 'number' && Number.isFinite(left) ? left : undefined;
  const r = typeof right === 'number' && Number.isFinite(right) ? right : undefined;
  if (l === undefined) return r;
  if (r === undefined) return l;
  return l <= r ? l : r;
}

/**
 * Deterministically merge a string attribute across duplicate copies. When
 * copies disagree we keep the lexicographically smaller normalized value so the
 * merge does not depend on caller order.
 */
function mergeString(left: string | undefined, right: string | undefined): string | undefined {
  const l = normalizeStringValue(left);
  const r = normalizeStringValue(right);
  if (l === undefined) return r;
  if (r === undefined) return l;
  return l <= r ? l : r;
}

/**
 * Fold a later duplicate copy of an entity into the already-seen one. Every
 * comparable attribute is merged with an order-independent rule so the deduped
 * comparand is identical regardless of input order. Non-comparable display
 * fields (canonicalLabel/type) keep the first-seen value.
 */
function mergeDuplicateEntity(base: EntitySummary, dup: EntitySummary): EntitySummary {
  const merged: Record<string, unknown> = { ...base };
  for (const attribute of [...ORDINAL_1_TO_5_ATTRIBUTES, ...NORMALIZED_0_TO_1_ATTRIBUTES, ...RAW_NUMERIC_ATTRIBUTES]) {
    const value = mergeNumeric(readNumericAttribute(base, attribute), readNumericAttribute(dup, attribute));
    if (value !== undefined) {
      merged[attribute] = value;
    }
  }
  for (const attribute of CATEGORICAL_STRING_ATTRIBUTES) {
    const value = mergeString(readStringAttribute(base, attribute), readStringAttribute(dup, attribute));
    if (value !== undefined) {
      merged[attribute] = value;
    }
  }
  return merged as unknown as EntitySummary;
}

/**
 * Collapse comparands sharing an entityId by deterministic attribute merge and
 * cap at the comparand bound. The merge is order-independent (see
 * {@link mergeDuplicateEntity}); the kept ordering is first-seen, but downstream
 * facet output is re-sorted by entityId so the final contrast is symmetric.
 */
function dedupAndBound(entities: readonly EntitySummary[]): readonly EntitySummary[] {
  const byId = new Map<string, EntitySummary>();
  const order: string[] = [];
  for (const entity of entities) {
    const id = entity.entityId;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, entity);
      order.push(id);
    } else {
      byId.set(id, mergeDuplicateEntity(existing, entity));
    }
  }
  // When more distinct comparands than the bound are supplied, select the kept
  // subset by sorted entityId (not input order) so the cap is order-independent
  // and the contrast stays symmetric.
  if (order.length > MAX_COMPARISON_COMPARANDS) {
    const keptIds = [...order]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, MAX_COMPARISON_COMPARANDS);
    return keptIds.map((id) => byId.get(id)!);
  }
  return order.map((id) => byId.get(id)!);
}

/** EntitySummary carries no index signature; read attributes through an unknown view. */
function attributeView(entity: EntitySummary): Readonly<Record<string, unknown>> {
  return entity as unknown as Readonly<Record<string, unknown>>;
}

function readNumericAttribute(entity: EntitySummary, attribute: ComparisonContrastAttribute): number | undefined {
  const raw = attributeView(entity)[attribute];
  // Guard against NaN/Infinity from corrupted JSONB so deltas never become NaN.
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readStringAttribute(entity: EntitySummary, attribute: ComparisonContrastAttribute): string | undefined {
  const raw = attributeView(entity)[attribute];
  return typeof raw === 'string' ? normalizeStringValue(raw) : undefined;
}

/** Stable comparand cells sorted by entityId so facet output is order-symmetric. */
function sortCellsByEntityId(cells: readonly ComparisonContrastCell[]): readonly ComparisonContrastCell[] {
  return [...cells].sort((left, right) => (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0));
}

function buildNumericFacet(
  entities: readonly EntitySummary[],
  attribute: ComparisonContrastAttribute,
  kind: ComparisonContrastKind,
): ComparisonContrastFacet | undefined {
  const cells: ComparisonContrastCell[] = entities.map((entity) => {
    const value = readNumericAttribute(entity, attribute);
    return value !== undefined
      ? { entityId: entity.entityId, present: true, numericValue: value }
      : { entityId: entity.entityId, present: false };
  });

  const presentCells = cells.filter((cell) => cell.present);
  if (presentCells.length === 0) {
    return undefined;
  }

  const sortedCells = sortCellsByEntityId(cells);
  if (presentCells.length < 2) {
    return { attribute, kind, cells: sortedCells, verdict: 'insufficient' };
  }

  // Determine max/min with deterministic tie-break on lexicographically smallest
  // entityId — never use Math.max(...spread) (stack overflow risk + tie ambiguity).
  let maxCell = presentCells[0]!;
  let minCell = presentCells[0]!;
  for (const cell of presentCells) {
    const value = cell.numericValue!;
    if (value > maxCell.numericValue! || (value === maxCell.numericValue! && cell.entityId < maxCell.entityId)) {
      maxCell = cell;
    }
    if (value < minCell.numericValue! || (value === minCell.numericValue! && cell.entityId < minCell.entityId)) {
      minCell = cell;
    }
  }

  const spread = roundNumericDelta(maxCell.numericValue! - minCell.numericValue!);
  return {
    attribute,
    kind,
    cells: sortedCells,
    verdict: spread === 0 ? 'agree' : 'differ',
    numericSpread: spread,
    maxEntityId: maxCell.entityId,
    minEntityId: minCell.entityId,
  };
}

function buildCategoricalFacet(
  entities: readonly EntitySummary[],
  attribute: ComparisonContrastAttribute,
): ComparisonContrastFacet | undefined {
  const cells: ComparisonContrastCell[] = entities.map((entity) => {
    const value = readStringAttribute(entity, attribute);
    return value !== undefined
      ? { entityId: entity.entityId, present: true, stringValue: value }
      : { entityId: entity.entityId, present: false };
  });

  const presentCells = cells.filter((cell) => cell.present);
  if (presentCells.length === 0) {
    return undefined;
  }

  const sortedCells = sortCellsByEntityId(cells);
  if (presentCells.length < 2) {
    return { attribute, kind: 'categorical', cells: sortedCells, verdict: 'insufficient' };
  }

  const distinctValues = new Set(presentCells.map((cell) => cell.stringValue!));
  return {
    attribute,
    kind: 'categorical',
    cells: sortedCells,
    verdict: distinctValues.size === 1 ? 'agree' : 'differ',
  };
}

/**
 * Build a deterministic, order-symmetric side-by-side contrast across the given
 * comparands. The facet ordering is fixed (ordinal → normalized → raw numeric →
 * categorical, each in declaration order) so the output is fully deterministic.
 */
export function buildComparisonContrast(entities: readonly EntitySummary[]): ComparisonContrast {
  const comparands = dedupAndBound(entities);
  if (comparands.length === 0) {
    return { status: 'empty' };
  }
  if (comparands.length === 1) {
    return { status: 'single', entityId: comparands[0]!.entityId };
  }

  const facets: ComparisonContrastFacet[] = [];
  for (const attribute of ORDINAL_1_TO_5_ATTRIBUTES) {
    const facet = buildNumericFacet(comparands, attribute, 'ordinal');
    if (facet !== undefined) {
      facets.push(facet);
    }
  }
  for (const attribute of NORMALIZED_0_TO_1_ATTRIBUTES) {
    const facet = buildNumericFacet(comparands, attribute, 'normalized');
    if (facet !== undefined) {
      facets.push(facet);
    }
  }
  for (const attribute of RAW_NUMERIC_ATTRIBUTES) {
    const facet = buildNumericFacet(comparands, attribute, 'numeric');
    if (facet !== undefined) {
      facets.push(facet);
    }
  }
  for (const attribute of CATEGORICAL_STRING_ATTRIBUTES) {
    const facet = buildCategoricalFacet(comparands, attribute);
    if (facet !== undefined) {
      facets.push(facet);
    }
  }

  let divergentFacetCount = 0;
  let agreementFacetCount = 0;
  for (const facet of facets) {
    if (facet.verdict === 'differ') {
      divergentFacetCount += 1;
    } else if (facet.verdict === 'agree') {
      agreementFacetCount += 1;
    }
  }

  // Comparand id ordering is stable (by entityId) so the top-level identity of
  // the contrast does not depend on caller leg order.
  const comparandIds = comparands
    .map((entity) => entity.entityId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    status: 'contrasted',
    comparandIds,
    facets,
    divergentFacetCount,
    agreementFacetCount,
  };
}
