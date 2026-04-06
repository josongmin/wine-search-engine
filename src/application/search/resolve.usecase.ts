import type { ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
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

export type { ResolveRequest } from './resolve-request.dto.js';
export type { ResolveResponse } from './resolve-response.dto.js';

/**
 * Dependencies injected into the ResolveUseCase.
 */
export interface ResolveUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
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
    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    const plan = await this.deps.queryPlanner.plan(
      effectiveQuery,
      buildPlannerContextFromSearchRequest({
        query: effectiveQuery,
        context: request.context,
        sessionContext: request.sessionContext,
      }),
    );

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
      ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
    };
  }
}
