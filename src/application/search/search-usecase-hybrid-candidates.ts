import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type {
  ExecutionRetrievalMode,
  ProvenanceCoverageStage,
} from '../../domain/query/model/engine-execution-contract.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
} from './port/search-pipeline-deps.port.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { SpecializedFallbackReason } from './specialized-fallback-reason.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import {
  buildHybridCandidateCoverageStage,
  buildMissingProvenanceObligations,
} from './search-usecase-provenance-closure.js';
import {
  executeGraphAware,
  type CriticSignalProbe,
  type GraphExecutorOptions,
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
import type { DecisionInputCriticRewrite } from '../../domain/decision/model/decision-input.js';
import type { RewriteTrace } from '../../domain/retrieval/service/query-rewriter.js';

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
  const structuredQueries = buildStructuredQueryExpansions(plan, retrievalPlan);
  // TA4: Propagate fuzzy entity hypothesis terms from the planner into the retrieval
  // input. When the planner's fuzzy matcher fires on an anchor-miss query, these terms
  // are entity hypothesis seeds that enable the entity-first dual retrieval path.
  const fuzzyEntityHypotheses = plan.expansions.fuzzyEntityHypotheses;
  return {
    queryPlan: plan,
    route,
    ...(compiled !== undefined ? { compiledRetrievalMode: compiled.execution.effectiveRetrievalMode } : {}),
    lexicalQueries: uniqueStrings([plan.normalizedQuery, ...structuredQueries.lexical]),
    semanticQueries: uniqueStrings([plan.rawQuery, ...structuredQueries.semantic]),
    hardConstraints: plan.constraints.hard,
    softConstraints: plan.constraints.soft,
    retrievalPlan,
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
  for (const constraint of plan.constraints.hard) {
    const phrase = retrievalValueToPhrase(constraint.value);
    if (phrase !== undefined) {
      lexical.push(phrase);
      if (constraint.attribute === 'region' || constraint.attribute === 'country' || constraint.attribute === 'appellation') {
        semantic.push(phrase);
      }
    }
  }
  for (const boost of [...retrievalPlan.softBoosts, ...retrievalPlan.inferredBoosts]) {
    const phrase = retrievalValueToPhrase(boost.value);
    if (phrase === undefined) {
      continue;
    }
    lexical.push(phrase);
    if (boost.attribute === 'region' || boost.attribute === 'country' || boost.attribute === 'grape_family') {
      semantic.push(phrase);
    }
  }
  return { lexical: uniqueStrings(lexical), semantic: uniqueStrings(semantic) };
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
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

  const retrievalInput = buildHybridRetrievalInputForPlan(
    plan,
    'hybrid',
    fallbackAnchorEntityId,
    compiled,
    requestContext,
  );

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
    ports.candidatePool,
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
  const retrievalFusionTrace = ports.candidatePool.getLastFusionTrace?.();
  const hardFilterDropLog = ports.candidatePool.getLastDropLog?.();
  const retrievalDegradationSignals = ports.candidatePool.getLastDegradationSignals?.() ?? [];
  const retrievalInternalReasons = retrievalSignalsToReasons(retrievalDegradationSignals);
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
 * fusion score (higher = better), and price is `0` so shared-budget
 * edges become inert until a downstream PR teaches the bundle path
 * about price/popularity. The pricer **does not** read locale-dependent
 * fields — outputs are integers from the candidate metadata.
 */
const DEFAULT_BUNDLE_SCORER: BundleCellScorer = ({ candidate }) =>
  // ADR-013 / RFC-012 candidate score migration: prefer fusionRrfTotal
  // (the post-fusion canonical score). Fall back to the deprecated
  // retrievalFusionScore field for compatibility with retrievers that
  // have not yet migrated. Returning 0 keeps the cell assignable but
  // de-prioritised when both fields are absent.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- migration fallback per CLAUDE.md rule 31
  candidate.fusionRrfTotal ?? candidate.retrievalFusionScore ?? 0;

const DEFAULT_BUNDLE_PRICER: BundleCellPricer = () => 0;

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
 * pool's per-call accessor and computes the satisfied-attribute set
 * directly from each candidate's `matchedConstraints`.
 */
function buildCriticSignalProbeForCompiledQuery(
  _plan: QueryPlanV1,
  _compiled: CompiledWineQuery,
  candidatePool: CandidatePoolPort,
): CriticSignalProbe {
  return {
    satisfiedAttributesFor(candidates) {
      const out = new Set<string>();
      for (const candidate of candidates) {
        for (const attribute of candidate.matchedConstraints) {
          out.add(attribute);
        }
      }
      return out;
    },
    degradationReasonsFor() {
      // Retrieval-internal reasons are surfaced via the per-call
      // accessor (not the candidate stream). When the pool does not
      // implement the accessor (e.g. test stubs), the critic sees an
      // empty list and falls through to coverage-based decisions only.
      const signals = candidatePool.getLastDegradationSignals?.() ?? [];
      return signals.map((signal) => signal.reason);
    },
  };
}
