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
const executionCompiler = new ExecutionCompiler();

function resolveRequestedMode(
  request: SearchRequest,
): NonNullable<SearchRequest['retrieval_mode']> {
  return request.retrieval_mode ?? request.options?.mode ?? DEFAULT_CALLER_CONTROLLED_MODE;
}

function resolveCallerControlledRoute(mode: NonNullable<SearchRequest['retrieval_mode']>): QueryRoute {
  switch (mode) {
    case 'entity':
      return 'entity';
    case 'mixed':
      return 'mixed';
    case 'auto':
    case 'hybrid':
      return 'hybrid';
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled caller-controlled search mode: ${String(_exhaustive)}`);
    }
  }
}

function resolveCallerControlledRetrievalMode(
  request: SearchRequest,
  route: QueryRoute,
): RetrievalMode {
  const callerInterpretation = request.callerInterpretation;
  switch (route) {
    case 'entity':
      return 'entity_lookup';
    case 'mixed':
      return 'similar_items';
    case 'hybrid':
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
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unhandled caller-controlled route: ${String(_exhaustive)}`);
    }
  }
}

export function isCallerControlledPrimitiveSearchRequest(
  request: SearchRequest,
): boolean {
  if (request.callerInterpretation?.authority !== 'caller') {
    return false;
  }
  const mode = resolveRequestedMode(request);
  return mode !== 'entity' && mode !== 'mixed';
}

export function buildCallerControlledPrimitivePlan(
  request: SearchRequest,
  sanitizedQuery: string,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  if (request.callerInterpretation?.authority !== 'caller') {
    throw new Error('Caller-controlled primitive plan requires callerInterpretation.authority=caller');
  }

  const mode = resolveRequestedMode(request);
  const route = resolveCallerControlledRoute(mode);
  const retrievalMode = resolveCallerControlledRetrievalMode(request, route);
  const normalizedQueryViews = buildNormalizedQueryViews(sanitizedQuery);
  const constraints = {
    hard: [...(request.filters ?? [])],
    soft: [...(request.preferences ?? [])],
    inferred: [],
  } as const;
  const admissionContext = {
    requires_identity_seal: route === 'entity' || route === 'mixed',
    requires_constraint_evidence: constraints.hard.length > 0,
    requires_anchor_evidence: route === 'mixed',
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
