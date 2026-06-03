import type { QueryPlanV1, QueryPlanV2 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { RetrievalMode } from '../../domain/query/model/retrieval-mode.js';
import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../domain/query/model/threshold-profile.js';
import { ExecutionCompiler } from '../../domain/query/service/execution-compiler.js';
import {
  buildNormalizedQueryViews,
  normalizeQueryStrict,
} from '../../domain/query/service/query-normalizer.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { SearchRequest } from './search-request.dto.js';

const CALLER_CONTROLLED_PLANNER_VERSION = 'caller-controlled-v1';
const CALLER_CONTROLLED_POLICY_RULE_VERSION = 'caller-controlled-v1';
const CALLER_CONTROLLED_REASON_CODE = 'CALLER_CONTROLLED_PRIMITIVE_SEARCH';
const SIMILAR_TO_ENTITY_PLANNER_VERSION = 'similar-to-entity-path-v1';
const SIMILAR_TO_ENTITY_POLICY_RULE_VERSION = 'similar-to-entity-path-v1';
const SIMILAR_TO_ENTITY_REASON_CODE = 'SIMILAR_TO_ENTITY_PATH_AUTHORITY';
/** Reference-similarity executes on the locked mixed/anchor-similarity solver
 *  (`src/domain/mixed/service/mixed-solver.ts` — REUSE-family lock). The
 *  `similar_items` retrieval mode triggers same-entity exclusion + producer
 *  diversity in that solver's core, so the primitive inherits deterministic
 *  exclusion/dedup without forking a parallel similarity runtime. */
const SIMILAR_TO_ENTITY_ROUTE: QueryRoute = 'mixed';
const DEFAULT_CALLER_CONTROLLED_MODE = 'auto';
/** The hybrid lane is the only route this builder ever emits — entity/mixed
 *  modes have their own caller-bypassing paths upstream and are explicitly
 *  rejected by {@link isCallerControlledPrimitiveSearchRequest}. */
const CALLER_CONTROLLED_ROUTE: QueryRoute = 'hybrid';
const executionCompiler = new ExecutionCompiler();

/**
 * Subset of `SearchRequest['retrieval_mode']` that this builder admits.
 * `entity` and `mixed` are intentionally excluded — they require anchor /
 * identity-seal evidence that the caller-controlled fast-path does not
 * gather. Restricting the type at module scope lets TypeScript exhaustively
 * narrow the downstream switch instead of carrying dead `entity`/`mixed`
 * branches that the runtime gate already prevents from executing.
 */
type CallerControlledAdmittedMode = 'auto' | 'hybrid';

function resolveRequestedMode(
  request: SearchRequest,
): NonNullable<SearchRequest['retrieval_mode']> {
  return request.retrieval_mode ?? request.options?.mode ?? DEFAULT_CALLER_CONTROLLED_MODE;
}

function isAdmittedMode(
  mode: NonNullable<SearchRequest['retrieval_mode']>,
): mode is CallerControlledAdmittedMode {
  return mode === 'auto' || mode === 'hybrid';
}

function resolveCallerControlledRetrievalMode(request: SearchRequest): RetrievalMode {
  const callerInterpretation = request.callerInterpretation;
  if (callerInterpretation?.intent === 'pairing_search') {
    return 'recommendation';
  }
  if (
    callerInterpretation?.intent === 'facet_search'
    || callerInterpretation?.intent === 'budget_search'
    || callerInterpretation?.queryClass === 'pure_constraint'
  ) {
    return 'constraint_filter';
  }
  return 'attribute_search';
}

function buildPrimitiveConstraints(request: SearchRequest) {
  return {
    hard: [...(request.filters ?? [])],
    soft: [...(request.preferences ?? [])],
    inferred: [],
  } as const;
}

function buildPrimitiveQueryScaffold(
  request: SearchRequest,
  sanitizedQuery: string,
) {
  const constraints = buildPrimitiveConstraints(request);
  const normalizedQueryViews = buildNormalizedQueryViews(sanitizedQuery);
  const normalizedQuery = normalizeQueryStrict(sanitizedQuery);
  return {
    constraints,
    normalizedQuery,
    normalizedQueryViews,
    planV2Base: {
      rawQuery: sanitizedQuery,
      normalizedQuery,
      normalizedQueryViews,
      anchors: [],
      constraints,
      expansions: {
        lexical: [],
        semantic: [],
      },
      uncertainty: {
        overall: 0,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low' as const,
        decisionEffect: 'trace_only' as const,
        parserConfidence: 1,
        anchorConfidence: 1,
        constraintConfidence: 1,
      },
      ...(request.queryBudget !== undefined ? { queryBudget: request.queryBudget } : {}),
      retrievalPlan: buildRetrievalPlan(constraints),
      retrievalObjective: buildRetrievalObjective(constraints),
    },
  };
}

export function isCallerControlledPrimitiveSearchRequest(
  request: SearchRequest,
): boolean {
  if (request.callerInterpretation?.authority !== 'caller') {
    return false;
  }
  return isAdmittedMode(resolveRequestedMode(request));
}

export function buildCallerControlledPrimitivePlan(
  request: SearchRequest,
  sanitizedQuery: string,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  if (request.callerInterpretation?.authority !== 'caller') {
    throw new Error('Caller-controlled primitive plan requires callerInterpretation.authority=caller');
  }

  const mode = resolveRequestedMode(request);
  if (!isAdmittedMode(mode)) {
    // Defensive: callers should gate via `isCallerControlledPrimitiveSearchRequest`
    // before reaching this point. We throw rather than silently down-routing
    // because entity/mixed modes have semantic admission contracts
    // (identity-seal, anchor evidence) that the caller-controlled fast-path
    // does not satisfy.
    throw new Error(
      `Caller-controlled primitive plan does not support retrieval mode=${mode}; only 'auto' or 'hybrid' are admitted.`,
    );
  }
  void mode; // narrowing complete — actual route is the module-scope constant.

  const route = CALLER_CONTROLLED_ROUTE;
  const retrievalMode = resolveCallerControlledRetrievalMode(request);
  const { constraints, planV2Base } = buildPrimitiveQueryScaffold(request, sanitizedQuery);
  // Hybrid-only fast-path: identity-seal and anchor evidence requirements are
  // structural to entity/mixed routes, which this builder explicitly does not
  // admit. The constraint-evidence flag still fires when the caller injected
  // hard filters.
  const admissionContext = {
    requires_identity_seal: false,
    requires_constraint_evidence: constraints.hard.length > 0,
    requires_anchor_evidence: false,
  } as const;
  const planV2: QueryPlanV2 = {
    ...planV2Base,
    intent: request.callerInterpretation.intent,
    queryClass: request.callerInterpretation.queryClass,
    plannerVersion: CALLER_CONTROLLED_PLANNER_VERSION,
    policyRuleVersion: CALLER_CONTROLLED_POLICY_RULE_VERSION,
    thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
    admission_context: admissionContext,
    suggestedRoute: route,
    suggestedRetrievalMode: retrievalMode,
  };

  const plan: QueryPlanV1 = {
    rawQuery: planV2.rawQuery,
    normalizedQuery: planV2.normalizedQuery,
    normalizedQueryViews: planV2.normalizedQueryViews,
    intent: planV2.intent,
    route,
    retrievalMode,
    queryClass: planV2.queryClass,
    anchors: planV2.anchors,
    constraints: planV2.constraints,
    expansions: planV2.expansions,
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'hybrid',
      policyReasonCodes: [CALLER_CONTROLLED_REASON_CODE],
    },
    uncertainty: planV2.uncertainty,
    plannerVersion: planV2.plannerVersion,
    policyRuleVersion: planV2.policyRuleVersion,
    thresholdProfileId: planV2.thresholdProfileId,
    ...(planV2.admission_context !== undefined ? { admission_context: planV2.admission_context } : {}),
    ...(planV2.queryBudget !== undefined ? { queryBudget: planV2.queryBudget } : {}),
  };

  const compiled = executionCompiler.compile({
    plan: planV2,
    apiRouteOverride: route,
    maxCandidatesOverride: request.queryBudget?.maxCandidates,
  });

  return { plan, compiled };
}

/**
 * RFC-021 T-PSA-01: gate for the deterministic reference-similarity primitive.
 * Path-authoritative — fires only when the front-door adapter set the internal
 * `primitiveRoute` marker AND supplied a resolved anchor entity. Requiring both
 * means a stray `primitiveRoute` without an anchor never silently degrades into
 * a free-text similarity search.
 */
export function isSimilarToEntityPrimitiveSearchRequest(
  request: SearchRequest,
): boolean {
  return (
    request.primitiveRoute === 'similar_to_entity'
    && request.anchorEntityId !== undefined
  );
}

/**
 * Build the caller/path-authoritative execution plan for `similar_to_entity`.
 *
 * The anchor authority is `request.anchorEntityId` (a resolved canonical
 * entity), NOT the query text. We seed it directly into `plan.anchors[0]` with
 * `source: 'entity_lookup'` and `confidence: 1` so the mixed solver
 * ({@link ../../domain/mixed/service/mixed-solver.ts}) resolves the entity by id
 * — never by re-parsing a name — then excludes that seed entity and applies
 * producer diversity in its `similar_items` core path. route=`mixed` /
 * retrievalMode=`similar_items` are fixed here; the planner is bypassed
 * entirely so similarity semantics cannot be overridden by intent heuristics.
 */
export function buildSimilarToEntityPrimitivePlan(
  request: SearchRequest,
  sanitizedQuery: string,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  if (request.primitiveRoute !== 'similar_to_entity') {
    throw new Error('Similar-to-entity primitive plan requires primitiveRoute=similar_to_entity');
  }
  const anchorEntityId = request.anchorEntityId;
  if (anchorEntityId === undefined) {
    throw new Error('Similar-to-entity primitive plan requires a resolved anchorEntityId');
  }

  const route = SIMILAR_TO_ENTITY_ROUTE;
  const retrievalMode: RetrievalMode = 'similar_items';
  const { constraints, planV2Base } = buildPrimitiveQueryScaffold(request, sanitizedQuery);

  // Seed the resolved anchor directly. `entity_lookup` source records that the
  // anchor came from an upstream id resolution, not from in-query alias
  // extraction — this is what makes the path deterministic and free-text-free.
  const anchorCandidate: AnchorCandidate = {
    surfaceForm: anchorEntityId,
    normalizedForm: anchorEntityId,
    candidateEntityIds: [anchorEntityId],
    confidence: 1,
    source: 'entity_lookup',
  };
  const anchors: readonly AnchorCandidate[] = [anchorCandidate];

  const admissionContext = {
    requires_identity_seal: true,
    requires_constraint_evidence: constraints.hard.length > 0,
    requires_anchor_evidence: true,
  } as const;
  const planV2: QueryPlanV2 = {
    ...planV2Base,
    anchors,
    intent: 'mixed_query',
    queryClass: 'anchored_similarity',
    plannerVersion: SIMILAR_TO_ENTITY_PLANNER_VERSION,
    policyRuleVersion: SIMILAR_TO_ENTITY_POLICY_RULE_VERSION,
    thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
    admission_context: admissionContext,
    suggestedRoute: route,
    suggestedRetrievalMode: retrievalMode,
  };

  const plan: QueryPlanV1 = {
    rawQuery: planV2.rawQuery,
    normalizedQuery: planV2.normalizedQuery,
    normalizedQueryViews: planV2.normalizedQueryViews,
    intent: planV2.intent,
    route,
    retrievalMode,
    queryClass: planV2.queryClass,
    anchors: planV2.anchors,
    constraints: planV2.constraints,
    expansions: planV2.expansions,
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'hybrid',
      policyReasonCodes: [SIMILAR_TO_ENTITY_REASON_CODE],
    },
    uncertainty: planV2.uncertainty,
    plannerVersion: planV2.plannerVersion,
    policyRuleVersion: planV2.policyRuleVersion,
    thresholdProfileId: planV2.thresholdProfileId,
    ...(planV2.admission_context !== undefined ? { admission_context: planV2.admission_context } : {}),
    ...(planV2.queryBudget !== undefined ? { queryBudget: planV2.queryBudget } : {}),
  };

  const compiled = executionCompiler.compile({
    plan: planV2,
    apiRouteOverride: route,
    maxCandidatesOverride: request.queryBudget?.maxCandidates,
  });

  return { plan, compiled };
}

