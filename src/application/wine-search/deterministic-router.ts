/**
 * DeterministicRouter — pure planning from `WineSearchAnalysis` to
 * `ExecutionPlan`.
 *
 * The router is deliberately IO-free: it takes the typed analysis output
 * from `QueryAnalyzerService` and returns a serializable plan. The
 * `ExecutionRunner` is the only component that talks to use cases. This
 * separation makes routing decisions:
 *  - unit-testable without spinning up adapters,
 *  - replayable from a stored analysis blob,
 *  - amenable to property-based assertions (same analysis → same plan).
 *
 * Routing rules (deterministic, in priority order):
 *  1. analysis-rejected guard — no anchors AND no constraints AND
 *     intent=unknown → reject.
 *  2. decomposition.kind=comparison → comparison plan.
 *  3. decomposition.kind=parallel-slot → parallel-search plan (one search
 *     per slot, total budget split if present).
 *  4. requiredTool=get_food_pairings AND intent=pair:
 *      - budget signal present → food-pairing-then-search plan,
 *      - else → single-search plan with pairing-augmented input.
 *  5. requiresDrinkabilityCheck=true AND anchors.length>0 →
 *     search-then-drinkability plan.
 *  6. expectedMultiStep=true (none of the above) → multi-step handoff.
 *  7. fallback → single-search plan (80% happy path).
 *
 * NOTE: this router consumes the **already normalized** constraint set
 * produced by `QueryAnalyzerService`. The full sanitize pipeline in
 * `src/application/agent/agent-tool-execution-policy.ts` (≈1.3kloc) still
 * needs to be ported piece-by-piece; this module only owns the small
 * normalizations that are load-bearing for plan shape (slot expansion,
 * exact-metadata limit, food-pairing tag merge, total-budget split).
 *
 * Sanitize functions still pending port:
 *  - applyParallelSlotInput            → agent-tool-execution-policy.ts:718
 *  - buildSlotSearchInput              → agent-tool-execution-policy.ts:754
 *  - normalizeParallelSlotOccasion     → agent-tool-execution-policy.ts:795
 *  - applyExactMetadataOverConstraint  → agent-tool-execution-policy.ts:108
 *  - applyExactVintageBounds           → agent-tool-execution-policy.ts:183
 *  - applyDrinkabilityStrip            → agent-tool-execution-policy.ts:294
 *  - mergeStyleArrayDefaults           → agent-tool-execution-policy.ts:507
 */

import type { NormalizedConstraint } from '@shared/types/index.js';
import {
  EXACT_METADATA_SEARCH_LIMIT,
  PRICE_CONSTRAINT_ATTRIBUTE_NAMES,
} from '@shared/constants/constraint-attributes.js';
import {
  DETERMINISTIC_ROUTER_MAX_DRINKABILITY_ANCHORS,
  EXECUTION_PLAN_KINDS,
  type ComparisonUseCaseInput,
  type ExecutionPlan,
  type ExecutionPlanKind,
  type FoodPairingUseCaseInput,
  type PairingColor,
  type SearchUseCaseInput,
} from './execution-plan-schemas.js';
import type {
  AnalysisContract,
  AnchorResolution,
  Decomposition,
  RecommendedBudget,
  WineSearchAnalysis,
} from './wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Default drinkability target year — the runner can override this via the
 *  request context if the user specifies a different target year. Anchored
 *  on "now" but injected here to keep planning deterministic per call. */
const DRINKABILITY_DEFAULT_TARGET_YEAR_OFFSET = 0;

// Exact-metadata over-constraint cap and price-attribute set are imported
// from `@shared/constants/constraint-attributes.js` (SSoT — rule 30). The
// previous router-local literal value `5` did not match the agent execution
// policy's `limit: 1` and was silently widening exact-metadata lookups; the
// SSoT constant `EXACT_METADATA_SEARCH_LIMIT` (= 1) keeps both call sites in
// agreement.

/**
 * Plan-kind named locals — sourced from the `EXECUTION_PLAN_KINDS` SSoT
 * tuple in `execution-plan-schemas.ts`. Indexed access preserves each
 * element's literal type (the SSoT tuple is `as const`), so each local is
 * typed as its exact literal — assigning the wrong literal to e.g.
 * `PLAN_KIND_COMPARISON` fails at `tsc`. This keeps router `return`
 * expressions pinned to the SSoT: rename a kind there and every site here
 * fails to type-check.
 */
const PLAN_KIND_SINGLE_SEARCH = EXECUTION_PLAN_KINDS[0];
const PLAN_KIND_PARALLEL_SEARCH = EXECUTION_PLAN_KINDS[1];
const PLAN_KIND_COMPARISON = EXECUTION_PLAN_KINDS[2];
const PLAN_KIND_FOOD_PAIRING_THEN_SEARCH = EXECUTION_PLAN_KINDS[3];
const PLAN_KIND_SEARCH_THEN_DRINKABILITY = EXECUTION_PLAN_KINDS[4];
const PLAN_KIND_MULTI_STEP = EXECUTION_PLAN_KINDS[5];
const PLAN_KIND_REJECT = EXECUTION_PLAN_KINDS[6];

// Compile-time membership guard — each local must be a member of the
// `ExecutionPlanKind` SSoT union. Catches an out-of-bounds tuple index
// silently producing `undefined` (e.g. if a kind is removed from the
// tuple). The `satisfies` clause forces TS to verify membership without
// widening the literal types of the locals.
void ({
  PLAN_KIND_SINGLE_SEARCH,
  PLAN_KIND_PARALLEL_SEARCH,
  PLAN_KIND_COMPARISON,
  PLAN_KIND_FOOD_PAIRING_THEN_SEARCH,
  PLAN_KIND_SEARCH_THEN_DRINKABILITY,
  PLAN_KIND_MULTI_STEP,
  PLAN_KIND_REJECT,
} satisfies Record<string, ExecutionPlanKind>);

/** Multi-step initial-action mapping. Pulled out as a constant table so the
 *  routing logic itself stays declarative. */
const MULTI_STEP_INITIAL_ACTION_BY_INTENT = new Map<
  WineSearchAnalysis['intent'],
  'search' | 'compare' | 'pair'
>([
  ['search', 'search'],
  ['compare', 'compare'],
  ['pair', 'pair'],
  ['drinkability', 'search'],
  ['unknown', 'search'],
]);

/**
 * Wine-domain top-level keywords. Presence of any of these in the user
 * query — even when the analyzer found zero anchors and zero constraints —
 * is sufficient evidence that the query is wine-domain. We then fall through
 * to a generic single-search instead of rejecting as `unsupported_intent`.
 *
 * Why this matters (CLAUDE.md rule 23 — false-positive guard):
 *   Casual / conversational queries like "와인 좀 알려줘",
 *   "와인 추천해 주시겠어요?", "아이 태어난 해 와인" carry no anchorable
 *   span and no rule-based constraint, yet they are unambiguously
 *   wine-domain. The original rule-1 guard collapsed them to
 *   `unsupported_intent` and surfaced a "we can't help with that"
 *   coverage-gap template — a silent UX bug that this catalog corrects.
 *
 * Unicode-safe (rule 8/24): pattern uses
 * `(?:^|[^\p{L}\p{N}])…(?=$|[^\p{L}\p{N}])` boundaries on the
 * lower-cased + collapsed-whitespace query surface, never `\b`.
 */
const WINE_DOMAIN_KEYWORD_RE =
  /(?:^|[^\p{L}\p{N}])(?:와인|wine|wines|vino|grape|grapes|sommelier|소믈리에|포도주|양조)(?=$|[^\p{L}\p{N}])/iu;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isComparisonDecomposition(
  decomposition: Decomposition | undefined,
): decomposition is Extract<Decomposition, { kind: 'comparison' }> {
  return decomposition !== undefined && decomposition.kind === 'comparison';
}

function isParallelSlotDecomposition(
  decomposition: Decomposition | undefined,
): decomposition is Extract<Decomposition, { kind: 'parallel-slot' }> {
  return decomposition !== undefined && decomposition.kind === 'parallel-slot';
}

function hasPriceConstraint(constraints: readonly NormalizedConstraint[]): boolean {
  // Pre-flight check (CLAUDE.md rule 20): cheap test before any other work.
  // Loop, not spread (rule 9 in spirit — even if Math.* isn't involved,
  // we want predictable behavior on adversarial inputs).
  for (const c of constraints) {
    if (PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has(c.attribute)) {
      return true;
    }
  }
  return false;
}

function extractPairingColorFromAnchors(
  anchors: readonly AnchorResolution[],
): PairingColor | undefined {
  // Style anchors may surface a color hint (`red`, `white`, …). Style
  // anchors carry the canonical value already lower-cased.
  for (const a of anchors) {
    if (a.entityType !== 'style') continue;
    const v = a.canonicalValue.toLowerCase();
    if (v === 'red' || v === 'white' || v === 'sparkling') return v;
    if (v === 'rose' || v === 'rosé' || v === 'rosado') return 'rosé';
  }
  return undefined;
}

function extractPriceBudgetKrw(
  constraints: readonly NormalizedConstraint[],
): number | undefined {
  for (const c of constraints) {
    if (c.attribute !== 'max_price_krw' && c.attribute !== 'price_krw') continue;
    const v = c.value;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const maxVal = (v as { readonly max?: number }).max;
      if (typeof maxVal === 'number' && Number.isFinite(maxVal) && maxVal > 0) {
        return Math.floor(maxVal);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Local helpers for input construction (rule-15 named consts where applicable)
// ---------------------------------------------------------------------------

/**
 * Build a `SearchUseCaseInput` from the base analysis, optionally narrowing
 * to an exact-metadata limit when the analysis flags a hard entity signal.
 *
 * Limit precedence:
 *   1. Exact-metadata signal → `EXACT_METADATA_SEARCH_LIMIT` (= 1). The
 *      tightest possible pool — we want the single canonical match.
 *   2. Analyzer-emitted adaptive retrieval k
 *      (`recommendedBudget.retrievalK`, SSoT `RETRIEVAL_K_BY_INTENT`). This
 *      varies the pool size per intent class (entity_lookup=20, …,
 *      exploratory=500). See `adaptive-budget.ts` for the rationale.
 *   3. No limit field — downstream use case applies its own default.
 *      Retained for backwards compat with fixtures that omit `retrievalK`
 *      from `recommendedBudget`.
 */
function buildSearchInputFromAnalysis(
  analysis: WineSearchAnalysis,
): SearchUseCaseInput {
  const filters = [...analysis.normalizedConstraints];
  if (analysis.contract.hasEntityMetadataSignal) {
    return {
      query: analysis.preservedSurface,
      ...(filters.length > 0 ? { filters } : {}),
      limit: EXACT_METADATA_SEARCH_LIMIT,
      mode: 'entity' as const,
    };
  }
  const adaptiveK = analysis.recommendedBudget.retrievalK;
  return {
    query: analysis.preservedSurface,
    ...(filters.length > 0 ? { filters } : {}),
    ...(adaptiveK !== undefined ? { limit: adaptiveK } : {}),
  };
}

/**
 * Split a single total-budget cap across N parallel slots. Returns
 * `undefined` when no budget is set. Use Math.floor so summed slot
 * budgets never exceed the user's stated total.
 */
function splitTotalBudgetAcrossSlots(
  totalBudgetKrw: number | undefined,
  slotCount: number,
): number | undefined {
  if (totalBudgetKrw === undefined) return undefined;
  if (slotCount <= 0 || !Number.isFinite(slotCount)) return undefined;
  if (!Number.isFinite(totalBudgetKrw) || totalBudgetKrw <= 0) return undefined;
  return Math.floor(totalBudgetKrw / slotCount);
}

/**
 * Apply the food-pairing tag merge into a base search input. The base input
 * receives `pairing` preferences from the LLM/observation step; this helper
 * normalizes the constraint shape so the runner can pass it straight to the
 * search use case.
 *
 * see: src/application/agent/agent-tools.ts:1899-1918 for the full
 * enrichment pipeline (color filter, structured preferences, query-suffix
 * clauses).
 */
function mergePairingTagsIntoSearchInput(
  base: SearchUseCaseInput,
  pairing: FoodPairingUseCaseInput,
): SearchUseCaseInput {
  const pairingFilter: NormalizedConstraint | undefined =
    pairing.color !== undefined && pairing.color !== 'both'
      ? {
        attribute: 'wine_type',
        operator: '=',
        value: pairing.color,
        source_phrase: `food_pairing_color=${pairing.color}`,
        confidence: 1.0,
      }
      : undefined;

  const pairingPreference: NormalizedConstraint | undefined =
    pairing.pairingTags !== undefined && pairing.pairingTags.length > 0
      ? {
        attribute: 'pairing',
        operator: 'in',
        value: [...pairing.pairingTags],
        source_phrase: pairing.pairingTags.join(', '),
        confidence: 1.0,
      }
      : undefined;

  const stylePreferences: NormalizedConstraint[] =
    pairing.styles !== undefined && pairing.styles.length > 0
      ? [{
        attribute: 'styles',
        operator: 'in',
        value: [...pairing.styles],
        source_phrase: pairing.styles.join(', '),
        confidence: 1.0,
      }]
      : [];

  const nextFilters: NormalizedConstraint[] = [
    ...(base.filters ?? []),
    ...(pairingFilter !== undefined ? [pairingFilter] : []),
  ];
  const nextPreferences: NormalizedConstraint[] = [
    ...(base.preferences ?? []),
    ...(pairingPreference !== undefined ? [pairingPreference] : []),
    ...stylePreferences,
  ];

  return {
    ...base,
    ...(nextFilters.length > 0 ? { filters: nextFilters } : {}),
    ...(nextPreferences.length > 0 ? { preferences: nextPreferences } : {}),
  };
}

/**
 * Build a `FoodPairingUseCaseInput` from analysis. We extract the food
 * surface from `preservedSurface` (rule-25 SSoT vocabulary lookup lives
 * upstream in the pairing-extractor — we don't re-derive it here).
 */
function buildFoodPairingInputFromAnalysis(
  analysis: WineSearchAnalysis,
): FoodPairingUseCaseInput {
  const color = extractPairingColorFromAnchors(analysis.anchors);
  const budgetKrw = extractPriceBudgetKrw(analysis.normalizedConstraints);
  return {
    food: analysis.preservedSurface,
    ...(color !== undefined ? { color } : {}),
    ...(budgetKrw !== undefined ? { maxPriceKrw: budgetKrw } : {}),
  };
}

/**
 * Convert a deterministic comparison-leg into a runner-ready leg by
 * preserving the analysis-emitted surface and constraints.
 */
function buildComparisonInputFromAnalysis(
  analysis: WineSearchAnalysis,
  decomposition: Extract<Decomposition, { kind: 'comparison' }>,
): ComparisonUseCaseInput | undefined {
  if (decomposition.legs.length < 2) return undefined;
  const [legA, legB] = decomposition.legs;
  if (legA === undefined || legB === undefined) return undefined;
  return {
    originalQuery: analysis.preservedSurface,
    intent: 'compare',
    legs: [legA, legB],
    ...(analysis.normalizedConstraints.length > 0
      ? { sharedFilters: [...analysis.normalizedConstraints] }
      : {}),
  };
}

/**
 * Expand a parallel-slot decomposition into N `SearchUseCaseInput` entries.
 * Each slot inherits the analysis filters, adds a `wine_type` filter from
 * the slot, and (if a total budget is present) gets an equal share.
 *
 * see: src/application/agent/agent-tool-execution-policy.ts:754
 * (buildSlotSearchInput) for the full per-slot input pipeline — query
 * anchor rewriting, occasion normalization, opposite-color stripping.
 */
function expandParallelSlots(
  analysis: WineSearchAnalysis,
  decomposition: Extract<Decomposition, { kind: 'parallel-slot' }>,
): { readonly searches: SearchUseCaseInput[] } {
  const slotCount = decomposition.slots.length;
  const totalBudgetKrw = extractPriceBudgetKrw(analysis.normalizedConstraints);
  const perSlotBudgetKrw = splitTotalBudgetAcrossSlots(totalBudgetKrw, slotCount);

  const baseFilters = analysis.normalizedConstraints.filter(
    (c) => !PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has(c.attribute),
  );

  const searches: SearchUseCaseInput[] = decomposition.slots.map((slot) => {
    const slotFilters: NormalizedConstraint[] = [
      ...baseFilters,
      {
        attribute: 'wine_type',
        operator: '=',
        value: slot.wineType,
        source_phrase: slot.wineType,
        confidence: 1.0,
      },
      ...(perSlotBudgetKrw !== undefined
        ? [{
          attribute: 'max_price_krw',
          operator: '<=' as const,
          value: perSlotBudgetKrw,
          source_phrase: `${perSlotBudgetKrw}원 이하 (per slot)`,
          confidence: 1.0,
        }]
        : []),
    ];
    return {
      query: analysis.preservedSurface,
      filters: slotFilters,
      ...(slot.limit !== undefined ? { limit: slot.limit } : {}),
    };
  });

  return { searches };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

interface DeterministicRouterDeps {
  /** Wall-clock for resolving drinkability target year. Optional so tests
   *  can pin determinism without monkey-patching globals. */
  readonly now?: () => Date;
}

export class DeterministicRouter {
  private readonly now: () => Date;

  constructor(deps?: DeterministicRouterDeps) {
    this.now = deps?.now ?? (() => new Date());
  }

  route(analysis: WineSearchAnalysis): ExecutionPlan {
    // Rule 1 — analysis-rejected guard. We don't reject "intent=unknown
    // with anchors" because the deterministic anchor extractor may still
    // yield a valid query (e.g. just "Opus One"). We also DO NOT reject
    // when the preserved surface contains a top-level wine-domain keyword
    // (와인 / wine / 포도주 / 소믈리에 / …) — see WINE_DOMAIN_KEYWORD_RE
    // for the rationale (CLAUDE.md rule 23 — false-positive guard for
    // unsupported_intent on benign conversational queries).
    if (
      analysis.intent === 'unknown'
      && analysis.anchors.length === 0
      && analysis.normalizedConstraints.length === 0
      && !WINE_DOMAIN_KEYWORD_RE.test(analysis.preservedSurface)
    ) {
      return { kind: PLAN_KIND_REJECT, reason: 'unsupported_intent' };
    }

    // Rule 2 — comparison decomposition.
    if (isComparisonDecomposition(analysis.decomposition)) {
      const comparisonInput = buildComparisonInputFromAnalysis(
        analysis,
        analysis.decomposition,
      );
      if (comparisonInput !== undefined) {
        return { kind: PLAN_KIND_COMPARISON, comparisonInput };
      }
    }

    // Rule 3 — parallel-slot decomposition.
    if (isParallelSlotDecomposition(analysis.decomposition)) {
      const { searches } = expandParallelSlots(analysis, analysis.decomposition);
      if (searches.length >= 2) {
        return {
          kind: PLAN_KIND_PARALLEL_SEARCH,
          searches,
          slotHints: analysis.decomposition.slots,
        };
      }
    }

    // Rule 4 — food-pairing.
    if (
      analysis.contract.requiredTool === 'get_food_pairings'
      && analysis.intent === 'pair'
    ) {
      const pairingInput = buildFoodPairingInputFromAnalysis(analysis);
      const baseSearch = buildSearchInputFromAnalysis(analysis);
      const mergedSearch = mergePairingTagsIntoSearchInput(baseSearch, pairingInput);
      if (hasPriceConstraint(analysis.normalizedConstraints)) {
        return {
          kind: PLAN_KIND_FOOD_PAIRING_THEN_SEARCH,
          pairingInput,
          searchInput: mergedSearch,
        };
      }
      // No budget signal — single-search lane carries the merged pairing
      // filters/preferences directly.
      return { kind: PLAN_KIND_SINGLE_SEARCH, searchInput: mergedSearch };
    }

    // Rule 5 — drinkability on an anchored entity.
    if (
      analysis.contract.requiresDrinkabilityCheck
      && analysis.anchors.length > 0
    ) {
      const searchInput = buildSearchInputFromAnalysis(analysis);
      const targetYear = this.resolveDrinkabilityTargetYear(analysis);
      const maxAnchors = Math.min(
        analysis.anchors.length,
        DETERMINISTIC_ROUTER_MAX_DRINKABILITY_ANCHORS,
      );
      return {
        kind: PLAN_KIND_SEARCH_THEN_DRINKABILITY,
        searchInput,
        drinkabilityTemplate: {
          targetYear,
          maxAnchors,
        },
      };
    }

    // Rule 6 — multi-step (defer to MiniLoop).
    if (analysis.expectedMultiStep) {
      return {
        kind: PLAN_KIND_MULTI_STEP,
        handoff: this.buildMultiStepHandoff(analysis),
      };
    }

    // Rule 7 — single-search (the 80% path).
    return {
      kind: PLAN_KIND_SINGLE_SEARCH,
      searchInput: buildSearchInputFromAnalysis(analysis),
    };
  }

  private resolveDrinkabilityTargetYear(
    analysis: WineSearchAnalysis,
  ): number {
    // exact-metadata vintage takes precedence — "Opus One 2018 지금 마실
    // 만한가" should anchor on now, not 2018.
    const nowYear = this.now().getFullYear() + DRINKABILITY_DEFAULT_TARGET_YEAR_OFFSET;
    if (analysis.contract.exactMetadataTargetVintage !== undefined) {
      // The user named a specific vintage but asked about *current*
      // drinkability — target year is "now", the vintage flows into the
      // search filter, not the drinkability template.
      return nowYear;
    }
    return nowYear;
  }

  private buildMultiStepHandoff(
    analysis: WineSearchAnalysis,
  ): Extract<ExecutionPlan, { kind: 'multi-step' }>['handoff'] {
    const initialAction = MULTI_STEP_INITIAL_ACTION_BY_INTENT.get(analysis.intent)
      ?? 'search';
    const seedSearchInput = buildSearchInputFromAnalysis(analysis);
    const budget: RecommendedBudget = analysis.recommendedBudget;
    const contract: AnalysisContract = analysis.contract;
    return {
      initialAction,
      budget,
      contract,
      seedSearchInput,
    };
  }
}
