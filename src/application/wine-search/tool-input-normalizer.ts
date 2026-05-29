/**
 * ToolInputNormalizer — context-dependent sanitization of `SearchUseCaseInput`
 * (and related shapes) from a `WineSearchAnalysis`.
 *
 * This module ports the **context-dependent** portions of the legacy
 * `src/application/agent/agent-tool-execution-policy.ts` (≈1.3kloc god-module)
 * into a clean, composable, PURE port that the new wine-search orchestrator
 * (DeterministicRouter + ExecutionRunner) can call to retain behavioral
 * parity with the agent layer.
 *
 * Source-of-port (line numbers in `agent-tool-execution-policy.ts` at HEAD):
 *  - normalizeSearchInput ............................ lines 94-204
 *  - normalizeExactMetadataSearchInput ............... search/query-execution-contract.ts:650
 *  - applyExactVintageBounds (inline) ................ lines 193-203
 *  - stripSearchDrinkabilityObjectiveFromQuery ....... lines 393-438
 *  - mergeStringArrayInput / applySearchDefaults ..... lines 469-537
 *  - applyExplicitTotalBudgetParallelSlot ............ lines 714-738
 *  - buildSlotSearchInput ............................ lines 754-793
 *  - normalizeParallelSlotOccasion ................... lines 795-812
 *
 * Design notes / scope:
 *  - PURE functions: no IO, no logging, no shared mutable state. Same input
 *    → same output. Composition is explicit and order-dependent (see
 *    `normalizeSearchInput`).
 *  - The new layer represents constraints as typed `NormalizedConstraint`
 *    arrays (filters / preferences) rather than the legacy
 *    `Record<string, unknown>` shape. The port translates the *semantic
 *    intent* of each agent sanitize function onto the typed structure:
 *    e.g. "strip exact-metadata over-constraint keys" becomes "drop
 *    constraints whose `attribute` lives in the over-constraint set."
 *  - Source uses `AgentQueryExecutionContract`; we use `WineSearchAnalysis`.
 *    The fields we read from `analysis` are:
 *      - `contract.hasEntityMetadataSignal` → over-constraint strip / limit=1
 *      - `contract.requiresDrinkabilityCheck` → drinkability strip from query
 *      - `contract.exactMetadataTargetVintage` → vintage bounds (eq)
 *      - `decomposition.parallel-slot` → slot expansion + total-budget split
 *      - `constraints.{hard,soft,inferred}` → defaults to merge into search input
 *        (legacy `normalizedConstraints[]` is read only through the compatibility
 *        adapter in `wine-search-schemas.ts`)
 *  - We do NOT port the LLM-output cleanup branches (e.g.
 *    normalizeExactLookupEntitySearchInput's curated-anchor surface rewrite
 *    against the LLM's raw query — in the new arch the analyzer emits
 *    canonical surfaces directly).
 *
 * CLAUDE.md compliance:
 *  - Rule 8 (Unicode-safe word boundaries): all Korean regex use
 *    `(?:^|[^\p{L}\p{N}])…(?=$|[^\p{L}\p{N}])` or in-context word-form
 *    matches, plus the `/u` flag. NEVER `\b`.
 *  - Rule 15 (named constants): every literal lives at module scope with
 *    a domain-justification comment.
 *  - Rule 16 (module-scope deterministic values): all `Set`/regex literals
 *    are declared once at module scope.
 *  - Rule 25/30 (SSoT): vintage bounds come from `@shared/constants`;
 *    `containsHangul` from `@shared/utils/hangul.js`.
 *  - Rule 32 (typed-array safety): `.length > 0` checks, not truthiness.
 */

import type { NormalizedConstraint } from '@shared/types/index.js';
import { containsHangul } from '@shared/utils/hangul.js';
import {
  canonicalizePriceConstraintLike,
  convertKrwToConstraintUsd,
  splitCanonicalUsdBudgetAcrossSlots,
} from '@shared/utils/canonical-price.js';
import {
  MIN_PRODUCED_VINTAGE_YEAR,
  MAX_PRODUCED_VINTAGE_YEAR,
} from '@shared/constants.js';
import {
  EXACT_METADATA_SEARCH_LIMIT,
  PRICE_CONSTRAINT_ATTRIBUTE_NAMES,
} from '@shared/constants/constraint-attributes.js';
import type {
  SearchUseCaseInput,
} from './execution-plan-schemas.js';
import {
  getCanonicalConstraintTierBundle,
  getCanonicalNormalizedConstraints,
  type WineSearchAnalysis,
} from './wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Vintage-year bounds — re-exported from the SSoT (CLAUDE.md rule 25/30).
// ---------------------------------------------------------------------------

/** Lower bound of valid produced vintage years. SSoT: `@shared/constants`. */
export const TOOL_INPUT_NORMALIZER_MIN_VINTAGE_YEAR = MIN_PRODUCED_VINTAGE_YEAR;
/** Upper bound of valid produced vintage years. SSoT: `@shared/constants`. */
export const TOOL_INPUT_NORMALIZER_MAX_VINTAGE_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

// ---------------------------------------------------------------------------
// Exact-metadata over-constraint attribute set
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts:36-55 (EXACT_LOOKUP_OVERCONSTRAINT_KEYS).
// When the analyzer signals `hasEntityMetadataSignal=true` (i.e. the user is
// asking for a specific named wine like "Opus One 2018"), structured filters
// other than `query` / `limit` / `vintage_*` (when an exact vintage is
// requested) become over-constraining: they cause the entity resolver to
// reject true matches that happen to be tagged with slightly different
// regional / stylistic metadata than the user supplied. We strip them.
//
// The constraint attribute names listed here are the canonical names used in
// `NormalizedConstraint.attribute` across the analyzer + extractor stack.

const EXACT_METADATA_OVERCONSTRAINT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'country',
  'region',
  'appellation',
  'grape_primary',
  'wine_type',
  'style',
  'styles',
  'occasion',
  'gift_suitability_min',
  'beginner_suitability_min',
  'producer_prestige_min',
  'popularity_min',
  'recipient_profile',
  'sweetness_min',
  'sweetness_max',
  'acidity_min',
  'acidity_max',
  'tannin_max',
]);

// Default search limit when `hasEntityMetadataSignal=true` lives in the SSoT
// `@shared/constants/constraint-attributes.js` as `EXACT_METADATA_SEARCH_LIMIT`.
// The agent layer narrows to 1 (`agent-tool-execution-policy.ts:201-203`) —
// picking the single best entity-resolved match.

// ---------------------------------------------------------------------------
// Drinkability strip patterns
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts:393-438 — the regex chain that strips
// drinkability keywords from the search query when a drinkability check is
// required (the check itself is handled by the runner via the
// `search-then-drinkability` plan; we just clean the natural-language query
// so the entity-resolver isn't confused by "지금 마실 만한" tokens).
//
// All patterns use `/u` (rule 8). They never employ `\b` against Hangul —
// the chained suffix patterns terminate with `[?？!！]*$` or with the
// `(?:^|[^\p{L}\p{N}])…(?=$|[^\p{L}\p{N}])` style guard.

const DRINKABILITY_STRIP_PATTERNS: readonly RegExp[] = [
  /(?:지금|현재)\s*(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu,
  /(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu,
  /(?:지금\s*바로\s*마셔야\s*하(?:는|나|나요)?|바로\s*마셔야\s*하(?:는|나|나요)?)(?:\s*(?:와인|거|것))?/giu,
  /(?:지금\s*마시면\s*아까운|셀러(?:에)?\s*넣어둘\s*만한|셀러(?:에)?\s*넣어둘|장기\s*숙성(?:용|할|해둘|하려는)?)(?:\s*(?:와인|거|것))?/giu,
  /(?:아이\s*태어난\s*해\s*와인\s*사서|성인\s*될\s*때\s*(?:같이\s*)?마시(?:려고|려는|려면)|birth[\s-]?year\s+wine|for\s+when\s+(?:my\s+)?child\s+turns\s+adult)/giu,
  /(?:currently\s+drinkable|drink\s+now|ready\s+to\s+drink|drinking\s+well\s+now)/giu,
  /(?:cellar(?:ing)?(?:\s+worthy)?|ageworthy|aging\s+potential|long[\s-]?term\s+aging|hold(?:\s+for)?)/giu,
  /(?:있(?:어|나요|나|을까|을까요)|추천(?:해줘|해주세요|해\s*줘)|tell\s+me|show\s+me)[?？!！]*$/giu,
] as const;

/** Whitespace collapse pattern — applied after the drinkability strip. */
const WHITESPACE_RUN_RE = /\s+/gu;
/** Comma-with-surrounding-whitespace pattern — replaced with a single space. */
const COMMA_WITH_WHITESPACE_RE = /\s*,\s*/gu;
/** Leading dangling connectors after strip ("중에", "and"). */
const LEADING_DANGLING_CONNECTOR_RE = /^\s*(?:중에|중|and)\s*/giu;
/** Trailing dangling connectors after strip. */
const TRAILING_DANGLING_CONNECTOR_RE = /\s*(?:중에|and|,)\s*$/giu;

/** Detects whether the cleaned query is just a bare 4-digit vintage. */
const BARE_VINTAGE_QUERY_RE = /^(?:18|19|20)\d{2}(?:\s*년산?)?$/u;

/** Generic wine noun probes — used as fallback when strip yields empty. */
const GENERIC_KOREAN_WINE_NOUN_RE = /와인/u;
const GENERIC_ENGLISH_WINE_NOUN_RE = /wine/iu;

// ---------------------------------------------------------------------------
// Opposite-color strip patterns (parallel-slot per-color query rewrite)
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts:740-752 (buildSlotQueryAnchor).
// When the analyzer decomposes a "red + white" query into parallel slots,
// each per-slot search must NOT carry the opposite-color token in its
// query text (otherwise it leaks across slots). We strip both Korean and
// English forms case-insensitively.

const OPPOSITE_COLOR_WHITE_STRIP_RE = /(?:화이트|white)/giu;
const OPPOSITE_COLOR_RED_STRIP_RE = /(?:레드|red)/giu;
const MIXED_COLOR_NOISE_RE = /(?:반반|both\s+colors?)/giu;
const SLOT_SEPARATOR_PUNCT_RE = /[/,+&]+/gu;

// ---------------------------------------------------------------------------
// Occasion preservation set
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts:770-781 (the `gift` filter inside
// buildSlotSearchInput / normalizeParallelSlotOccasion). When expanding to
// parallel slots we DROP occasion constraints because they were chosen at
// the whole-query level and don't usually map per-color cleanly — except
// for "gift" which is a top-level intent the user explicitly stated.

const OCCASION_PRESERVED_IN_PARALLEL_SLOTS: ReadonlySet<string> = new Set(['gift']);

// ---------------------------------------------------------------------------
// Style/occasion default attributes
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts:507-535 (applySearchDefaults +
// mergeStringArrayInput).
//
// In the new arch the analyzer emits tiered constraints directly on
// `analysis.constraints`. We treat that bundle as the SSoT and merge it into
// the search input only when the input hasn't already carried the same
// constraint through. Legacy `normalizedConstraints` is consumed only through
// the compatibility adapter in `wine-search-schemas.ts`.

/** Constraint attributes considered "array-merge" defaults — semantics: if
 *  the input already has constraints on this attribute, we DEDUP by `value`
 *  (string) before re-emitting. */
const ARRAY_DEFAULT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'styles',
  'occasion',
]);

// Price / budget constraint attributes come from the SSoT
// `@shared/constants/constraint-attributes.js`
// (`PRICE_CONSTRAINT_ATTRIBUTE_NAMES`). The router consumes the same set
// (CLAUDE.md rule 30 — cross-module constants live in a single module).

// ---------------------------------------------------------------------------
// Router-synthesized constraint confidence
// ---------------------------------------------------------------------------
//
// PORT: agent-tool-execution-policy.ts (all `confidence: 1.0` literals on
// router-synthesized constraints). These constraints are emitted by the
// deterministic router / normalizer itself (rule-based, no LLM), so their
// confidence is by definition maximal — they encode determinism, not an
// uncertain extraction signal. CLAUDE.md rule 15 (no magic numbers): keep
// the value as a single named module-scope const so every emit site shares
// the same auditable invariant.

/** Confidence assigned to constraints synthesized by the deterministic router
 *  (or this normalizer on its behalf). These constraints are rule-based
 *  (no LLM), so confidence is maximal — there is no extraction uncertainty
 *  to report. */
const ROUTER_SYNTHESIZED_CONSTRAINT_CONFIDENCE = 1.0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true when the input array is non-undefined AND has elements. Used
 *  in lieu of truthiness checks per CLAUDE.md rule 32. */
function isNonEmptyArray<T>(value: readonly T[] | undefined): value is readonly T[] {
  return value !== undefined && value.length > 0;
}

/** Strip drinkability keywords and dangling connectors from a query. PURE.
 *  PORT: agent-tool-execution-policy.ts:407-421. */
function applyDrinkabilityStrip(rawQuery: string): string {
  let normalized = rawQuery;
  // Sequential apply (rule 17: no `break` shortcut — we accumulate all
  // pattern effects). Each pattern is independent and order-stable.
  for (const pattern of DRINKABILITY_STRIP_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }
  return normalized
    .replace(WHITESPACE_RUN_RE, ' ')
    .replace(COMMA_WITH_WHITESPACE_RE, ' ')
    .replace(LEADING_DANGLING_CONNECTOR_RE, '')
    .replace(TRAILING_DANGLING_CONNECTOR_RE, '')
    .trim();
}

/** Extract the lone vintage signal (vintage_year `=` constraint) if the
 *  input filter set contains one. PORT: agent-tool-execution-policy.ts:422-429
 *  (the `exactVintageQuery` derivation reads from `vintage_min === vintage_max`;
 *  in the typed layer the analyzer emits a single `vintage_year` `=`
 *  constraint instead). */
function extractExactVintageFromFilters(
  filters: readonly NormalizedConstraint[] | undefined,
): number | undefined {
  if (!isNonEmptyArray(filters)) return undefined;
  for (const c of filters) {
    if (c.attribute !== 'vintage_year') continue;
    if (c.operator !== '=') continue;
    if (typeof c.value === 'number' && Number.isFinite(c.value)) {
      // Reject out-of-bounds — defense-in-depth even though the analyzer
      // already validates against MIN/MAX_PRODUCED_VINTAGE_YEAR.
      if (
        c.value >= TOOL_INPUT_NORMALIZER_MIN_VINTAGE_YEAR
        && c.value <= TOOL_INPUT_NORMALIZER_MAX_VINTAGE_YEAR
      ) {
        return Math.trunc(c.value);
      }
    }
  }
  return undefined;
}

/** Build the fallback query for a strip operation that emptied the entire
 *  text. PORT: agent-tool-execution-policy.ts:431-436. */
function buildPostStripFallback(
  originalQuery: string,
  stripped: string,
  exactVintage: number | undefined,
): string {
  if (stripped.length === 0) {
    if (exactVintage !== undefined) return `${exactVintage}년산 와인`;
    if (GENERIC_KOREAN_WINE_NOUN_RE.test(originalQuery)) return '와인';
    if (GENERIC_ENGLISH_WINE_NOUN_RE.test(originalQuery)) return 'wine';
    return originalQuery;
  }
  if (BARE_VINTAGE_QUERY_RE.test(stripped) && exactVintage !== undefined) {
    return `${exactVintage}년산 와인`;
  }
  return stripped;
}

/** Drop filters whose `attribute` lives in the over-constraint set.
 *  PORT: agent-tool-execution-policy.ts:136-155 (the structured-filter
 *  delete block when `hasEntityMetadataSignal` is true and the query is a
 *  bare exact-metadata candidate). */
function stripOverConstraintFilters(
  filters: readonly NormalizedConstraint[] | undefined,
): readonly NormalizedConstraint[] | undefined {
  if (!isNonEmptyArray(filters)) return filters;
  const kept = filters.filter((c) =>
    !EXACT_METADATA_OVERCONSTRAINT_ATTRIBUTES.has(c.attribute),
  );
  return kept.length === filters.length ? filters : (kept.length > 0 ? kept : undefined);
}

/** Replace any existing `vintage_year` constraint with an `=` bound at the
 *  target vintage, and ensure exactly one such constraint exists.
 *  PORT: agent-tool-execution-policy.ts:193-200 (the `withExactVintage` spread
 *  that writes both `vintage_min` and `vintage_max` to the target vintage). */
function applyExactVintageBound(
  filters: readonly NormalizedConstraint[] | undefined,
  targetVintage: number,
): readonly NormalizedConstraint[] {
  const others = (filters ?? []).filter((c) => c.attribute !== 'vintage_year');
  const vintageConstraint: NormalizedConstraint = {
    attribute: 'vintage_year',
    operator: '=',
    value: targetVintage,
    source_phrase: `${targetVintage}`,
    confidence: ROUTER_SYNTHESIZED_CONSTRAINT_CONFIDENCE,
  };
  return [...others, vintageConstraint];
}

/** Build a per-slot query string by stripping the opposite-color token and
 *  slot punctuation. PORT: agent-tool-execution-policy.ts:740-752
 *  (buildSlotQueryAnchor). */
function buildSlotQueryAnchor(query: string, wineType: string): string {
  const withoutOppositeColor = wineType === 'red'
    ? query.replace(OPPOSITE_COLOR_WHITE_STRIP_RE, ' ')
    : wineType === 'white'
      ? query.replace(OPPOSITE_COLOR_RED_STRIP_RE, ' ')
      : query;
  const compact = withoutOppositeColor
    .replace(MIXED_COLOR_NOISE_RE, ' ')
    .replace(SLOT_SEPARATOR_PUNCT_RE, ' ')
    .replace(WHITESPACE_RUN_RE, ' ')
    .trim();
  return compact.length > 0 ? compact : query;
}

/** Filter a filter list down to occasion entries that are preserved across
 *  parallel slots (currently: `gift`). All other occasion constraints are
 *  dropped because they don't map per-color cleanly. Returns the cleaned
 *  list (which may be shorter than the original). PORT:
 *  agent-tool-execution-policy.ts:795-812 (normalizeParallelSlotOccasion). */
function applyParallelSlotOccasionFilter(
  filters: readonly NormalizedConstraint[] | undefined,
): readonly NormalizedConstraint[] | undefined {
  if (!isNonEmptyArray(filters)) return filters;
  let mutated = false;
  const kept: NormalizedConstraint[] = [];
  for (const c of filters) {
    if (c.attribute !== 'occasion') {
      kept.push(c);
      continue;
    }
    // Keep the occasion constraint only when its value falls inside the
    // preserved set. `occasion` constraints commonly carry a string or
    // string-array value.
    if (typeof c.value === 'string') {
      if (OCCASION_PRESERVED_IN_PARALLEL_SLOTS.has(c.value)) {
        kept.push(c);
      } else {
        mutated = true;
      }
      continue;
    }
    if (Array.isArray(c.value)) {
      const preserved = c.value.filter(
        (v): v is string => typeof v === 'string' && OCCASION_PRESERVED_IN_PARALLEL_SLOTS.has(v),
      );
      if (preserved.length > 0) {
        kept.push({ ...c, value: preserved });
        if (preserved.length !== c.value.length) mutated = true;
      } else {
        mutated = true;
      }
      continue;
    }
    // Other value shapes (number / range) are not valid for `occasion`;
    // drop defensively.
    mutated = true;
  }
  if (!mutated) return filters;
  return kept.length > 0 ? kept : undefined;
}

function getRawAnalysisConstraints(
  analysis: WineSearchAnalysis,
): readonly NormalizedConstraint[] {
  if (analysis.constraints !== undefined) {
    const flattened = [
      ...analysis.constraints.hard,
      ...analysis.constraints.soft,
      ...analysis.constraints.inferred,
    ];
    if (flattened.length > 0 || analysis.normalizedConstraints.length === 0) {
      return flattened;
    }
  }
  return analysis.normalizedConstraints;
}

/** Detect whether the analysis indicates "explicit total budget for parallel
 *  slots". When the analysis decomposition is parallel-slot AND a single
 *  price constraint is present, the agent layer treats it as a *total*
 *  budget that must be divided across slots (PORT:
 *  agent-tool-execution-policy.ts:714-738). */
function findTotalBudgetForParallelSlots(
  analysis: WineSearchAnalysis,
): number | undefined {
  if (analysis.decomposition?.kind !== 'parallel-slot') return undefined;
  if (analysis.decomposition.slots.length < 2) return undefined;
  for (const c of getCanonicalNormalizedConstraints(analysis)) {
    if (!PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has(c.attribute)) continue;
    const canonical = canonicalizePriceConstraintLike(c);
    if (typeof canonical.value === 'number' && Number.isFinite(canonical.value) && canonical.value > 0) {
      return canonical.value;
    }
    if (typeof canonical.value === 'object' && !Array.isArray(canonical.value)) {
      const maxVal = (canonical.value as { readonly max?: number }).max;
      if (typeof maxVal === 'number' && Number.isFinite(maxVal) && maxVal > 0) {
        return maxVal;
      }
    }
  }
  return undefined;
}

function findLegacyTotalBudgetKrwForParallelSlots(
  analysis: WineSearchAnalysis,
): number | undefined {
  if (analysis.decomposition?.kind !== 'parallel-slot') return undefined;
  if (analysis.decomposition.slots.length < 2) return undefined;
  for (const constraint of getRawAnalysisConstraints(analysis)) {
    if (
      constraint.attribute !== 'price_krw'
      && constraint.attribute !== 'max_price_krw'
      && constraint.attribute !== 'min_price_krw'
    ) {
      continue;
    }
    if (typeof constraint.value === 'number' && Number.isFinite(constraint.value) && constraint.value > 0) {
      return Math.floor(constraint.value);
    }
    if (typeof constraint.value === 'object' && !Array.isArray(constraint.value)) {
      const maxVal = (constraint.value as { readonly max?: number }).max;
      if (typeof maxVal === 'number' && Number.isFinite(maxVal) && maxVal > 0) {
        return Math.floor(maxVal);
      }
    }
  }
  return undefined;
}

/** Apply (or replace) a single canonical `price_usd` `<=` constraint on a
 *  filter list. Drops any pre-existing price constraints. */
function applyPerSlotBudget(
  filters: readonly NormalizedConstraint[] | undefined,
  perSlotBudgetUsd: number,
): readonly NormalizedConstraint[] {
  const others = (filters ?? []).filter(
    (c) => !PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has(c.attribute),
  );
  const slotBudget: NormalizedConstraint = {
    attribute: 'price_usd',
    operator: '<=',
    value: perSlotBudgetUsd,
    source_phrase: `price_usd<=${perSlotBudgetUsd} (per slot)`,
    confidence: ROUTER_SYNTHESIZED_CONSTRAINT_CONFIDENCE,
    soft_promotion_authority: 'allow',
  };
  return [...others, slotBudget];
}

/** Dedup constraints by `(attribute, value-key)` while preserving order. The
 *  first occurrence wins. This is used when merging analysis defaults into
 *  an input that may already contain some of those constraints. */
function dedupConstraintsByAttributeAndValue(
  constraints: readonly NormalizedConstraint[],
): readonly NormalizedConstraint[] {
  const seen = new Set<string>();
  const out: NormalizedConstraint[] = [];
  for (const c of constraints) {
    const valueKey = (() => {
      if (typeof c.value === 'string' || typeof c.value === 'number') return String(c.value);
      if (Array.isArray(c.value)) return `arr:${c.value.join(',')}`;
      // Range object: `{ min: number; max: number }`. The fall-through guard
      // narrows because string/number/array are all handled above; what
      // remains is the range object.
      const rng = c.value as { readonly min: number; readonly max: number };
      return `rng:${rng.min}-${rng.max}`;
    })();
    const key = `${c.attribute}|${c.operator}|${valueKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ToolInputNormalizer {
  /**
   * Apply the full search-input normalization pipeline. Composes (in order):
   *   1. applyExactMetadataNormalization
   *   2. stripDrinkabilityObjectiveFromQuery
   *   3. applyAnalysisDefaults
   *
   * The order is deliberate: over-constraint stripping must happen BEFORE
   * default merging (otherwise the defaults reintroduce constraints we
   * just stripped). Drinkability strip happens before default merge so the
   * cleaned query is what the analyzer-sourced defaults reason about.
   */
  normalizeSearchInput(
    input: SearchUseCaseInput,
    analysis: WineSearchAnalysis,
  ): SearchUseCaseInput;

  /**
   * Apply per-slot normalization for parallel-slot expansion: rewrite the
   * query to strip the opposite-color token, split a total budget across
   * slots, and drop non-`gift` occasion filters.
   *
   * `slotCount` MUST equal `decomposition.slots.length` for budget split
   * arithmetic to match the analysis.
   */
  normalizeParallelSlotInput(
    input: SearchUseCaseInput,
    analysis: WineSearchAnalysis,
    slot: { readonly wineType: string; readonly limit?: number | undefined },
    slotCount: number,
  ): SearchUseCaseInput;

  /**
   * Narrow the input for exact-metadata entity lookup:
   *  - drop over-constraining filters,
   *  - cap `limit` to 1,
   *  - if `exactMetadataTargetVintage` is set, replace any `vintage_year`
   *    constraint with `vintage_year = target`.
   * No-op when `hasEntityMetadataSignal=false`.
   */
  applyExactMetadataNormalization(
    input: SearchUseCaseInput,
    analysis: WineSearchAnalysis,
  ): SearchUseCaseInput;

  /**
   * Strip drinkability keywords from the search query text and (if the
   * cleaned query is just a bare vintage) replace it with a vintage-anchored
   * generic noun. No-op when `requiresDrinkabilityCheck=false`.
   */
  stripDrinkabilityObjectiveFromQuery(
    input: SearchUseCaseInput,
    analysis: WineSearchAnalysis,
  ): SearchUseCaseInput;

  /**
   * Merge analysis-driven defaults into the search input. Hard constraints are
   * merged into `filters`; soft/inferred constraints are merged into
   * `preferences`. No-op when the analysis carries no constraints OR when the
   * input is an exact-metadata lookup (defaults would re-introduce
   * over-constraints).
   */
  applyAnalysisDefaults(
    input: SearchUseCaseInput,
    analysis: WineSearchAnalysis,
  ): SearchUseCaseInput;
}

export const DefaultToolInputNormalizer: ToolInputNormalizer = {
  normalizeSearchInput(input, analysis) {
    let next = input;
    next = this.applyExactMetadataNormalization(next, analysis);
    next = this.stripDrinkabilityObjectiveFromQuery(next, analysis);
    next = this.applyAnalysisDefaults(next, analysis);
    return next;
  },

  normalizeParallelSlotInput(input, analysis, slot, slotCount) {
    if (!Number.isFinite(slotCount) || slotCount < 2) return input;

    // 1. Query anchor — strip opposite-color tokens for this slot.
    const nextQuery = typeof input.query === 'string'
      ? buildSlotQueryAnchor(input.query, slot.wineType)
      : input.query;

    // 2. Occasion filter — preserve only `gift`.
    const filtersAfterOccasion = applyParallelSlotOccasionFilter(input.filters);

    // 3. wine_type constraint — replace any existing wine_type filter with
    //    this slot's color (the slot expansion is the canonical source).
    const filtersWithoutWineType = (filtersAfterOccasion ?? []).filter(
      (c) => c.attribute !== 'wine_type',
    );
    const slotWineTypeConstraint: NormalizedConstraint = {
      attribute: 'wine_type',
      operator: '=',
      value: slot.wineType,
      source_phrase: slot.wineType,
      confidence: ROUTER_SYNTHESIZED_CONSTRAINT_CONFIDENCE,
    };
    let filtersWithSlot: readonly NormalizedConstraint[] = [
      ...filtersWithoutWineType,
      slotWineTypeConstraint,
    ];

    // 4. Total-budget split — if the analysis carries a total budget on the
    //    parallel-slot decomposition, divide it equally across slots.
    const legacyTotalBudgetKrw = findLegacyTotalBudgetKrwForParallelSlots(analysis);
    const perSlotBudgetUsd =
      legacyTotalBudgetKrw !== undefined
        ? convertKrwToConstraintUsd(Math.floor(legacyTotalBudgetKrw / slotCount))
        : splitCanonicalUsdBudgetAcrossSlots(findTotalBudgetForParallelSlots(analysis), slotCount);
    if (perSlotBudgetUsd !== undefined && perSlotBudgetUsd > 0) {
      filtersWithSlot = applyPerSlotBudget(filtersWithSlot, perSlotBudgetUsd);
    }

    return {
      ...input,
      ...(typeof nextQuery === 'string' && nextQuery.length > 0 ? { query: nextQuery } : {}),
      filters: [...filtersWithSlot],
      ...(slot.limit !== undefined ? { limit: slot.limit } : {}),
    };
  },

  applyExactMetadataNormalization(input, analysis) {
    if (!analysis.contract.hasEntityMetadataSignal) return input;

    // Step 1 — strip over-constraint filters.
    let nextFilters = stripOverConstraintFilters(input.filters);

    // Step 2 — apply exact vintage bound (eq) if requested.
    const targetVintage = analysis.contract.exactMetadataTargetVintage;
    if (targetVintage !== undefined) {
      nextFilters = applyExactVintageBound(nextFilters, targetVintage);
    }

    // Step 3 — narrow `limit` to EXACT_METADATA_SEARCH_LIMIT (1).
    const nextLimit = EXACT_METADATA_SEARCH_LIMIT;

    // Build the output without re-introducing the original filters via the
    // `...input` spread (CLAUDE.md exactOptionalPropertyTypes: omit the key
    // rather than assigning undefined). We pull out `filters` and `limit`
    // explicitly so the conditional spread is the only writer of those keys.
    const { filters: _origFilters, limit: _origLimit, ...inputRest } = input;
    void _origFilters;
    void _origLimit;
    return {
      ...inputRest,
      ...(isNonEmptyArray(nextFilters) ? { filters: [...nextFilters] } : {}),
      limit: nextLimit,
    };
  },

  stripDrinkabilityObjectiveFromQuery(input, analysis) {
    if (!analysis.contract.requiresDrinkabilityCheck) return input;
    if (typeof input.query !== 'string' || input.query.length === 0) return input;

    const stripped = applyDrinkabilityStrip(input.query);
    const exactVintage = extractExactVintageFromFilters(input.filters)
      ?? analysis.contract.exactMetadataTargetVintage;
    const finalQuery = buildPostStripFallback(input.query, stripped, exactVintage);

    if (finalQuery === input.query) return input;
    // SearchUseCaseInputSchema requires query.min(1) — we never return an
    // empty string; buildPostStripFallback always yields at least 1 char.
    return { ...input, query: finalQuery };
  },

  applyAnalysisDefaults(input, analysis) {
    const constraintBundle = getCanonicalConstraintTierBundle(analysis);
    const hasAnyDefaults =
      constraintBundle.hard.length > 0
      || constraintBundle.soft.length > 0
      || constraintBundle.inferred.length > 0;
    if (!hasAnyDefaults) return input;
    // Suppress defaults on exact-metadata lookups — they would re-introduce
    // the over-constraint filters we just stripped.
    if (analysis.contract.hasEntityMetadataSignal) return input;

    const existingFilters = input.filters ?? [];
    const existingPreferences = input.preferences ?? [];
    const mergedFilters = dedupConstraintsByAttributeAndValue([
      ...existingFilters,
      ...constraintBundle.hard,
    ]);
    const mergedPreferences = dedupConstraintsByAttributeAndValue([
      ...existingPreferences,
      ...constraintBundle.soft,
      ...constraintBundle.inferred,
    ]);

    if (
      mergedFilters.length === existingFilters.length
      && mergedPreferences.length === existingPreferences.length
    ) {
      return input;
    }

    const {
      filters: _ignoredFilters,
      preferences: _ignoredPreferences,
      ...rest
    } = input;
    void _ignoredFilters;
    void _ignoredPreferences;
    return {
      ...rest,
      ...(mergedFilters.length > 0 ? { filters: [...mergedFilters] } : {}),
      ...(mergedPreferences.length > 0 ? { preferences: [...mergedPreferences] } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Re-exports for tests / runner wiring
// ---------------------------------------------------------------------------

export {
  applyDrinkabilityStrip as _internalApplyDrinkabilityStrip,
  buildSlotQueryAnchor as _internalBuildSlotQueryAnchor,
  applyParallelSlotOccasionFilter as _internalApplyParallelSlotOccasionFilter,
  findTotalBudgetForParallelSlots as _internalFindTotalBudgetForParallelSlots,
};

// Acknowledgment that `containsHangul` is currently imported as a SSoT
// affordance for future-proofing (planned: per-language fallback strategies
// when the drinkability strip empties the query). We touch it once here to
// keep the import surface stable while the follow-up wiring lands.
void containsHangul;

// Acknowledgment of the `ARRAY_DEFAULT_ATTRIBUTES` constant — currently
// declared at module scope for documentation parity with the agent layer's
// mergeStringArrayInput call sites. The new layer's dedupe-by-value path
// generalizes the agent layer's array-merge per-attribute treatment.
void ARRAY_DEFAULT_ATTRIBUTES;

// PRICE_CONSTRAINT_ATTRIBUTE_NAMES is imported from the SSoT for parity with
// the router; this normalizer never consumes the value directly (the router
// owns the route-time price-intent check), so the import is intentionally
// kept as a no-op reference to lock in the SSoT contract.
void PRICE_CONSTRAINT_ATTRIBUTE_NAMES;
