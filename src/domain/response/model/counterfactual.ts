import type { EntityId, DecisionSnapshot } from '../../shared/types/index.js';

/**
 * A candidate that was considered but ultimately rejected, with the reason.
 * Included in the response for transparency and debugging.
 */
export interface CounterfactualReject {
  /** Entity that was rejected. */
  readonly entityId: EntityId;

  /** Display label for the rejected entity (when available). */
  readonly canonicalLabel?: string | undefined;

  /** Human-readable reason this entity was not included in results. */
  readonly rejectedReason: string;

  /** Optional reference to the evidence item that led to rejection. */
  readonly evidenceRef?: string | undefined;
}

/**
 * Top-level metadata attached to every {@link SearchResponseV1}.
 */
export interface ResponseMeta {
  /** Caller-supplied request identifier for correlation. */
  readonly requestId?: string | undefined;

  /** Wall-clock time (ms) from query receipt to response assembly. */
  readonly queryTimeMs: number;

  /** Execution route label (e.g. "hybrid", "exact"). */
  readonly route: string;

  /** Semantic version of the response format. */
  readonly version: string;

  /**
   * Schema identifier for the response envelope — RFC-014 §4.2 contract.
   * Always `"search_response_v1"` for this version of the API.
   */
  readonly engine_schema_version: string;

  /** Optional decision snapshot for external reproducibility. */
  readonly decisionSnapshot?: DecisionSnapshot | undefined;

  /** Optional debug reference strings for pipeline tracing. */
  readonly debugRefs?: readonly string[] | undefined;
}
