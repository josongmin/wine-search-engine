import type { ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import type {
  EntityDocumentLookupPort,
  EntityResolverPort,
  QueryPlannerPort,
} from './port/search-pipeline-deps.port.js';
import type { ResolveRequest } from './resolve-request.dto.js';
import type { ResolveResponse } from './resolve-response.dto.js';
import { buildResolverCandidatesFromPlan } from './search-usecase-resolver-candidates.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate } from './search-usecase-security-gate.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../observability/request-pipeline-debug.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import type { SnapshotVersions } from './search.usecase.js';
import type { DecisionStatus, NextAction } from '../../domain/shared/types/index.js';

export type { ResolveRequest } from './resolve-request.dto.js';
export type { ResolveResponse } from './resolve-response.dto.js';

/**
 * Dependencies injected into the ResolveUseCase.
 */
export interface ResolveUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  readonly snapshotVersions?: SnapshotVersions | undefined;
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('Resolve use case aborted');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Entity resolve use case — runs only entity resolution (no ranking/decision).
 *
 * Returns the resolve result with status, candidates, and a decision_trace_ref.
 */
export class ResolveUseCase {
  private readonly constraintSAT = new ConstraintSAT();

  constructor(private readonly deps: ResolveUseCaseDeps) {}

  async execute(
    request: ResolveRequest,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<ResolveResponse> {
    throwIfAborted(options?.abortSignal);

    pipelineDebug(
      {
        step: 'resolve.use_case.start',
        query_preview: sanitizeQueryForDebug(request.query),
        ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
      },
      'pipeline resolve-only',
    );

    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    throwIfAborted(options?.abortSignal);

    const plan = await this.deps.queryPlanner.plan(
      effectiveQuery,
      buildPlannerContextFromSearchRequest({
        query: effectiveQuery,
        context: request.context,
        sessionContext: request.sessionContext,
        queryBudget: request.queryBudget,
      }),
    );

    throwIfAborted(options?.abortSignal);

    const satResult = this.constraintSAT.check(plan.constraints);
    if (satResult.contradicted) {
      pipelineDebug(
        {
          step: 'resolve.constraint_sat.contradicted',
          query_class: plan.queryClass,
        },
        'pipeline resolve-only early exit',
      );
      const snapshot = buildDecisionSnapshotFromPlan(plan, this.deps.snapshotVersions);
      const traceRef = buildAuthorityTraceRef({
        queryPlan: plan,
        snapshot,
        route: 'entity',
        decisionStatus: 'failed',
        nextAction: 'fail',
        failureReason: 'HARD_CONSTRAINT_VIOLATION',
      });

      return {
        status: 'failed',
        candidates: [],
        topEntity: undefined,
        decision_trace_ref: traceRef,
        authority_trace_ref: traceRef,
        ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
      };
    }

    throwIfAborted(options?.abortSignal);

    // Build resolver input
    const candidateEntities = await buildResolverCandidatesFromPlan(
      plan,
      this.deps.entityLookup,
    );

    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities,
    };

    throwIfAborted(options?.abortSignal);

    // Run entity resolver
    const result = await this.deps.entityResolver.resolve(resolverInput);

    pipelineDebug(
      {
        step: 'resolve.use_case.done',
        resolve_status: result.status,
        candidate_count: result.candidates.length,
        has_top_entity: result.topEntity !== undefined,
      },
      'pipeline resolve-only',
    );

    const snapshot = buildDecisionSnapshotFromPlan(plan, this.deps.snapshotVersions);
    const decisionStatus = result.status;
    const nextAction = mapResolveStatusToNextAction(decisionStatus);
    const traceRef = buildAuthorityTraceRef({
      queryPlan: plan,
      snapshot,
      ...(result.topEntity !== undefined ? { chosenEntityId: result.topEntity.entityId } : {}),
      route: 'entity',
      decisionStatus,
      nextAction,
    });

    return {
      status: result.status,
      candidates: result.candidates,
      topEntity: result.topEntity,
      decision_trace_ref: traceRef,
      authority_trace_ref: traceRef,
      ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
    };
  }
}

function mapResolveStatusToNextAction(status: DecisionStatus): NextAction {
  switch (status) {
    case 'resolved':
      return 'return_result';
    case 'ambiguous':
      return 'clarify';
    case 'failed':
    default:
      return 'fail';
  }
}
