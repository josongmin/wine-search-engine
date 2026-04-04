import type { Resolver, ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { Planner, PlannerContext } from '../../domain/query/service/planner.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';

/**
 * Entity resolve request shape.
 */
export interface ResolveRequest {
  readonly query: string;
  readonly context?: {
    readonly locale: string;
    readonly currency: string;
  } | undefined;
  readonly sessionContext?: {
    readonly sessionId: string;
    readonly previousEntities: string[];
  } | undefined;
}

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
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
}

/**
 * Entity resolve use case — runs only entity resolution (no ranking/decision).
 *
 * Returns the resolve result with status, candidates, and a decision_trace_ref.
 */
export class ResolveUseCase {
  constructor(private readonly deps: ResolveUseCaseDeps) {}

  async execute(request: ResolveRequest): Promise<ResolveResponse> {
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

    const plan = await this.deps.queryPlanner.plan(request.query, plannerContext);

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
    const traceRef = `resolve:${plan.queryClass}:${String(Date.now())}`;

    return {
      status: result.status,
      candidates: result.candidates,
      topEntity: result.topEntity,
      decision_trace_ref: traceRef,
    };
  }
}
