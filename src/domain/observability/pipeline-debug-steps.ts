/**
 * Canonical `step` strings for {@link pipelineDebug} / log filters.
 *
 * **Convention:** `domain.area.detail` (e.g. `decision.engine.response`).
 * Prefer importing these constants for new call sites; legacy code may still use inline strings.
 *
 * @see `.ai/debug-mode.md` — operator guide
 */
export const PipelineDebugStep = {
  // Search use case
  SEARCH_EXECUTE_START: 'search.execute.start',
  SEARCH_PRE_ROUTE_EARLY_EXIT: 'search.pre_route.early_exit',
  SEARCH_ROUTE_RESOLUTION: 'search.route_resolution',
  SEARCH_EXECUTE_DONE: 'search.execute.done',
  SEARCH_EXECUTE_STAGE_TIMINGS: 'search.execute.stage_timings',

  // Entity-only route
  ROUTE_ENTITY_ONLY_START: 'route.entity.only.start',
  ROUTE_ENTITY_ONLY_DONE: 'route.entity.only.done',
  ROUTE_ENTITY_CORRECTIVE_RETRY_START: 'route.entity.corrective_retry.start',
  ROUTE_ENTITY_CORRECTIVE_RETRY_CANDIDATES: 'route.entity.corrective_retry.candidates',

  // Hybrid anchor resolver (ranked routes)
  RESOLVER_ANCHOR_MISSING: 'resolver.anchor.missing',
  RESOLVER_ANCHOR_START: 'resolver.anchor.start',
  RESOLVER_ANCHOR_DONE: 'resolver.anchor.done',

  // Pre-route
  PRE_ROUTE_DECOMPOSED_COMPARISON: 'pre_route.decomposed_comparison',
  PRE_ROUTE_CONSTRAINT_CONTRADICTION: 'pre_route.constraint_contradiction',
  PRE_ROUTE_CACHE_HIT: 'pre_route.cache_hit',
  PRE_ROUTE_CONTINUE: 'pre_route.continue',

  // Dispatch
  DISPATCH_ROUTE: 'dispatch.route',
  DISPATCH_ENTITY_COMPLETE: 'dispatch.entity.complete',
  DISPATCH_HYBRID_COMPLETE: 'dispatch.hybrid.complete',
  DISPATCH_MIXED_COMPLETE: 'dispatch.mixed.complete',

  // Retrieval / ranking
  RETRIEVAL_HYBRID_CANDIDATES_START: 'retrieval.hybrid_candidates.start',
  RETRIEVAL_PRODUCER_BROWSE: 'retrieval.producer_browse',
  RETRIEVAL_REGION_BROWSE: 'retrieval.region_browse',
  RETRIEVAL_COMPARE_CANDIDATES: 'retrieval.compare_candidates',
  RETRIEVAL_CANDIDATE_POOL_FALLBACK: 'retrieval.candidate_pool.fallback',
  RETRIEVAL_CANDIDATE_POOL_ASSEMBLED: 'retrieval.candidate_pool.assembled',
  RETRIEVAL_CRITIC_BUDGET_EXHAUSTED: 'retrieval.critic.budget_exhausted',
  RETRIEVAL_CRITIC_DECISION: 'retrieval.critic.decision',
  RETRIEVAL_CRITIC_REWRITER_DECLINED: 'retrieval.critic.rewriter_declined',
  RETRIEVAL_CRITIC_RETRIES_EXHAUSTED: 'retrieval.critic.retries_exhausted',
  RETRIEVAL_BUNDLE_SELECTOR_ENGAGE: 'retrieval.bundle_selector.engage',
  RETRIEVAL_BUNDLE_SELECTOR_SUBQUERY_FAIL_CLOSED: 'retrieval.bundle_selector.subquery_fail_closed',
  RETRIEVAL_BUNDLE_SELECTOR_FAIL_CLOSED: 'retrieval.bundle_selector.fail_closed',
  RETRIEVAL_BUNDLE_SELECTOR_BUDGET_VIOLATION: 'retrieval.bundle_selector.budget_violation',
  RANKING_HYBRID_COMPLETE: 'ranking.hybrid.complete',

  // Post-route / decision
  POST_ROUTE_ENTER: 'post_route.enter',
  POST_ROUTE_ENTROPY_ABSTAIN: 'post_route.entropy_abstain',
  POST_ROUTE_ENTROPY_ABSTAIN_BYPASSED: 'post_route.entropy_abstain_bypassed',
  DECISION_PHASE_ENTER: 'decision.phase.enter',
  DECISION_ENGINE_REQUEST: 'decision.engine.request',
  DECISION_ENGINE_RESPONSE: 'decision.engine.response',
  CACHE_SET_SKIPPED: 'cache.set_skipped',

  // Hybrid use case
  HYBRID_EXECUTE_START: 'hybrid.execute.start',
  HYBRID_EXECUTE_RANKED: 'hybrid.execute.ranked',

  // Batch
  BATCH_SEARCH_START: 'batch.search.start',

  // Resolve / interpret
  RESOLVE_USE_CASE_START: 'resolve.use_case.start',
  RESOLVE_CONSTRAINT_SAT_CONTRADICTED: 'resolve.constraint_sat.contradicted',
  RESOLVE_USE_CASE_DONE: 'resolve.use_case.done',
  INTERPRET_PLANNER_DONE: 'interpret.planner.done',

  // Infrastructure HTTP
  HTTP_EMBEDDING_OK: 'http.embedding.ok',
  HTTP_EMBEDDING_HTTP_ERROR: 'http.embedding.http_error',
  HTTP_EMBEDDING_TIMEOUT: 'http.embedding.timeout',
  HTTP_EMBEDDING_NETWORK_ERROR: 'http.embedding.network_error',
  HTTP_EMBEDDING_PARSE_ERROR: 'http.embedding.parse_error',

  HTTP_RERANKER_OK: 'http.reranker.ok',
  HTTP_RERANKER_HTTP_ERROR: 'http.reranker.http_error',
  HTTP_RERANKER_TIMEOUT: 'http.reranker.timeout',
  HTTP_RERANKER_NETWORK_ERROR: 'http.reranker.network_error',
  HTTP_RERANKER_PARSE_ERROR: 'http.reranker.parse_error',

  VESPA_QUERY: 'vespa.query',
} as const;

export type PipelineDebugStepId = (typeof PipelineDebugStep)[keyof typeof PipelineDebugStep];

/**
 * T-E10-02: Canonical pipeline stages for shortfall timeline reconstruction.
 *
 * Each stage groups related `PipelineDebugStep` values and documents the
 * fields that MUST be present when that step is emitted. Operators and
 * agents use this to detect gaps — a missing stage in the log means the
 * pipeline exited early or degraded before reaching that point.
 *
 * The human-readable table is in `.ai/pipeline-debug-steps.md`.
 */
export const PIPELINE_STAGE_ORDER = [
  'search_entry',
  'pre_route',
  'resolve_interpret',
  'route_dispatch',
  'entity_route',
  'hybrid_execution',
  'retrieval',
  'anchor_resolution',
  'ranking',
  'decision',
  'post_route',
  'completion',
  'batch',
  'infra_http',
] as const;

type PipelineStage = (typeof PIPELINE_STAGE_ORDER)[number];

/**
 * Maps each pipeline stage to the step IDs that belong to it.
 * Used for shortfall timeline analysis: given a set of observed steps,
 * determine which stages were reached and which were skipped.
 */
export const PIPELINE_STAGE_STEPS: Readonly<Record<PipelineStage, readonly PipelineDebugStepId[]>> = {
  search_entry: [
    PipelineDebugStep.SEARCH_EXECUTE_START,
    PipelineDebugStep.SEARCH_PRE_ROUTE_EARLY_EXIT,
    PipelineDebugStep.SEARCH_ROUTE_RESOLUTION,
    PipelineDebugStep.SEARCH_EXECUTE_STAGE_TIMINGS,
  ],
  pre_route: [
    PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON,
    PipelineDebugStep.PRE_ROUTE_CONSTRAINT_CONTRADICTION,
    PipelineDebugStep.PRE_ROUTE_CACHE_HIT,
    PipelineDebugStep.PRE_ROUTE_CONTINUE,
  ],
  resolve_interpret: [
    PipelineDebugStep.RESOLVE_USE_CASE_START,
    PipelineDebugStep.RESOLVE_CONSTRAINT_SAT_CONTRADICTED,
    PipelineDebugStep.RESOLVE_USE_CASE_DONE,
    PipelineDebugStep.INTERPRET_PLANNER_DONE,
  ],
  route_dispatch: [
    PipelineDebugStep.DISPATCH_ROUTE,
    PipelineDebugStep.DISPATCH_ENTITY_COMPLETE,
    PipelineDebugStep.DISPATCH_HYBRID_COMPLETE,
    PipelineDebugStep.DISPATCH_MIXED_COMPLETE,
  ],
  entity_route: [
    PipelineDebugStep.ROUTE_ENTITY_ONLY_START,
    PipelineDebugStep.ROUTE_ENTITY_ONLY_DONE,
    PipelineDebugStep.ROUTE_ENTITY_CORRECTIVE_RETRY_START,
    PipelineDebugStep.ROUTE_ENTITY_CORRECTIVE_RETRY_CANDIDATES,
  ],
  hybrid_execution: [
    PipelineDebugStep.HYBRID_EXECUTE_START,
    PipelineDebugStep.HYBRID_EXECUTE_RANKED,
  ],
  retrieval: [
    PipelineDebugStep.RETRIEVAL_HYBRID_CANDIDATES_START,
    PipelineDebugStep.RETRIEVAL_PRODUCER_BROWSE,
    PipelineDebugStep.RETRIEVAL_REGION_BROWSE,
    PipelineDebugStep.RETRIEVAL_COMPARE_CANDIDATES,
    PipelineDebugStep.RETRIEVAL_CANDIDATE_POOL_FALLBACK,
    PipelineDebugStep.RETRIEVAL_CANDIDATE_POOL_ASSEMBLED,
    PipelineDebugStep.RETRIEVAL_CRITIC_BUDGET_EXHAUSTED,
    PipelineDebugStep.RETRIEVAL_CRITIC_DECISION,
    PipelineDebugStep.RETRIEVAL_CRITIC_REWRITER_DECLINED,
    PipelineDebugStep.RETRIEVAL_CRITIC_RETRIES_EXHAUSTED,
    PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_ENGAGE,
    PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_SUBQUERY_FAIL_CLOSED,
    PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_FAIL_CLOSED,
    PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_BUDGET_VIOLATION,
  ],
  anchor_resolution: [
    PipelineDebugStep.RESOLVER_ANCHOR_MISSING,
    PipelineDebugStep.RESOLVER_ANCHOR_START,
    PipelineDebugStep.RESOLVER_ANCHOR_DONE,
  ],
  ranking: [
    PipelineDebugStep.RANKING_HYBRID_COMPLETE,
  ],
  decision: [
    PipelineDebugStep.DECISION_PHASE_ENTER,
    PipelineDebugStep.DECISION_ENGINE_REQUEST,
    PipelineDebugStep.DECISION_ENGINE_RESPONSE,
  ],
  post_route: [
    PipelineDebugStep.POST_ROUTE_ENTER,
    PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN,
    PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN_BYPASSED,
    PipelineDebugStep.CACHE_SET_SKIPPED,
  ],
  completion: [
    PipelineDebugStep.SEARCH_EXECUTE_DONE,
  ],
  batch: [
    PipelineDebugStep.BATCH_SEARCH_START,
  ],
  infra_http: [
    PipelineDebugStep.HTTP_EMBEDDING_OK,
    PipelineDebugStep.HTTP_EMBEDDING_HTTP_ERROR,
    PipelineDebugStep.HTTP_EMBEDDING_TIMEOUT,
    PipelineDebugStep.HTTP_EMBEDDING_NETWORK_ERROR,
    PipelineDebugStep.HTTP_EMBEDDING_PARSE_ERROR,
    PipelineDebugStep.HTTP_RERANKER_OK,
    PipelineDebugStep.HTTP_RERANKER_HTTP_ERROR,
    PipelineDebugStep.HTTP_RERANKER_TIMEOUT,
    PipelineDebugStep.HTTP_RERANKER_NETWORK_ERROR,
    PipelineDebugStep.HTTP_RERANKER_PARSE_ERROR,
    PipelineDebugStep.VESPA_QUERY,
  ],
} as const;
