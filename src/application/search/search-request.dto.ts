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
}
