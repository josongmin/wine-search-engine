import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type {
  AmbiguousEntityHint,
  AmbiguousEntityHintBranch,
} from '../../domain/attribute/model/ambiguous-entity-hint.js';
import type {
  ExecutionRetrievalMode,
  ProvenanceCoverageStage,
} from '../../domain/query/model/engine-execution-contract.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import type {
  BudgetResource,
  ConstraintGraph,
  SlotNode,
  SubqueryNode,
} from '../../domain/query/model/constraint-graph.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
} from './port/search-pipeline-deps.port.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { SpecializedFallbackReason } from './specialized-fallback-reason.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';
import {
  executeRetrievalBranches,
  formatRetrievalBranchFailureReasons,
} from './retrieval-branch-execution.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import {
  buildHybridCandidateCoverageStage,
  buildMissingProvenanceObligations,
} from './search-usecase-provenance-closure.js';
import {
  executeGraphAware,
  executeCandidatePoolRetrieval,
  type CriticSignalProbe,
  type GraphExecutorOptions,
  type SubqueryRetrievalResult,
} from './search-usecase-graph-executor.js';
import {
  BundleSelectorImpl,
  type BundleCellPricer,
  type BundleCellScorer,
} from '../../domain/retrieval/service/bundle-selector.js';
import { InMemoryBudgetLedger } from '../../domain/retrieval/service/budget-ledger.js';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import { createQueryRewriter } from '../../domain/retrieval/service/query-rewriter.js';
import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import type {
  IntentClass,
  MultiQueryGenerator,
} from '../../domain/retrieval/service/multi-query-generator.js';
import type { HydeGenerator } from '../../domain/retrieval/service/hyde-generator.js';
import {
  expandSemanticQueriesForFanout,
  mergeFanoutWithExisting,
} from './multi-query-retrieval-fanout.js';
import type { DecisionInputCriticRewrite } from '../../domain/decision/model/decision-input.js';
import type { RewriteTrace } from '../../domain/retrieval/service/query-rewriter.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
} from '../../domain/observability/graph-path-telemetry.js';
import { collectApplicableSlotIdsForSubquery } from '../../domain/query/service/subquery-slot-scope.js';
import {
  collectConjunctivelyRequiredSlotIds,
  projectConstraintGraphForSubquery,
} from '../../domain/query/service/project-subquery-constraint-graph.js';
import {
  expandSemanticStyleRetrievalTerms,
  resolveSemanticStyleEvidenceProfile,
} from '../../domain/query/service/semantic-style-query-terms.js';
import { recipientProfileToRetrievalTerms } from '../../domain/query/service/recipient-situation-profile.js';
import type { WineTypeValue } from '../../domain/query/model/wine-type-patterns.js';
import { SEARCH_TOOL_DIVERSITY_WINE_TYPES } from './search-tool-diversity.js';

/**
 * ADR-015 Axis 2: per-call critic context surfaced from
 * `retrieveHybridCandidatesForPlan` so callers can thread the rewrite
 * trace into `buildSearchDecisionInput.executionContext.criticRewrites`.
 */
export interface CriticRetrievalObservability {
  readonly rewrites: readonly RewriteTrace[];
  readonly retriesExhausted: boolean;
  readonly degradationReasons: readonly string[];
}

/** Convert a critic rewrite trace into the projection the decision-input
 *  contract carries downstream. */
export function projectRewritesForDecisionInput(
  rewrites: readonly RewriteTrace[],
): readonly DecisionInputCriticRewrite[] {
  return rewrites.map((trace, index) => ({
    subqueryId: trace.subqueryId,
    type: trace.rewriteType,
    // Stable ref: monotonic per-request index so the response builder
    // can cross-reference the rewrite without reading internal pointers.
    rewriteTraceRef: `critic-rewrite-${index}`,
  }));
}

/** Cap for producer/region/compare specialized hybrid retrieval. */
export const SPECIALIZED_HYBRID_RETRIEVAL_LIMIT = 20;
const TYPED_RECOMMENDATION_DISCOVERY_VERSION = 'typed_recommendation_discovery_v1';

/**
 * Feature flag — enable Multi-Query Rewrite + HyDE pre-retrieval fan-out.
 *
 * Read at module load (process.env) so toggling requires a process
 * restart.
 *
 * Wave 2: DEFAULT ON. Only an explicit
 * `WINE_SEARCH_MULTI_QUERY_ENABLED=false` opt-out disables the
 * fan-out. Any other value (unset / `'true'` / typo) is treated as
 * ENABLED so misconfiguration does not silently regress recall. Must
 * stay in sync with the same flag read in `src/config/container.ts`.
 */
const MULTI_QUERY_FANOUT_ENABLED =
  process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'] !== 'false';

/**
 * Map the planner's `QueryClass` + the compiled `effectiveRetrievalMode`
 * to a Multi-Query intent class. This is the gating signal: only
 * `food_pairing`, `exploratory`, `attribute_search` benefit from
 * multi-query / HyDE — exact-match identity paths must NOT get rewritten
 * (would dilute precision) and comparative paths use the specialized
 * compare retriever which doesn't read semanticQueries at all.
 */
function classifyIntentForMultiQueryFanout(
  plan: QueryPlanV1,
  effectiveRetrievalMode: ExecutionRetrievalMode,
): IntentClass {
  // Comparative path — the specialized compare_candidates retriever
  // returns above this point; if we reach the generic path with
  // queryClass=comparison_query, fan-out is still wrong (the user is
  // asking "A vs B" — rewriting either side changes the question).
  if (
    effectiveRetrievalMode === 'compare_candidates'
    || plan.queryClass === 'comparison_query'
  ) {
    return 'comparative';
  }

  // Entity-lookup family — anchored or exact-form queries. Rewriting
  // dilutes the entity-specific signal.
  if (
    plan.queryClass === 'exact_entity'
    || plan.queryClass === 'short_entity'
    || plan.queryClass === 'anchored_similarity'
    || plan.queryClass === 'ambiguous_short_form'
  ) {
    return 'entity_lookup';
  }

  // Food-pairing — detected by any pairing constraint surfaced in the
  // plan (rule-based or LLM-mapped). Pairing queries benefit most from
  // HyDE because the user's food vocabulary rarely matches catalog
  // tasting notes verbatim.
  const allConstraints = [
    ...plan.constraints.hard,
    ...plan.constraints.soft,
    ...plan.constraints.inferred,
  ];
  if (allConstraints.some((c) => c.attribute === 'pairing')) {
    return 'food_pairing';
  }

  // Exploratory — natural-language preference queries.
  if (plan.queryClass === 'semantic_preference') {
    return 'exploratory';
  }

  // Everything else (pure_constraint, unknown) — attribute search.
  return 'attribute_search';
}

/**
 * Run Multi-Query + HyDE fan-out and rewrite the
 * `HybridRetrievalInput.semanticQueries` / `semanticEmbeddingQueries`
 * accordingly. Returns the input unchanged when the feature flag is
 * OFF, generators are not wired, or the intent is gated out.
 *
 * Never throws — both generators degrade to no-ops on LLM failure.
 */
async function maybeExpandSemanticQueriesForFanout(
  input: HybridRetrievalInput,
  ports: HybridCandidateRetrievalPorts,
  intent: IntentClass,
): Promise<HybridRetrievalInput> {
  if (!MULTI_QUERY_FANOUT_ENABLED) return input;
  if (
    ports.multiQueryGenerator === undefined
    && ports.hydeGenerator === undefined
  ) {
    return input;
  }
  // Use the rawQuery (user-facing) as the LLM input, NOT the
  // normalized form — the LLM benefits from the original phrasing,
  // capitalisation, language markers, and punctuation when generating
  // rewrites or a hypothetical document.
  const queryForLlm = input.queryPlan.rawQuery;
  if (typeof queryForLlm !== 'string' || queryForLlm.trim().length === 0) {
    return input;
  }

  // Parallelise the two LLM calls — they're independent. Either failure
  // degrades to a no-op for that generator (see generator impls).
  const [rewriteResult, hydeResult] = await Promise.all([
    ports.multiQueryGenerator !== undefined
      ? ports.multiQueryGenerator.generate(queryForLlm, intent)
      : Promise.resolve([queryForLlm] as readonly string[]),
    ports.hydeGenerator !== undefined
      ? ports.hydeGenerator.generate(queryForLlm, intent)
      : Promise.resolve(null),
  ]);

  // Rewrites already include the original as element 0; drop it so we
  // don't duplicate when merging with existing semantic queries.
  const rewritesWithoutOriginal = rewriteResult.slice(1);

  const fanout = expandSemanticQueriesForFanout({
    query: queryForLlm,
    rewrites: rewritesWithoutOriginal,
    hydeDocument: hydeResult,
  });

  if (fanout.semanticQueries.length === 0) {
    return input;
  }

  // Merge fanout output with the planner's existing semantic / lexical
  // queries (which carry structured constraint expansions). The
  // semantic-side gets all fanout entries; the lexical-side gets ONLY
  // the rewrites (not the HyDE doc — it's a paragraph, not a lexical
  // BM25 term).
  const fanoutForLexical: readonly string[] = rewritesWithoutOriginal;

  const mergedSemantic = mergeFanoutWithExisting(
    fanout.semanticQueries,
    input.semanticQueries,
  );
  const mergedSemanticEmbedding = mergeFanoutWithExisting(
    fanout.semanticQueries,
    input.semanticEmbeddingQueries ?? input.semanticQueries,
  );
  const mergedLexical = fanoutForLexical.length > 0
    ? mergeFanoutWithExisting(fanoutForLexical, input.lexicalQueries)
    : input.lexicalQueries;

  return {
    ...input,
    semanticQueries: mergedSemantic,
    semanticEmbeddingQueries: mergedSemanticEmbedding,
    lexicalQueries: mergedLexical,
  };
}

export function extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Tiebreak by surfaceForm for deterministic anchor selection when confidence is equal.
  // Without a tiebreaker, equal-confidence anchors produce different producer_browse seeds
  // across identical queries (JS sort is not stable across all V8 versions for equal keys).
  const strongestAnchor = [...plan.anchors].sort((left, right) => {
    const diff = right.confidence - left.confidence;
    // Locale-independent byte comparison for deterministic cross-system ordering.
    // localeCompare() produces different results across Node versions / OS locales.
    return diff !== 0 ? diff : left.surfaceForm < right.surfaceForm ? -1 : left.surfaceForm > right.surfaceForm ? 1 : 0;
  })[0];
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string from trim() should fall through to normalizedForm
  const candidate = strongestAnchor?.surfaceForm.trim() || strongestAnchor?.normalizedForm.trim();
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function extractRegionBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Primary: explicit region/appellation/country constraint — most reliable signal.
  const regionConstraint = [...plan.constraints.hard, ...plan.constraints.soft, ...plan.constraints.inferred].find(
    (constraint) =>
      constraint.attribute === 'region' ||
      constraint.attribute === 'appellation' ||
      constraint.attribute === 'country',
  );

  if (regionConstraint !== undefined) {
    if (typeof regionConstraint.value === 'string' && regionConstraint.value.trim().length > 0) {
      return regionConstraint.value.trim();
    }
    if (isReadonlyStringArray(regionConstraint.value) && regionConstraint.value.length > 0) {
      return regionConstraint.value[0];
    }
  }

  // Secondary: hierarchical slash-notation queries (e.g. "Burgundy / Pinot Noir").
  // Only treat as a region seed when the query is clearly structured this way.
  const hierarchy = plan.normalizedQuery
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (hierarchy.length >= 2) {
    return hierarchy.join(' / ');
  }

  // No reliable region signal — return undefined rather than guessing from
  // the full query text. A false seed produces a wrong region_browse execution.
  return undefined;
}

export interface HybridCandidateRetrievalPorts {
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
  /**
   * ADR-015 Axis 2: optional ChatLlmPort for the critic's `reformulate`
   * branch. When absent, `reformulate` rewrites decline gracefully and
   * the retry loop falls through to retries-exhausted. The deterministic
   * branches (`relax` / `decompose` / `expand_synonym`) work without it.
   */
  readonly chatLlm?: ChatLlmPort | undefined;
  /**
   * Multi-Query Rewrite generator — pre-retrieval LLM fan-out of the
   * semantic query into N variants. Gated by the
   * `WINE_SEARCH_MULTI_QUERY_ENABLED` env flag (Wave 2: DEFAULT ON;
   * explicit `=false` to disable). When the flag is OFF, the generator
   * is never invoked even when wired. See `multi-query-generator.ts`.
   */
  readonly multiQueryGenerator?: MultiQueryGenerator | undefined;
  /**
   * HyDE (Hypothetical Document Embeddings) generator — produces a
   * hypothetical wine description that an ideal matching catalog entry
   * would carry. Gated by the same `WINE_SEARCH_MULTI_QUERY_ENABLED`
   * flag and the same intent filter as multi-query. Used for
   * attribute/exploratory/food-pairing intents only.
   */
  readonly hydeGenerator?: HydeGenerator | undefined;
}

export interface HybridCandidateRetrievalResult {
  readonly candidates: readonly HybridCandidate[];
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: 'generic_hybrid' | 'specialized_hybrid';
  readonly sparseExecuted: boolean;
  readonly usedCompiledExecution: boolean;
  readonly retrievalProvenanceCoverage?: ProvenanceCoverageStage | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  /** E4: RRF fusion trace from CandidatePoolService.getLastFusionTrace(). Present only
   *  when the generic hybrid path (candidatePool.execute) was used — absent for
   *  specialized browse/compare paths that bypass RRF fusion. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from CandidatePoolService.getLastDropLog(). */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /**
   * ADR-015 Axis 2: trace of executor-internal critic rewrites that
   * occurred during the generic hybrid retrieval. Only populated when
   * the `RETRIEVAL_EXECUTOR_CRITIC` flag is on AND the generic hybrid
   * path executed (specialized browse/compare paths bypass the critic
   * loop). Empty array when the flag is on but no retry was needed.
   */
  readonly criticObservability?: CriticRetrievalObservability | undefined;
}

function mergeRetrievalDegradation(
  reasons: ReadonlySet<SpecializedFallbackReason>,
  provenanceShortfall: readonly string[],
  retrievalInternalReasons: readonly string[] = [],
): RankingDegradationSignal | undefined {
  const degradationReasons = [
    ...reasons,
    ...provenanceShortfall.map((obligation) => `retrieval_provenance_shortfall:${obligation}`),
    ...retrievalInternalReasons,
  ];
  if (degradationReasons.length === 0) {
    return undefined;
  }
  return {
    executionMode: 'degraded',
    degradationReasons,
  };
}

/**
 * Bugbash 2026-04-14: translate structured retrieval degradation signals from
 * CandidatePoolService into opaque wire-contract strings. The HTTP response
 * carries these in `meta.degradation_reasons` so operators can distinguish
 * "sparse channel failed" from "dense channel failed" from "anchor missing"
 * without reaching into the decision trace.
 */
function retrievalSignalsToReasons(
  signals: readonly { readonly component: string; readonly reason: string }[],
): readonly string[] {
  return signals.map((signal) => `retrieval_degraded:${signal.component}:${signal.reason}`);
}

function buildRetrievalCoverage(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  candidates: readonly HybridCandidate[],
): ProvenanceCoverageStage {
  // Wave G2: emit `pre_rank_coverage` telemetry BEFORE delegating to
  // `buildHybridCandidateCoverageStage` (which would otherwise double-count
  // under `provenance_closure`). The stage builder's own emission is still
  // semantically correct — it records every call-site it was invoked from,
  // including the ranked-result post-phase — so the two readers distinguish
  // pre-rank (specialized + generic retrieval) vs post-rank provenance.
  recordGraphPathDecision({
    reader: 'pre_rank_coverage',
    outcome: classifyGraphPresence({
      graphPresent: compiled.constraintGraph !== undefined,
      ...(compiled.constraintGraph !== undefined
        ? { graphOrigin: compiled.constraintGraph.origin }
        : {}),
      graphEmitFlagOn: process.env['CONSTRAINT_GRAPH_EMIT'] !== 'false',
    }),
  });
  // ADR-011 Phase 1b.3a: thread `compiled.constraintGraph` so specialized +
  // generic pre-rank coverage uses the same graph-aware AND/OR/XOR semantics
  // that ADR-011 Phase 1b.1 landed for `provenance-closure`. Flat path is
  // byte-identical when the graph is absent.
  return buildHybridCandidateCoverageStage(
    plan,
    candidates,
    compiled.execution.provenancePolicy,
    compiled.constraintGraph,
  );
}

export function buildHybridRetrievalInputForPlan(
  plan: QueryPlanV1,
  route: HybridRetrievalInput['route'] = 'hybrid',
  anchorEntityId?: CanonicalEntityId,
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
): HybridRetrievalInput {
  const retrievalPlan = compiled?.query.retrievalPlan ?? buildRetrievalPlan(plan.constraints);
  const retrievalObjective = compiled?.query.retrievalObjective ?? buildRetrievalObjective(plan.constraints);
  const structuredQueries = buildStructuredQueryExpansions(plan, retrievalPlan);
  const ambiguitySoftConstraints = buildAmbiguousEntityHintSoftConstraints(plan.expansions.ambiguousEntityHints);
  // TA4: Propagate fuzzy entity hypothesis terms from the planner into the retrieval
  // input. When the planner's fuzzy matcher fires on an anchor-miss query, these terms
  // are entity hypothesis seeds that enable the entity-first dual retrieval path.
  const fuzzyEntityHypotheses = plan.expansions.fuzzyEntityHypotheses;
  return {
    queryPlan: plan,
    route,
    ...(compiled !== undefined ? { compiledRetrievalMode: compiled.execution.effectiveRetrievalMode } : {}),
    ...(compiled !== undefined
      ? { executionBudgetMaxCandidates: compiled.execution.budget.maxCandidates }
      : {}),
    lexicalQueries: buildPlanLexicalQueryVariants(plan, structuredQueries.lexical),
    semanticQueries: buildPlanSemanticQueryVariants(plan, structuredQueries.semantic),
    semanticEmbeddingQueries: buildPlanSemanticEmbeddingQueryVariants(plan, structuredQueries.semantic),
    hardConstraints: plan.constraints.hard,
    softConstraints: [
      ...plan.constraints.soft,
      ...ambiguitySoftConstraints,
    ],
    retrievalPlan,
    retrievalObjective,
    // ADR-014 Phase 1b.3b: propagate the compiled constraint graph so
    // candidate-pool's annotator can emit per-atom slot records.
    ...(compiled?.constraintGraph !== undefined
      ? { constraintGraph: compiled.constraintGraph }
      : {}),
    ...(anchorEntityId !== undefined ? { anchorEntityId } : {}),
    ...(requestContext !== undefined ? { requestContext } : {}),
    ...(fuzzyEntityHypotheses != null && fuzzyEntityHypotheses.length > 0
      ? { entityHypothesisTerms: fuzzyEntityHypotheses }
      : {}),
  };
}

function buildStructuredQueryExpansions(
  plan: QueryPlanV1,
  retrievalPlan: ReturnType<typeof buildRetrievalPlan>,
): {
  readonly lexical: readonly string[];
  readonly semantic: readonly string[];
} {
  const lexical: string[] = [];
  const semantic: string[] = [];
  const wineTypeContext = resolveWineTypeContextFromConstraints(plan.constraints.hard);
  for (const constraint of plan.constraints.hard) {
    const phrases = retrievalValueToPhrases(constraint.attribute, constraint.value, wineTypeContext);
    if (phrases.length > 0) {
      lexical.push(...phrases);
      if (isSemanticRetrievalExpansionAttribute(constraint.attribute)) {
        semantic.push(...phrases);
      }
    }
  }
  for (const boost of [...retrievalPlan.softBoosts, ...retrievalPlan.inferredBoosts]) {
    const phrases = retrievalValueToPhrases(boost.attribute, boost.value, wineTypeContext);
    if (phrases.length === 0) {
      continue;
    }
    lexical.push(...phrases);
    if (isSemanticRetrievalExpansionAttribute(boost.attribute)) {
      semantic.push(...phrases);
    }
  }
  for (const hint of plan.expansions.ambiguousEntityHints ?? []) {
    lexical.push(...hint.lexicalExpansions);
    semantic.push(...hint.semanticExpansions);
  }
  return { lexical: uniqueStrings(lexical), semantic: uniqueStrings(semantic) };
}

function buildAmbiguousEntityHintSoftConstraints(
  hints: readonly AmbiguousEntityHint[] | undefined,
): readonly NormalizedConstraint[] {
  if (hints === undefined || hints.length === 0) {
    return [];
  }

  return hints.map((hint) => ({
    attribute: hint.retrievalConstraint.attribute,
    operator: hint.retrievalConstraint.operator,
    value: hint.retrievalConstraint.value,
    source_phrase: `ambiguous_entity_hint(${hint.surface})`,
    confidence: 0.7,
    mapping_version: 'ambiguous-entity-hint-v1',
  }));
}

function isWineTypeValue(value: unknown): value is WineTypeValue {
  return value === 'red'
    || value === 'white'
    || value === 'rosé'
    || value === 'sparkling'
    || value === 'natural'
    || value === 'dessert'
    || value === 'fortified'
    || value === 'orange';
}

function resolveWineTypeContextFromConstraints(
  constraints: readonly QueryPlanV1['constraints']['hard'][number][],
): WineTypeValue | undefined {
  for (const constraint of constraints) {
    if (constraint.attribute !== 'wine_type') continue;
    if (typeof constraint.value === 'string' && isWineTypeValue(constraint.value)) {
      return constraint.value;
    }
    if (Array.isArray(constraint.value)) {
      const matched = constraint.value.find(isWineTypeValue);
      if (matched !== undefined) {
        return matched;
      }
    }
  }
  return undefined;
}

function isSemanticRetrievalExpansionAttribute(attribute: string): boolean {
  return attribute === 'region'
    || attribute === 'country'
    || attribute === 'appellation'
    || attribute === 'closure'
    || attribute === 'grape_family'
    || attribute === 'grape_primary'
    || attribute === 'style'
    || attribute === 'flavor_profile'
    || attribute === 'certification'
    || attribute === 'pairing'
    || attribute === 'occasion'
    || attribute === 'recipient_profile';
}

function retrievalValueToPhrases(
  attribute: string,
  value: unknown,
  wineTypeContext?: WineTypeValue,
): readonly string[] {
  if (
    attribute === 'gift_suitability'
    || attribute === 'beginner_suitability'
    || attribute === 'drinking_window'
  ) {
    return [];
  }

  if (attribute === 'recipient_profile') {
    if (typeof value === 'string') {
      return recipientProfileToRetrievalTerms(value);
    }
    if (Array.isArray(value)) {
      return [
        ...new Set(
          value
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .flatMap((entry) => recipientProfileToRetrievalTerms(entry)),
        ),
      ];
    }
  }

  if (attribute === 'style') {
    if (typeof value === 'string') {
      return expandSemanticStyleRetrievalTerms({ style: value, wineType: wineTypeContext });
    }
    if (Array.isArray(value)) {
      return expandSemanticStyleRetrievalTerms({
        styles: value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
        wineType: wineTypeContext,
      });
    }
  }

  const phrase = retrievalValueToPhrase(value);
  return phrase !== undefined ? [phrase] : [];
}

function retrievalValueToPhrase(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : undefined;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'min' in value
    && 'max' in value
  ) {
    const min = typeof value.min === 'number' ? value.min.toString() : undefined;
    const max = typeof value.max === 'number' ? value.max.toString() : undefined;
    return [min, max].filter((entry): entry is string => entry !== undefined).join(' ');
  }
  return undefined;
}

function constraintValueToStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  return [];
}

function hasExplicitWineTypeConstraint(
  constraints: readonly QueryPlanV1['constraints']['hard'][number][],
): boolean {
  return resolveWineTypeContextFromConstraints(constraints) !== undefined;
}

function hasGiftOccasionPreference(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...plan.constraints.inferred].some((constraint) =>
    constraint.attribute === 'occasion'
    && constraintValueToStrings(constraint.value)
      .some((value) => value.trim().toLowerCase() === 'gift'),
  );
}

function hasRecommendationSemanticStylePreference(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...plan.constraints.inferred].some((constraint) =>
    constraint.attribute === 'style'
    && constraintValueToStrings(constraint.value)
      .some((value) => resolveSemanticStyleEvidenceProfile(value.trim().toLowerCase()) !== undefined),
  );
}

function hasClosurePreference(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...plan.constraints.inferred].some((constraint) =>
    constraint.attribute === 'closure',
  );
}

function shouldRunTypedRecommendationDiscovery(plan: QueryPlanV1): boolean {
  if (hasExplicitWineTypeConstraint(plan.constraints.hard)) {
    return false;
  }
  return hasGiftOccasionPreference(plan) || hasRecommendationSemanticStylePreference(plan) || hasClosurePreference(plan);
}

function shouldRunAmbiguousEntityBranchExploration(plan: QueryPlanV1): boolean {
  return plan.expansions.ambiguousEntityHints?.some((hint) => hint.explorationBranches.length > 0) ?? false;
}

function hasHybridSubqueryTopology(graph: ConstraintGraph | undefined): boolean {
  return graph !== undefined
    && graph.origin === 'hybrid'
    && graph.nodes.some((node) => node.kind === 'subquery');
}

function buildTypedRecommendationPlan(
  plan: QueryPlanV1,
  wineType: WineTypeValue,
): QueryPlanV1 {
  return {
    ...plan,
    constraints: {
      ...plan.constraints,
      hard: [
        ...plan.constraints.hard.filter((constraint) => constraint.attribute !== 'wine_type'),
        {
          attribute: 'wine_type',
          operator: '=',
          value: wineType,
          source_phrase: wineType,
          confidence: 1,
          mapping_version: TYPED_RECOMMENDATION_DISCOVERY_VERSION,
        },
      ],
    },
  };
}

function buildTypedRecommendationRetrievalInput(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  requestContext: RequestExecutionContext | undefined,
  anchorEntityId: CanonicalEntityId | undefined,
): HybridRetrievalInput {
  const typedInput = buildHybridRetrievalInputForPlan(
    plan,
    'hybrid',
    anchorEntityId,
    undefined,
    requestContext,
  );
  return {
    ...typedInput,
    compiledRetrievalMode: compiled.execution.effectiveRetrievalMode,
    executionBudgetMaxCandidates: compiled.execution.budget.maxCandidates,
  };
}

function candidateDiscoveryScore(candidate: HybridCandidate): number {
  return candidate.fusionRrfTotal ?? 0;
}

interface BranchCandidateSet {
  readonly branchLabel: string;
  readonly candidates: readonly HybridCandidate[];
}

interface BranchCandidateRetrievalResult {
  readonly status: 'ok' | 'fail_closed';
  readonly candidates: readonly HybridCandidate[];
  readonly degradationSignals: RankingDegradationSignal['degradationReasons'];
  readonly criticRewrites: readonly RewriteTrace[];
  readonly criticRetriesExhausted: boolean;
}

function buildAmbiguousEntityBranchPlan(
  plan: QueryPlanV1,
  hint: AmbiguousEntityHint,
  branch: AmbiguousEntityHintBranch,
): QueryPlanV1 {
  const { ambiguousEntityHints: _omittedAmbiguousHints, ...baseExpansions } = plan.expansions;
  return {
    ...plan,
    constraints: {
      ...plan.constraints,
      soft: uniqueConstraints([
        ...plan.constraints.soft,
        ...buildAmbiguousEntityHintSoftConstraints([hint]),
        {
          attribute: branch.softConstraint.attribute,
          operator: branch.softConstraint.operator,
          value: branch.softConstraint.value,
          source_phrase: `ambiguous_entity_branch(${hint.surface}:${branch.label})`,
          confidence: 0.78,
          mapping_version: 'ambiguous-entity-branch-v1',
        },
      ]),
    },
    expansions: {
      ...baseExpansions,
      lexical: uniqueStrings([
        ...plan.expansions.lexical,
        ...hint.lexicalExpansions,
        ...branch.lexicalExpansions,
      ]),
      semantic: uniqueStrings([
        ...plan.expansions.semantic,
        ...branch.semanticExpansions,
      ]),
    },
  };
}

function buildAmbiguousEntityBranchRetrievalInput(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  requestContext: RequestExecutionContext | undefined,
  anchorEntityId: CanonicalEntityId | undefined,
): HybridRetrievalInput {
  const branchInput = buildHybridRetrievalInputForPlan(
    plan,
    'hybrid',
    anchorEntityId,
    undefined,
    requestContext,
  );
  return {
    ...branchInput,
    compiledRetrievalMode: compiled.execution.effectiveRetrievalMode,
    executionBudgetMaxCandidates: compiled.execution.budget.maxCandidates,
  };
}

function mergeBalancedBranchCandidates(
  branchSets: readonly BranchCandidateSet[],
  maxCandidates: number,
): readonly HybridCandidate[] {
  const sortedBranchSets = branchSets.map((branchSet) => ({
    ...branchSet,
    candidates: [...branchSet.candidates].sort((left, right) => {
      const diff = candidateDiscoveryScore(right) - candidateDiscoveryScore(left);
      return diff !== 0 ? diff : String(left.entityId).localeCompare(String(right.entityId));
    }),
  }));
  const cursors = sortedBranchSets.map(() => 0);
  const seenEntityIds = new Set<string>();
  const merged: HybridCandidate[] = [];

  let progressed = true;
  while (progressed && merged.length < maxCandidates) {
    progressed = false;
    for (const [branchIndex, branchSet] of sortedBranchSets.entries()) {
      let cursor = cursors[branchIndex] ?? 0;
      while (
        cursor < branchSet.candidates.length
        && seenEntityIds.has(String(branchSet.candidates[cursor]?.entityId))
      ) {
        cursor += 1;
      }
      cursors[branchIndex] = cursor;
      const candidate = branchSet.candidates[cursor];
      if (candidate === undefined) {
        continue;
      }
      merged.push(candidate);
      seenEntityIds.add(String(candidate.entityId));
      cursors[branchIndex] = cursor + 1;
      progressed = true;
      if (merged.length >= maxCandidates) {
        break;
      }
    }
  }

  return merged;
}

function uniqueConstraints(
  constraints: readonly NormalizedConstraint[],
): readonly NormalizedConstraint[] {
  const seen = new Set<string>();
  const unique: NormalizedConstraint[] = [];
  for (const constraint of constraints) {
    const key = [
      constraint.attribute,
      constraint.operator,
      JSON.stringify(constraint.value),
      constraint.source_phrase,
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(constraint);
  }
  return unique;
}

async function retrieveAmbiguousEntityBranchCandidates(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  compiled: CompiledWineQuery,
  requestContext: RequestExecutionContext | undefined,
  anchorEntityId: CanonicalEntityId | undefined,
): Promise<BranchCandidateRetrievalResult> {
  const queryRewriter = createQueryRewriter(
    ports.chatLlm !== undefined ? { chatLlm: ports.chatLlm } : {},
  );
  const branchSpecs = (plan.expansions.ambiguousEntityHints ?? []).flatMap((hint) =>
    hint.explorationBranches.map((branch) => ({ hint, branch })),
  );

  const branchExecution = await executeRetrievalBranches(
    branchSpecs.map(({ hint, branch }) => ({
      key: branch.label,
      obligation: 'required' as const,
      execute: async () => {
        const branchPlan = buildAmbiguousEntityBranchPlan(plan, hint, branch);
        const branchInput = buildAmbiguousEntityBranchRetrievalInput(
          branchPlan,
          compiled,
          requestContext,
          anchorEntityId,
        );
        const graphResult = await executeGraphAware(
          branchInput,
          compiled.constraintGraph,
          {
            candidatePool: ports.candidatePool,
            bundleSelector: new BundleSelectorImpl(),
            subqueryRetriever: buildProductionSubqueryRetriever(ports.candidatePool),
            queryRewriter,
            budgetLedger: new InMemoryBudgetLedger(
              deriveBudgetLedgerOptionsFromCompiled(compiled),
            ),
          },
          DEFAULT_CRITIC_GRAPH_EXECUTOR_OPTIONS,
          buildCriticSignalProbeForCompiledQuery(branchPlan, compiled),
        );
        return {
          branchLabel: branch.label,
          candidates: graphResult.candidates,
          retrievalTelemetry: graphResult.retrievalTelemetry,
          criticRewrites: graphResult.criticRewrites ?? [],
          criticRetriesExhausted: graphResult.criticRetriesExhausted ?? false,
        };
      },
    })),
  );
  const branchResults = branchExecution.successes.map((success) => success.result);
  const optionalBranchDegradation = formatRetrievalBranchFailureReasons(
    'ambiguous_entity',
    branchExecution.optionalFailures,
    'degraded',
  );
  if (branchExecution.status === 'fail_closed') {
    return {
      status: 'fail_closed',
      candidates: [],
      degradationSignals: [
        ...formatRetrievalBranchFailureReasons(
          'ambiguous_entity',
          branchExecution.requiredFailures,
          'fail_closed',
        ),
        ...optionalBranchDegradation,
      ],
      criticRewrites: branchResults.flatMap((result) => result.criticRewrites),
      criticRetriesExhausted: branchResults.some((result) => result.criticRetriesExhausted),
    };
  }

  return {
    status: 'ok',
    candidates: mergeBalancedBranchCandidates(
      branchResults.map((result) => ({
        branchLabel: result.branchLabel,
        candidates: result.candidates,
      })),
      compiled.execution.budget.maxCandidates,
    ),
    degradationSignals: [
      ...optionalBranchDegradation,
      ...branchResults.flatMap((result) =>
        result.retrievalTelemetry?.degradationSignals.map((signal) =>
          `retrieval_degraded:${signal.component}:${signal.reason}`,
        ) ?? []),
    ],
    criticRewrites: branchResults.flatMap((result) => result.criticRewrites),
    criticRetriesExhausted: branchResults.some((result) => result.criticRetriesExhausted),
  };
}

async function retrieveTypedRecommendationCandidates(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  compiled: CompiledWineQuery,
  requestContext: RequestExecutionContext | undefined,
  anchorEntityId: CanonicalEntityId | undefined,
): Promise<BranchCandidateRetrievalResult> {
  const queryRewriter = createQueryRewriter(
    ports.chatLlm !== undefined ? { chatLlm: ports.chatLlm } : {},
  );

  const branchExecution = await executeRetrievalBranches(
    SEARCH_TOOL_DIVERSITY_WINE_TYPES.map((wineType) => ({
      key: wineType,
      obligation: 'required' as const,
      execute: async () => {
        const typedPlan = buildTypedRecommendationPlan(plan, wineType);
        const typedInput = buildTypedRecommendationRetrievalInput(
          typedPlan,
          compiled,
          requestContext,
          anchorEntityId,
        );
        const graphResult = await executeGraphAware(
          typedInput,
          compiled.constraintGraph,
          {
            candidatePool: ports.candidatePool,
            bundleSelector: new BundleSelectorImpl(),
            subqueryRetriever: buildProductionSubqueryRetriever(ports.candidatePool),
            queryRewriter,
            budgetLedger: new InMemoryBudgetLedger(
              deriveBudgetLedgerOptionsFromCompiled(compiled),
            ),
          },
          DEFAULT_CRITIC_GRAPH_EXECUTOR_OPTIONS,
          buildCriticSignalProbeForCompiledQuery(typedPlan, compiled),
        );

        return { wineType, graphResult };
      },
    })),
  );
  const branchResults = branchExecution.successes.map((success) => success.result);
  const optionalBranchDegradation = formatRetrievalBranchFailureReasons(
    'typed_recommendation',
    branchExecution.optionalFailures,
    'degraded',
  );
  if (branchExecution.status === 'fail_closed') {
    return {
      status: 'fail_closed',
      candidates: [],
      degradationSignals: [
        ...formatRetrievalBranchFailureReasons(
          'typed_recommendation',
          branchExecution.requiredFailures,
          'fail_closed',
        ),
        ...optionalBranchDegradation,
      ],
      criticRewrites: branchResults.flatMap(({ graphResult }) => graphResult.criticRewrites ?? []),
      criticRetriesExhausted: branchResults.some(({ graphResult }) => graphResult.criticRetriesExhausted ?? false),
    };
  }

  const branchSets: BranchCandidateSet[] = branchResults.map(({ wineType, graphResult }) => ({
    branchLabel: wineType,
    candidates: graphResult.candidates,
  }));
  return {
    status: 'ok',
    // Keep the discovery pool branch-balanced. Score still sorts within each
    // wine-type branch, but the merged top-k must not collapse back into a
    // single score-dominant pool or the gift/non-expert path regresses to the
    // same red-heavy failure mode we are trying to prevent.
    candidates: mergeBalancedBranchCandidates(
      branchSets,
      compiled.execution.budget.maxCandidates,
    ),
    degradationSignals: [
      ...optionalBranchDegradation,
      ...branchResults.flatMap(({ graphResult }) =>
        graphResult.retrievalTelemetry?.degradationSignals.map((signal) =>
          `retrieval_degraded:${signal.component}:${signal.reason}`,
        ) ?? []),
    ],
    criticRewrites: branchResults.flatMap(({ graphResult }) => graphResult.criticRewrites ?? []),
    criticRetriesExhausted: branchResults.some(({ graphResult }) => graphResult.criticRetriesExhausted ?? false),
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildDenseSafeSemanticViews(
  plan: QueryPlanV1,
): readonly string[] {
  const views = plan.normalizedQueryViews;
  if (views === undefined) {
    return [];
  }

  if (views.semanticVariants.length > 0) {
    return views.semanticVariants;
  }

  return uniqueStrings([
    views.raw,
    views.accentless,
    views.punctuationStripped,
    views.vintageCanonicalized,
    views.vintageStripped,
    ...(views.transliterated !== undefined ? [views.transliterated] : []),
    ...(views.reordered ?? []),
  ]);
}

function buildPlanLexicalQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.normalizedQuery,
    ...(plan.normalizedQueryViews?.lookupVariants ?? []),
    ...plan.expansions.lexical,
    ...extraTerms,
  ]);
}

function buildPlanSemanticQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.rawQuery,
    ...(plan.normalizedQueryViews?.transliterated !== undefined
      ? [plan.normalizedQueryViews.transliterated]
      : []),
    ...plan.expansions.semantic,
    ...extraTerms,
  ]);
}

function buildPlanSemanticEmbeddingQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.rawQuery,
    ...buildDenseSafeSemanticViews(plan),
    ...plan.expansions.semantic,
    ...extraTerms,
  ]);
}

function isSlotNode(node: unknown): node is SlotNode {
  return typeof node === 'object' && node !== null && (node as { kind?: string }).kind === 'slot';
}

interface ScopedConstraintSelection {
  readonly slotIds: ReadonlySet<string>;
  readonly scopedGraph: ConstraintGraph;
  readonly constraints: QueryPlanV1['constraints'];
}

function buildScopedConstraintBundleFromGraph(
  _base: HybridRetrievalInput,
  graph: ConstraintGraph,
  subqueryId: string,
): ScopedConstraintSelection | null {
  const scopedGraph = projectConstraintGraphForSubquery(graph, subqueryId);
  if (scopedGraph === undefined) return null;
  const ownedSlotIds = collectApplicableSlotIdsForSubquery(graph, subqueryId);
  const mandatorySlotIds = collectConjunctivelyRequiredSlotIds(scopedGraph);

  const hard: Array<QueryPlanV1['constraints']['hard'][number]> = [];
  const soft: Array<QueryPlanV1['constraints']['soft'][number]> = [];
  const inferred: Array<QueryPlanV1['constraints']['inferred'][number]> = [];

  for (const node of scopedGraph.nodes) {
    if (!isSlotNode(node)) continue;
    const projected = {
      attribute: node.attribute,
      operator: node.operator,
      value: node.value,
      confidence: node.confidence,
      source_phrase: `graph_slot(${node.attribute})`,
    };
    switch (node.sourceTier) {
      case 'hard':
        if (mandatorySlotIds.has(node.nodeId)) {
          hard.push(projected);
        }
        break;
      case 'soft':
        soft.push(projected);
        break;
      case 'inferred':
        inferred.push(projected);
        break;
    }
  }

  if (scopedGraph.nodes.every((node) => !isSlotNode(node))) {
    return null;
  }

  return {
    slotIds: ownedSlotIds,
    scopedGraph,
    constraints: { hard, soft, inferred },
  };
}

function scopeHybridRetrievalInputToSubquery(
  base: HybridRetrievalInput,
  subquery: SubqueryNode,
  graph: ConstraintGraph,
): HybridRetrievalInput {
  const scopedSelection = buildScopedConstraintBundleFromGraph(
    base,
    graph,
    subquery.nodeId,
  );
  if (scopedSelection === null) return base;
  const scopedConstraints = scopedSelection.constraints;

  const scopedPlan: QueryPlanV1 = {
    ...base.queryPlan,
    constraints: scopedConstraints,
  };
  const scopedRetrievalPlan = buildRetrievalPlan(scopedConstraints);
  const expansions = buildStructuredQueryExpansions(scopedPlan, scopedRetrievalPlan);
  const graphExpansions = buildStructuredQueryExpansionsFromGraph(
    scopedSelection.scopedGraph,
  );

  return {
    ...base,
    queryPlan: scopedPlan,
    hardConstraints: scopedConstraints.hard,
    softConstraints: scopedConstraints.soft,
    retrievalPlan: scopedRetrievalPlan,
    lexicalQueries: buildPlanLexicalQueryVariants(scopedPlan, [
      ...expansions.lexical,
      ...graphExpansions.lexical,
    ]),
    semanticQueries: buildPlanSemanticQueryVariants(scopedPlan, [
      ...expansions.semantic,
      ...graphExpansions.semantic,
    ]),
    semanticEmbeddingQueries: buildPlanSemanticEmbeddingQueryVariants(scopedPlan, [
      ...expansions.semantic,
      ...graphExpansions.semantic,
    ]),
    constraintGraph: scopedSelection.scopedGraph,
  };
}

function buildStructuredQueryExpansionsFromGraph(
  graph: ConstraintGraph,
): {
  readonly lexical: readonly string[];
  readonly semantic: readonly string[];
} {
  const lexical: string[] = [];
  const semantic: string[] = [];
  const wineTypeContext = resolveWineTypeContextFromGraph(graph);
  for (const node of graph.nodes) {
    if (!isSlotNode(node)) continue;
    const phrases = retrievalValueToPhrases(node.attribute, node.value, wineTypeContext);
    if (phrases.length === 0) continue;
    lexical.push(...phrases);
    if (
      node.attribute === 'region'
      || node.attribute === 'country'
      || node.attribute === 'appellation'
      || node.attribute === 'closure'
      || node.attribute === 'grape_family'
      || node.attribute === 'grape_primary'
      || node.attribute === 'style'
      || node.attribute === 'flavor_profile'
      || node.attribute === 'certification'
      || node.attribute === 'pairing'
      || node.attribute === 'occasion'
    ) {
      semantic.push(...phrases);
    }
  }
  return { lexical: uniqueStrings(lexical), semantic: uniqueStrings(semantic) };
}

function resolveWineTypeContextFromGraph(graph: ConstraintGraph): WineTypeValue | undefined {
  for (const node of graph.nodes) {
    if (!isSlotNode(node) || node.attribute !== 'wine_type') continue;
    if (typeof node.value === 'string' && isWineTypeValue(node.value)) {
      return node.value;
    }
    if (Array.isArray(node.value)) {
      const matched = node.value.find(isWineTypeValue);
      if (matched !== undefined) {
        return matched;
      }
    }
  }
  return undefined;
}

function buildProductionSubqueryRetriever(
  candidatePool: CandidatePoolPort,
): {
  readonly stateIsolation: 'shared_mutable';
  retrieve(
    base: HybridRetrievalInput,
    subquery: SubqueryNode,
    graph: ConstraintGraph,
  ): Promise<SubqueryRetrievalResult>;
} {
  return {
    stateIsolation: 'shared_mutable',
    async retrieve(base, subquery, graph) {
      const scopedInput = scopeHybridRetrievalInputToSubquery(base, subquery, graph);
      const retrieval = await executeCandidatePoolRetrieval(candidatePool, scopedInput);
      return {
        candidates: retrieval.candidates,
        telemetry: retrieval.telemetry,
      };
    },
  };
}

/**
 * Specialized browse/compare paths first; falls back to {@link CandidatePoolPort.generate}.
 *
 * E2-U4: Accepts optional CompiledWineQuery. When present, specialised path dispatch
 * uses compiled.execution.effectiveRetrievalMode (authoritative) instead of
 * plan.retrievalMode (V1 fallback).
 */
export async function retrieveHybridCandidatesForPlan(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  resolveEntity: (p: QueryPlanV1) => Promise<EntityResolveResult>,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityIdOverride?: CanonicalEntityId,
): Promise<HybridCandidateRetrievalResult> {
  const effectiveMode = compiled.execution.effectiveRetrievalMode;
  const usedCompiledExecution = true;

  const limit = SPECIALIZED_HYBRID_RETRIEVAL_LIMIT;
  let fallbackAnchorEntityId: CanonicalEntityId | undefined = anchorEntityIdOverride;
  const degradationReasons = new Set<SpecializedFallbackReason>();
  const requestedRoute = (
    effectiveMode === 'producer_browse' ||
    effectiveMode === 'region_browse' ||
    effectiveMode === 'compare_candidates'
  )
    ? effectiveMode
    : null;

  pipelineDebug(
    {
      step: 'retrieval.hybrid_candidates.start',
      retrieval_mode: effectiveMode,
      query_class: plan.queryClass,
    },
    'pipeline hybrid retrieval',
  );

  switch (effectiveMode) {
    case 'producer_browse': {
      const producerName = extractProducerBrowseSeed(plan);
      if (ports.browseRetriever === undefined) {
        degradationReasons.add('producer_browse_unavailable');
        break;
      }
      if (producerName !== undefined) {
        try {
          const candidates = await ports.browseRetriever.browseProducer(
            producerName,
            plan.constraints,
            limit,
            // ADR-014 Phase 1b.3b: thread the compiled constraint graph so
            // browse filter extraction + annotator use graph-native semantics.
            compiled.constraintGraph,
          );
          if (candidates.length > 0) {
            const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
            const provenanceShortfall = buildMissingProvenanceObligations(
              compiled.execution.provenancePolicy,
              retrievalProvenanceCoverage,
            );
            pipelineDebug(
              {
                step: 'retrieval.producer_browse',
                candidate_count: candidates.length,
                retrieval_provenance_satisfied: provenanceShortfall.length === 0,
                retrieval_provenance_missing: provenanceShortfall,
              },
              'pipeline specialized retrieval',
            );
            const routeDegradation = mergeRetrievalDegradation(degradationReasons, provenanceShortfall);
            return {
              candidates,
              effectiveRetrievalMode: effectiveMode,
              retrievalKind: 'specialized_hybrid',
              sparseExecuted: false,
              usedCompiledExecution,
              retrievalProvenanceCoverage,
              ...(routeDegradation !== undefined ? { routeDegradation } : {}),
              specializedRouteObservability: {
                specializedRouteRequested: 'producer_browse',
                specializedRouteExecuted: 'producer_browse',
                fallbackApplied: false,
              },
            };
          }
          degradationReasons.add('producer_browse_fallback');
        } catch (err) {
          // Circuit breaker open or transient infra failure — degrade gracefully
          // rather than propagating an unhandled rejection to the caller.
          const reason = err instanceof CircuitBreakerOpenError
            ? 'producer_browse_unavailable'
            : 'producer_browse_fallback';
          degradationReasons.add(reason);
          pipelineDebug(
            { step: 'retrieval.producer_browse.error', reason, err_name: err instanceof Error ? err.name : 'unknown' },
            'pipeline producer_browse degraded',
          );
        }
      } else {
        degradationReasons.add('producer_browse_fallback');
      }
      break;
    }
    case 'region_browse': {
      const regionName = extractRegionBrowseSeed(plan);
      if (ports.browseRetriever === undefined) {
        degradationReasons.add('region_browse_unavailable');
        break;
      }
      if (regionName !== undefined) {
        try {
          const candidates = await ports.browseRetriever.browseRegion(
            regionName,
            plan.constraints,
            limit,
            // ADR-014 Phase 1b.3b: thread the compiled constraint graph.
            compiled.constraintGraph,
          );
          if (candidates.length > 0) {
            const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
            const provenanceShortfall = buildMissingProvenanceObligations(
              compiled.execution.provenancePolicy,
              retrievalProvenanceCoverage,
            );
            pipelineDebug(
              {
                step: 'retrieval.region_browse',
                candidate_count: candidates.length,
                retrieval_provenance_satisfied: provenanceShortfall.length === 0,
                retrieval_provenance_missing: provenanceShortfall,
              },
              'pipeline specialized retrieval',
            );
            const routeDegradation = mergeRetrievalDegradation(degradationReasons, provenanceShortfall);
            return {
              candidates,
              effectiveRetrievalMode: effectiveMode,
              retrievalKind: 'specialized_hybrid',
              sparseExecuted: false,
              usedCompiledExecution,
              retrievalProvenanceCoverage,
              ...(routeDegradation !== undefined ? { routeDegradation } : {}),
              specializedRouteObservability: {
                specializedRouteRequested: 'region_browse',
                specializedRouteExecuted: 'region_browse',
                fallbackApplied: false,
              },
            };
          }
          degradationReasons.add('region_browse_fallback');
        } catch (err) {
          const reason = err instanceof CircuitBreakerOpenError
            ? 'region_browse_unavailable'
            : 'region_browse_fallback';
          degradationReasons.add(reason);
          pipelineDebug(
            { step: 'retrieval.region_browse.error', reason, err_name: err instanceof Error ? err.name : 'unknown' },
            'pipeline region_browse degraded',
          );
        }
      } else {
        degradationReasons.add('region_browse_fallback');
      }
      break;
    }
    case 'compare_candidates': {
      if (ports.compareRetriever !== undefined) {
        const anchorResolution = await resolveEntity(plan);
        // Only use a resolver-validated entity as anchor — never fall back to
        // unverified raw planner candidateEntityIds, which can produce wrong compares
        // and would be mislabelled as 'compare_candidates_fallback' instead of
        // 'compare_anchor_resolution_failed'.
        const anchorEntityId = anchorResolution.topEntity?.entityId;
        fallbackAnchorEntityId = anchorEntityId;
        if (anchorEntityId !== undefined) {
          try {
            const candidates = await ports.compareRetriever.compareAgainstAnchor(
              anchorEntityId,
              plan.constraints,
              limit,
              // ADR-014 Phase 1b.3b: thread the compiled constraint graph.
              compiled.constraintGraph,
            );
            if (candidates.length > 0) {
              const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
              const provenanceShortfall = buildMissingProvenanceObligations(
                compiled.execution.provenancePolicy,
                retrievalProvenanceCoverage,
              );
              pipelineDebug(
                {
                  step: 'retrieval.compare_candidates',
                  candidate_count: candidates.length,
                  retrieval_provenance_satisfied: provenanceShortfall.length === 0,
                  retrieval_provenance_missing: provenanceShortfall,
                },
                'pipeline specialized retrieval',
              );
              const routeDegradation = mergeRetrievalDegradation(degradationReasons, provenanceShortfall);
              return {
                candidates,
                effectiveRetrievalMode: effectiveMode,
                retrievalKind: 'specialized_hybrid',
                sparseExecuted: false,
                usedCompiledExecution,
                retrievalProvenanceCoverage,
                ...(routeDegradation !== undefined ? { routeDegradation } : {}),
                specializedRouteObservability: {
                  specializedRouteRequested: 'compare_candidates',
                  specializedRouteExecuted: 'compare_candidates',
                  fallbackApplied: false,
                },
              };
            }
            degradationReasons.add('compare_candidates_fallback');
          } catch (err) {
            const reason = err instanceof CircuitBreakerOpenError
              ? 'compare_retriever_unavailable'
              : 'compare_candidates_fallback';
            degradationReasons.add(reason);
            pipelineDebug(
              { step: 'retrieval.compare_candidates.error', reason, err_name: err instanceof Error ? err.name : 'unknown' },
              'pipeline compare_candidates degraded',
            );
          }
        } else {
          // Resolver returned no validated entity — label correctly and fall through.
          degradationReasons.add('compare_anchor_resolution_failed');
        }
      } else {
        degradationReasons.add('compare_retriever_unavailable');
      }
      break;
    }
    default:
      break;
  }

  const baseRetrievalInput = buildHybridRetrievalInputForPlan(
    plan,
    'hybrid',
    fallbackAnchorEntityId,
    compiled,
    requestContext,
  );
  const multiQueryIntent = classifyIntentForMultiQueryFanout(plan, effectiveMode);
  const retrievalInput = await maybeExpandSemanticQueriesForFanout(
    baseRetrievalInput,
    ports,
    multiQueryIntent,
  );

  if (
    shouldRunAmbiguousEntityBranchExploration(plan)
    && !hasHybridSubqueryTopology(compiled.constraintGraph)
  ) {
    const ambiguousBranchResult = await retrieveAmbiguousEntityBranchCandidates(
      plan,
      ports,
      compiled,
      requestContext,
      fallbackAnchorEntityId,
    );
    const candidates = ambiguousBranchResult.candidates;
    const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
    const provenanceShortfall = buildMissingProvenanceObligations(
      compiled.execution.provenancePolicy,
      retrievalProvenanceCoverage,
    );
    const mergedDegradation = mergeRetrievalDegradation(
      degradationReasons,
      provenanceShortfall,
      ambiguousBranchResult.degradationSignals,
    );
    const criticObservability: CriticRetrievalObservability | undefined =
      ambiguousBranchResult.criticRewrites.length > 0 || ambiguousBranchResult.criticRetriesExhausted
        ? {
            rewrites: ambiguousBranchResult.criticRewrites,
            retriesExhausted: ambiguousBranchResult.criticRetriesExhausted,
            degradationReasons: ambiguousBranchResult.criticRetriesExhausted
              ? ['critic_retries_exhausted']
              : [],
          }
        : undefined;

    return {
      candidates,
      effectiveRetrievalMode: effectiveMode,
      retrievalKind: 'generic_hybrid',
      sparseExecuted: true,
      usedCompiledExecution,
      retrievalProvenanceCoverage,
      ...(mergedDegradation !== undefined ? { routeDegradation: mergedDegradation } : {}),
      ...(requestedRoute !== null
        ? {
            specializedRouteObservability: {
              specializedRouteRequested: requestedRoute,
              specializedRouteExecuted: null,
              fallbackApplied: degradationReasons.size > 0,
              ...(degradationReasons.size > 0 ? { fallbackReason: [...degradationReasons][0] } : {}),
            },
          }
        : {}),
      ...(criticObservability !== undefined ? { criticObservability } : {}),
    };
  }

  if (
    shouldRunTypedRecommendationDiscovery(plan)
    && !hasHybridSubqueryTopology(compiled.constraintGraph)
  ) {
    const typedDiscoveryResult = await retrieveTypedRecommendationCandidates(
      plan,
      ports,
      compiled,
      requestContext,
      fallbackAnchorEntityId,
    );
    const candidates = typedDiscoveryResult.candidates;
    const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
    const provenanceShortfall = buildMissingProvenanceObligations(
      compiled.execution.provenancePolicy,
      retrievalProvenanceCoverage,
    );
    const mergedDegradation = mergeRetrievalDegradation(
      degradationReasons,
      provenanceShortfall,
      typedDiscoveryResult.degradationSignals,
    );
    const criticObservability: CriticRetrievalObservability | undefined =
      typedDiscoveryResult.criticRewrites.length > 0 || typedDiscoveryResult.criticRetriesExhausted
        ? {
            rewrites: typedDiscoveryResult.criticRewrites,
            retriesExhausted: typedDiscoveryResult.criticRetriesExhausted,
            degradationReasons: typedDiscoveryResult.criticRetriesExhausted
              ? ['critic_retries_exhausted']
              : [],
          }
        : undefined;

    return {
      candidates,
      effectiveRetrievalMode: effectiveMode,
      retrievalKind: 'generic_hybrid',
      sparseExecuted: true,
      usedCompiledExecution,
      retrievalProvenanceCoverage,
      ...(mergedDegradation !== undefined ? { routeDegradation: mergedDegradation } : {}),
      ...(requestedRoute !== null
        ? {
            specializedRouteObservability: {
              specializedRouteRequested: requestedRoute,
              specializedRouteExecuted: null,
              fallbackApplied: degradationReasons.size > 0,
              ...(degradationReasons.size > 0 ? { fallbackReason: [...degradationReasons][0] } : {}),
            },
          }
        : {}),
      ...(criticObservability !== undefined ? { criticObservability } : {}),
    };
  }

  pipelineDebug({ step: 'retrieval.candidate_pool.fallback' }, 'pipeline candidate pool generate');

  // ADR-015 Axis 2 + ADR-013 Phase 1c: route the generic hybrid
  // retrieval through `executeGraphAware`. This is the wiring PR4
  // deferred — without it neither the BundleSelector nor the critic
  // ever runs in production. The wrapper:
  //   - passes through (one-shot, byte-identical to pre-PR4) when the
  //     graph carries no multi-subquery hybrid topology AND the critic
  //     flag is off,
  //   - engages the BundleSelector when the graph carries a multi-
  //     subquery hybrid (BUNDLE_SELECTOR_ENABLED gate),
  //   - wraps either path with a bounded critic retry loop when
  //     RETRIEVAL_EXECUTOR_CRITIC=true AND a rewriter is wired.
  const probe = buildCriticSignalProbeForCompiledQuery(
    plan,
    compiled,
  );
  const queryRewriter = createQueryRewriter(
    ports.chatLlm !== undefined ? { chatLlm: ports.chatLlm } : {},
  );
  // ADR-013 Phase 1c.x: instantiate a per-request `InMemoryBudgetLedger`
  // and thread it through the executor deps. This is the production
  // wiring that replaces PR4's `onReserveAssignment` callback stub —
  // every winning subquery candidate now reserves against a real
  // ledger. The instance is per-call (scoped to this retrieval
  // invocation) so there is no cross-request race window; the
  // reservation state dies with the request. The optional KRW ceiling
  // is read from the compiled graph's global budget when present.
  const budgetLedger = new InMemoryBudgetLedger(
    deriveBudgetLedgerOptionsFromCompiled(compiled),
  );
  const graphResult = await executeGraphAware(
    retrievalInput,
    compiled.constraintGraph,
    {
      candidatePool: ports.candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever: buildProductionSubqueryRetriever(ports.candidatePool),
      queryRewriter,
      budgetLedger,
    },
    DEFAULT_CRITIC_GRAPH_EXECUTOR_OPTIONS,
    probe,
  );
  const candidates = graphResult.candidates;
  // E4: Retrieve the RRF fusion trace and hard-filter drop log produced during execute()/generate().
  // Only available when candidatePool implements these methods (CandidatePoolService).
  // Specialized browse/compare paths that return early above do NOT have these traces
  // (they bypass the RRF fusion step entirely), so these are intentionally absent there.
  const retrievalFusionTrace = graphResult.retrievalTelemetry?.fusionTrace;
  const hardFilterDropLog = graphResult.retrievalTelemetry?.dropLog;
  // Wave 2 — surface per-channel firing state into pipeline_debug so the
  // bench / operator dashboards can see whether learned_sparse went
  // dormant, whether a channel timed out, etc., in a single line per
  // request. Emitted only when fusion trace is present (generic hybrid
  // path); specialized browse/compare bypass RRF and therefore have no
  // perChannel rows to surface.
  if (retrievalFusionTrace !== undefined) {
    pipelineDebug(
      {
        step: 'retrieval.hybrid_candidates.per_channel',
        per_channel: retrievalFusionTrace.perChannel,
        query_class: retrievalFusionTrace.queryClass,
        fusion_class: retrievalFusionTrace.fusionClass,
      },
      'pipeline retrieval per-channel telemetry',
    );
  }
  const retrievalDegradationSignals = graphResult.retrievalTelemetry?.degradationSignals ?? [];
  const retrievalInternalReasons = [
    ...retrievalSignalsToReasons(retrievalDegradationSignals),
    ...(graphResult.assignmentSolution?.degradationReasons ?? []),
    ...(graphResult.executionDegradationReasons ?? []),
  ];
  const retrievalProvenanceCoverage = buildRetrievalCoverage(plan, compiled, candidates);
  const provenanceShortfall = buildMissingProvenanceObligations(
    compiled.execution.provenancePolicy,
    retrievalProvenanceCoverage,
  );
  const mergedDegradation = mergeRetrievalDegradation(
    degradationReasons,
    provenanceShortfall,
    retrievalInternalReasons,
  );
  const criticObservability: CriticRetrievalObservability | undefined =
    graphResult.criticRewrites !== undefined
      ? {
          rewrites: graphResult.criticRewrites,
          retriesExhausted: graphResult.criticRetriesExhausted ?? false,
          degradationReasons: graphResult.criticDegradationReasons ?? [],
        }
      : undefined;
  return {
    candidates,
    effectiveRetrievalMode: effectiveMode,
    retrievalKind: 'generic_hybrid',
    sparseExecuted: true,
    usedCompiledExecution,
    retrievalProvenanceCoverage,
    ...(retrievalFusionTrace !== undefined ? { retrievalFusionTrace } : {}),
    ...(hardFilterDropLog !== undefined && hardFilterDropLog.length > 0
      ? { hardFilterDropLog }
      : {}),
    ...(mergedDegradation !== undefined ? { routeDegradation: mergedDegradation } : {}),
    ...(requestedRoute !== null
      ? {
          specializedRouteObservability: {
            specializedRouteRequested: requestedRoute,
            specializedRouteExecuted: null,
            fallbackApplied: degradationReasons.size > 0,
            ...(degradationReasons.size > 0 ? { fallbackReason: [...degradationReasons][0] } : {}),
          },
        }
      : {}),
    ...(criticObservability !== undefined ? { criticObservability } : {}),
  };
}

/**
 * ADR-015 Axis 2 + ADR-013 Phase 1c: default options for the
 * graph-aware executor when called from the hybrid candidates flow.
 *
 * Scoring + pricing are conservative defaults that preserve pre-PR4
 * behaviour on the bundle path: every cell is scored by retrieval
 * fusion score (higher = better), and price uses canonical KRW
 * conversion from `HybridCandidate.priceUsd` so `shares_budget`
 * feasibility is solved inside the exact assignment stage.
 */
const DEFAULT_BUNDLE_SCORER: BundleCellScorer = ({ candidate }) =>
  // Bundle scoring reads only the canonical fusion score substrate.
  // Non-fusion candidates contribute 0 here by contract.
  candidate.fusionRrfTotal ?? 0;

const DEFAULT_BUNDLE_PRICER: BundleCellPricer = ({ candidate, resource }) => {
  if (resource === 'price_total') {
    const priceUsd = candidate.priceUsd;
    return typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd >= 0
      ? Math.round(priceUsd * KRW_PER_USD_APPROXIMATE)
      : 0;
  }
  if (resource === 'count') return 1;
  return 0;
};

const DEFAULT_CRITIC_GRAPH_EXECUTOR_OPTIONS: GraphExecutorOptions = {
  scoreFor: DEFAULT_BUNDLE_SCORER,
  priceFor: DEFAULT_BUNDLE_PRICER,
};

/**
 * ADR-013 Phase 1c.x: derive a per-request `BudgetLedgerOptions` from
 * the compiled query's constraint graph. When the graph carries a
 * `globalBudgets.priceTotal` entry, we surface it as the ledger's KRW
 * ceiling (converting USD → KRW via the SSoT constant when needed).
 * Otherwise the ledger runs in unlimited / telemetry-only mode.
 */
function deriveBudgetLedgerOptionsFromCompiled(
  compiled: CompiledWineQuery,
): { readonly priceTotalKrw?: number } {
  const priceTotal = compiled.constraintGraph?.globalBudgets.priceTotal;
  if (priceTotal === undefined) return {};
  if (!Number.isFinite(priceTotal.max) || priceTotal.max < 0) return {};
  if (priceTotal.currency === 'KRW') {
    return { priceTotalKrw: priceTotal.max };
  }
  // currency === 'USD' — convert to the ledger's canonical KRW unit
  // via the shared SSoT constant (rule 30, single source of truth).
  return { priceTotalKrw: Math.round(priceTotal.max * KRW_PER_USD_APPROXIMATE) };
}

/**
 * ADR-015 Axis 2: build the per-call probe the executor uses to feed
 * `decideRetry`. The probe pulls degradation signals from the candidate
 * pool's per-call accessor and computes graph-native satisfaction
 * signals from each result's matched slot refs / assignments.
 */
function buildCriticSignalProbeForCompiledQuery(
  _plan: QueryPlanV1,
  compiled: CompiledWineQuery,
): CriticSignalProbe {
  const graph = compiled.constraintGraph;
  return {
    coverageSignalsFor(result) {
      const candidates = result.candidates;
      const satisfiedNodeIds = new Set<string>();
      const out = new Set<string>();
      for (const candidate of candidates) {
        for (const attribute of candidate.matchedConstraints) {
          out.add(attribute);
        }
        for (const atomRef of candidate.matchedAtomRefs ?? []) {
          satisfiedNodeIds.add(atomRef);
        }
      }
      if (graph !== undefined) {
        for (const assignment of result.assignmentSolution?.assignments ?? []) {
          const matchedAtomRefs = new Set(assignment.candidate.matchedAtomRefs ?? []);
          const applicableSlotIds = collectApplicableSlotIdsForSubquery(
            graph,
            assignment.subqueryId,
          );
          if ([...applicableSlotIds].some((slotId) => matchedAtomRefs.has(slotId))) {
            satisfiedNodeIds.add(assignment.subqueryId);
          }
        }
      }
      const satisfiedBudgetResources = new Set<BudgetResource>();
      for (const usage of result.assignmentSolution?.budgetUsage ?? []) {
        if (usage.used <= usage.max) satisfiedBudgetResources.add(usage.resource);
      }
      return {
        satisfiedAttributes: out,
        ...(satisfiedNodeIds.size > 0 ? { satisfiedNodeIds } : {}),
        ...(satisfiedBudgetResources.size > 0 ? { satisfiedBudgetResources } : {}),
      };
    },
    degradationCodesFor(result) {
      return result.retrievalTelemetry?.degradationCodes ?? [];
    },
  };
}
