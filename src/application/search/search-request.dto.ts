import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';

export interface SearchRequestContext {
  readonly locale: string;
  readonly currency: string;
}

export interface SearchSessionContext {
  readonly sessionId: string;
  readonly previousEntities: string[];
}

export interface SearchQueryBudget {
  readonly maxLatencyMs: number;
  readonly maxCandidates: number;
  readonly rerankLimit: number;
}

export interface SearchOptions {
  readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
  readonly explain: boolean;
  readonly clarification: boolean;
}

/**
 * Application-layer search request DTO.
 *
 * Kept separate from the HTTP schema so the route owns validation and the
 * application only depends on the minimal request shape it actually uses.
 */
export interface SearchRequest {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly options?: SearchOptions | undefined;
  /** Top-level retrieval mode override. 'auto' defers to the planner. */
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
  /** Maximum number of result items to return (batch / caller-specified cap). */
  readonly limit?: number | undefined;
  /**
   * Structured hard constraints injected by callers (agent tools, batch API).
   * Merged into the planner's ConstraintBundle.hard so they flow directly to
   * Vespa as YQL filter predicates — unlike text-encoded hints which depend
   * on the constraint extractor's regex matching.
   */
  readonly filters?: readonly NormalizedConstraint[] | undefined;
  /**
   * Structured preference constraints injected by callers.
   * These merge into ConstraintBundle.soft instead of hard YQL filters.
   */
  readonly preferences?: readonly NormalizedConstraint[] | undefined;
}
