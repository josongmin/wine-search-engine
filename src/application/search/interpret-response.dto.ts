/**
 * Application-owned wire-shape contract for the V2 interpret/explain response.
 *
 * DIP / layering: the interpret use case and its adapter (application layer)
 * own this output contract. The HTTP interface layer's Zod schema
 * (`interface/http/schemas/search-response-v2.schema.ts`) re-states the SAME
 * shape at runtime and pins assignability against THIS type at compile time, so
 * the wire bytes cannot drift from the application contract. The dependency
 * arrow therefore points interface → application (inward), never the reverse.
 *
 * This is a STRUCTURAL type mirror — field names and optionality are identical
 * to the Zod-inferred `InterpretResponseV2`. It carries no runtime validation
 * (that stays in the interface layer where the HTTP boundary is enforced).
 */

/**
 * V2 interpret/explain contract.
 *
 * Surfaces what the planner detected and which signals/channels were
 * activated. NOT a planner internals dump. Retained for internal
 * explain/diagnostic projections; there is no public V2 explain URL.
 */
export interface InterpretResponseV2 {
  queryId: string;
  queryText: string;
  /** Query-family label from planner observability (e.g. entity_exact, comparison, pairing). */
  detectedIntent: string;
  /** Decomposition strategy when query was split into sub-queries. */
  decompositionStrategy?: string | undefined;
  /** Retrieval channel names that were activated for this query. */
  activeChannels: string[];
  /** Constraint labels that were applied during query planning. */
  appliedConstraints: string[];
  /** Ranking signal names that influenced scoring for this query. */
  rankingSignals: string[];
  /** Planner confidence in the detected intent, in [0, 1]. Omitted when uncertainty input is invalid. */
  confidence?: number | undefined;
  version: '2';
  responseType: 'interpret';
}
