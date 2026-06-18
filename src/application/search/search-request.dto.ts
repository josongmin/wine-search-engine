import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';
import type { CanonicalEntityId } from '../../domain/shared/types/entity-id.js';
import type { WineSearchCallerInterpretation } from '../wine-search/wine-search-schemas.js';

/**
 * Caller-controlled search interpretation contract.
 *
 * Re-exports the Zod-inferred shape from
 * {@link wine-search-schemas.ts} so the application has a single source of
 * truth for the field set (CLAUDE.md rule 30). Previously this module
 * declared a parallel interface that drifted silently from the Zod schema —
 * any new field on the schema (e.g. `confidence`) would be silently dropped
 * when the route mapper composed a `SearchRequest`. The re-export pins both
 * sides to the same definition.
 */
export type CallerSearchInterpretation = WineSearchCallerInterpretation;

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

export interface RepresentativeConceptSearchContext {
  readonly field: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
  readonly value: string;
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
  /**
   * Internal retrieval-lane discriminator set by the path-authoritative
   * primitive HTTP routes (`/v1/search/{hybrid,semantic,lexical}`). When set,
   * `SearchUseCase` forwards it into `RequestExecutionContext.retrievalLane`,
   * and `CandidatePoolService.applyRetrievalLaneFilter` honours it as a hard
   * cap on active channels:
   *   - `'semantic_only'` → dense (+anchor) channels only; sparse/learned-sparse dropped
   *   - `'lexical_only'`  → sparse (+learned-sparse) channels only; dense/anchor dropped
   *   - `'hybrid'` / absent → full RRF channel mix
   * NEVER populated from a request body — this is route-authoritative
   * (architecture-decision §2.2 — primitive selector is path, not body).
   */
  readonly retrievalLane?: 'hybrid' | 'semantic_only' | 'lexical_only' | undefined;
  /**
   * Internal primitive-route authority marker set only by dedicated entry
   * surfaces whose URL path semantically fixes the execution contract.
   *
   * Current use (V2-only cutover removed the `lookup_wine` arm — exact entity
   * lookup is now exclusively the EntityLookupV2 use case / `/v2/entity-lookup`):
   * - `similar_to_entity` → RFC-021 deterministic reference-similarity primitive
   *   ("wines like {entity_id}"). The anchor authority is {@link anchorEntityId},
   *   NOT the query string — the plan builder fixes route=`mixed` /
   *   retrievalMode=`similar_items` and seeds the anchor directly, so no
   *   free-text re-resolution occurs.
   *
   * NEVER populate from a request body. This is an application-internal
   * dispatch signal owned by the front-door adapter.
   */
  readonly primitiveRoute?: 'similar_to_entity' | undefined;
  /**
   * Resolved canonical anchor entity for the `similar_to_entity` primitive
   * route. This — not {@link query} — is the similarity anchor authority
   * (RFC-021 T-PSA-01): the plan builder seeds it into `plan.anchors` so the
   * mixed solver resolves the entity directly and excludes it from results,
   * with no free-text anchor extraction. Only meaningful when
   * `primitiveRoute === 'similar_to_entity'`.
   */
  readonly anchorEntityId?: CanonicalEntityId | undefined;
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
  /**
   * Typed marker for comparison concept legs. The concept identity itself is a
   * representative-set objective, not an exact hard gate.
   */
  readonly representativeConcept?: RepresentativeConceptSearchContext | undefined;
  /**
   * Explicit front-door authority override for agent/tool lanes that already
   * decided the search should execute as a raw retrieval primitive rather than
   * re-entering planner intent/routing.
   */
  readonly callerInterpretation?: CallerSearchInterpretation | undefined;
}
