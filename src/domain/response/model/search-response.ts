import type { EngineDecision } from './engine-decision.js';
import type { ResultItem } from './result-item.js';
import type { CounterfactualReject, ResponseMeta } from './counterfactual.js';
import type { ClarificationPayload } from './clarification.js';

/**
 * **SearchResponseV1** — the Single Source of Truth (SSOT) output of the
 * Wine Intelligence Engine.
 *
 * Every API response is a serialisation of this interface. Downstream
 * consumers (API gateway, front-end, analytics) read exclusively from
 * this structure and never re-derive engine decisions.
 */
export interface SearchResponseV1 {
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
}
