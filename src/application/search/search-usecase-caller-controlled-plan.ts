import type { QueryPlanV1, QueryPlanV2 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { RetrievalMode } from '../../domain/query/model/retrieval-mode.js';
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
  const normalizedQueryViews = buildNormalizedQueryViews(sanitizedQuery);
  const constraints = {
    hard: [...(request.filters ?? [])],
    soft: [...(request.preferences ?? [])],
    inferred: [],
  } as const;
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
    rawQuery: sanitizedQuery,
    normalizedQuery: normalizeQueryStrict(sanitizedQuery),
    normalizedQueryViews,
    intent: request.callerInterpretation.intent,
    queryClass: request.callerInterpretation.queryClass,
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
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 1,
      anchorConfidence: 1,
      constraintConfidence: 1,
    },
    plannerVersion: CALLER_CONTROLLED_PLANNER_VERSION,
    policyRuleVersion: CALLER_CONTROLLED_POLICY_RULE_VERSION,
    thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
    ...(request.queryBudget !== undefined ? { queryBudget: request.queryBudget } : {}),
    retrievalPlan: buildRetrievalPlan(constraints),
    retrievalObjective: buildRetrievalObjective(constraints),
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
