import type { ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { EntityResolverPort, QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { ResolveRequest } from './resolve-request.dto.js';
import { QueryEntrySecurityGate } from './query-entry-security.js';

export type { ResolveRequest } from './resolve-request.dto.js';

/**
 * Entity resolve response shape.
 */
export interface ResolveResponse {
  readonly status: string;
  readonly candidates: EntityResolveResult['candidates'];
  readonly topEntity: EntityResolveResult['topEntity'];
  readonly decision_trace_ref: string;
}

/**
 * Dependencies injected into the ResolveUseCase.
 */
export interface ResolveUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
}

/**
 * Entity resolve use case — runs only entity resolution (no ranking/decision).
 *
 * Returns the resolve result with status, candidates, and a decision_trace_ref.
 */
export class ResolveUseCase {
  constructor(private readonly deps: ResolveUseCaseDeps) {}

  async execute(request: ResolveRequest): Promise<ResolveResponse> {
    const securityGate = new QueryEntrySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    // Plan the query to extract anchors and context
    const plannerContext: PlannerContext = {
      locale: request.context?.locale,
      session: request.sessionContext
        ? {
            sessionId: request.sessionContext.sessionId,
            previousEntities: request.sessionContext.previousEntities as EntityId[],
          }
        : undefined,
    };

    const plan = await this.deps.queryPlanner.plan(effectiveQuery, plannerContext);

    // Build resolver input
    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities: [],
    };

    // Run entity resolver
    const result = await this.deps.entityResolver.resolve(resolverInput);

    // Build trace ref
    const traceRef = request.requestId !== undefined
      ? `resolve:${request.requestId}:${plan.queryClass}`
      : `resolve:${plan.queryClass}`;

    return {
      status: result.status,
      candidates: result.candidates,
      topEntity: result.topEntity,
      decision_trace_ref: traceRef,
    };
  }
}
