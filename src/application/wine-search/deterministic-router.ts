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
 *  2. decomposition.kind=parallel-slot → parallel-search plan (one search
 *     per slot, total budget split if present).
 *  3. expectedMultiStep=true (none of the above) → multi-step handoff.
 *  4. fallback → single-search plan (80% happy path).
 *
 * NOTE: context-dependent input normalization is delegated to
 * `tool-input-normalizer.ts`, which is now the single owner for exact-metadata
 * stripping, drinkability query cleanup, default constraint merge, and
 * per-slot parallel-search sanitization.
 */

import {
  EXECUTION_PLAN_KINDS,
  type ExecutionPlan,
  type ExecutionPlanKind,
  type SearchUseCaseInput,
} from './execution-plan-schemas.js';
import type {
  AnalysisContract,
  Decomposition,
  RecommendedBudget,
  WineSearchAnalysis,
} from './wine-search-schemas.js';
import {
  getCanonicalNormalizedConstraints,
} from './wine-search-schemas.js';
import { DefaultToolInputNormalizer } from './tool-input-normalizer.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

// Input-normalization policy now lives in `tool-input-normalizer.ts`. The
// router owns only plan-shape branching and delegates all context-dependent
// search-input mutation to that single authority surface.

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
const PLAN_KIND_MULTI_STEP = EXECUTION_PLAN_KINDS[2];
const PLAN_KIND_REJECT = EXECUTION_PLAN_KINDS[3];

// Compile-time membership guard — each local must be a member of the
// `ExecutionPlanKind` SSoT union. Catches an out-of-bounds tuple index
// silently producing `undefined` (e.g. if a kind is removed from the
// tuple). The `satisfies` clause forces TS to verify membership without
// widening the literal types of the locals.
void ({
  PLAN_KIND_SINGLE_SEARCH,
  PLAN_KIND_PARALLEL_SEARCH,
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

function isParallelSlotDecomposition(
  decomposition: Decomposition | undefined,
): decomposition is Extract<Decomposition, { kind: 'parallel-slot' }> {
  return decomposition !== undefined && decomposition.kind === 'parallel-slot';
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
 *   2. Explicit user-facing result cap
 *      (`requestedResultLimit`, e.g. "탑3", "top 5"). This is a stronger
 *      product intent than the adaptive retrieval default.
 *   3. Analyzer-emitted adaptive retrieval k
 *      (`recommendedBudget.retrievalK`, SSoT `RETRIEVAL_K_BY_INTENT`). This
 *      varies the pool size per intent class (entity_lookup=20, …,
 *      exploratory=500). See `adaptive-budget.ts` for the rationale.
 *   4. No limit field — downstream use case applies its own default.
 *      Retained for backwards compat with fixtures that omit `retrievalK`
 *      from `recommendedBudget`.
 */
function buildSearchInputFromAnalysis(
  analysis: WineSearchAnalysis,
): SearchUseCaseInput {
  const requestedResultLimit = analysis.requestedResultLimit;
  const adaptiveK = analysis.recommendedBudget.retrievalK;
  const baseInput: SearchUseCaseInput = {
    query: analysis.preservedSurface,
    ...(analysis.contract.hasEntityMetadataSignal ? { mode: 'entity' as const } : {}),
    ...(requestedResultLimit !== undefined
      ? { limit: requestedResultLimit }
      : adaptiveK !== undefined
        ? { limit: adaptiveK }
        : {}),
    ...(analysis.callerInterpretation !== undefined
      ? { callerInterpretation: analysis.callerInterpretation }
      : {}),
  };
  return DefaultToolInputNormalizer.normalizeSearchInput(baseInput, analysis);
}

function getAllAnalysisConstraints(
  analysis: WineSearchAnalysis,
): ReturnType<typeof getCanonicalNormalizedConstraints> {
  return getCanonicalNormalizedConstraints(analysis);
}

/**
 * Expand a parallel-slot decomposition into N `SearchUseCaseInput` entries.
 * Each slot inherits the normalized base input, then the normalizer rewrites
 * the query, preserves only per-slot-safe occasion filters, injects the
 * slot `wine_type`, and splits any total budget from the analysis.
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
  const baseInput = DefaultToolInputNormalizer.normalizeSearchInput(
    {
      query: analysis.preservedSurface,
      ...(analysis.callerInterpretation !== undefined
        ? { callerInterpretation: analysis.callerInterpretation }
        : {}),
    },
    analysis,
  );

  const searches: SearchUseCaseInput[] = decomposition.slots.map((slot) => {
    return DefaultToolInputNormalizer.normalizeParallelSlotInput(baseInput, analysis, slot, slotCount);
  });

  return { searches };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

interface DeterministicRouterDeps {
  /** Optional wall-clock — unused since step 4-3 removed the drinkability
   *  plan kind (the only time-dependent rule). Retained on the deps shape
   *  for caller backward compatibility; future rules may consume it. */
  readonly now?: () => Date;
}

export class DeterministicRouter {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_deps?: DeterministicRouterDeps) {
    // No instance state — the router is currently a pure function dressed
    // up as a class so DI callers can swap implementations. The optional
    // deps shape (currently empty after step 4-3) is retained so existing
    // call sites do not need to be touched.
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
      && getAllAnalysisConstraints(analysis).length === 0
      && !WINE_DOMAIN_KEYWORD_RE.test(analysis.preservedSurface)
    ) {
      return { kind: PLAN_KIND_REJECT, reason: 'unsupported_intent' };
    }

    // Rule 2 — parallel-slot decomposition.
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

    // Rule 3 — multi-step (defer to MiniLoop).
    if (analysis.expectedMultiStep) {
      return {
        kind: PLAN_KIND_MULTI_STEP,
        handoff: this.buildMultiStepHandoff(analysis),
      };
    }

    // Rule 4 — single-search (the 80% path).
    return {
      kind: PLAN_KIND_SINGLE_SEARCH,
      searchInput: buildSearchInputFromAnalysis(analysis),
    };
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
