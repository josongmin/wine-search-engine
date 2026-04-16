import type { EngineDecision } from './engine-decision.js';
import type { ResultItem } from './result-item.js';
import type { CounterfactualReject, ResponseMeta } from './counterfactual.js';
import type { ClarificationPayload } from './clarification.js';
import type { RetrievalMode } from '../../query/model/retrieval-mode.js';

/**
 * External representation of parsed constraints for LLM consumption.
 * Flattens ConstraintBundle into an easy-to-interpret structure (Epic 9).
 */
export interface ParsedConstraintsExtern {
  /** Hard constraints that must be satisfied. */
  readonly hard: ReadonlyArray<{
    readonly field: string;
    readonly op: string;
    readonly value: string;
  }>;

  /** Soft constraints that should be satisfied but can be relaxed. */
  readonly soft: ReadonlyArray<{
    readonly field: string;
    readonly op: string;
    readonly value: string;
  }>;

  /** Constraint phrases that could not be parsed into structured form. */
  readonly unparsed: readonly string[];
}

/**
 * **SearchResponseV1** — the Single Source of Truth (SSOT) output of the
 * Wine Intelligence Engine.
 *
 * Every API response is a serialisation of this interface. Downstream
 * consumers (API gateway, front-end, analytics) read exclusively from
 * this structure and never re-derive engine decisions.
 *
 * Discriminator: queryType = 'search' (vs 'comparison' for ComparisonSearchResponse).
 * Enables type-safe union handling via discriminated unions.
 */
export interface SearchResponseV1 {
  /** Discriminator for discriminated union with ComparisonSearchResponse. */
  readonly queryType: 'search';

  /** The engine's resolution decision for this query. */
  readonly engineDecision: EngineDecision;

  /** Ordered list of result items, highest relevance first. */
  readonly results: readonly ResultItem[];

  /** Candidates that were evaluated but rejected, with reasons. */
  readonly counterfactuals?: readonly CounterfactualReject[] | undefined;

  /** Clarification payload when the engine needs user input. */
  readonly clarification?: ClarificationPayload | null | undefined;

  /** Response-level metadata (timing, versioning, debug refs). */
  readonly meta: ResponseMeta;

  /** Retrieval mode used for this query (for LLM envelope analysis). */
  readonly retrievalMode?: RetrievalMode | undefined;

  /**
   * Result type inferred from results and decision.
   * Helps LLM clients understand the structural nature of the response (Epic 9 & 8).
   * Includes entity-set grouping types from Epic 8 (producer_set, region_set, style_set, wine_set).
   */
  readonly resultType?:
    | 'single_entity'
    | 'entity_set'
    | 'comparison'
    | 'no_match'
    | 'producer_set'
    | 'region_set'
    | 'style_set'
    | 'wine_set'
    | undefined;

  /**
   * User and inferred constraints in external format, parsed for LLM consumption (Epic 9).
   * Omitted if no constraints were present in the query.
   */
  readonly parsedConstraints?: ParsedConstraintsExtern | undefined;

  /**
   * Per-stage latency breakdown from the StageTimer, in milliseconds.
   * Populated when a StageTimer was active during the request.
   * Keys follow the stage naming convention: `search.total`, `retrieval.sparse_bm25`, etc.
   * Only present in responses built through the main search pipeline.
   */
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
}
