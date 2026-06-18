/**
 * Entity Lookup V2 — producer family graph port (T-ELV2-06 Half B).
 *
 * A snapshot-scoped adjacency of entities that share a normalized PRODUCER key
 * (e.g. all wines by the same producer). The retrieval engine walks from an
 * alias-recalled anchor to its persisted family and emits the siblings as a
 * dedicated `family_graph` recall channel, and the reranker reads the edge
 * weight as `familyGraphProximity`.
 *
 * Mirrors the AmbiguityDictionary port contract: implementations MAY return an
 * empty result when the substrate is unavailable (missing table / no active
 * snapshot) — same graceful-degradation discipline, so the channel is simply
 * dormant until the family graph is published. Pure domain port (no I/O type).
 */

export interface FamilySibling {
  /** A co-producer entity (NOT the anchor itself). */
  readonly entityId: string;
  /**
   * Graph-derived proximity in [0,1): `1 - 1/familySize` (the SSoT
   * {@link ambiguityClusterMembershipScore}). Larger families → stronger signal.
   */
  readonly edgeWeight: number;
}

export interface FamilyGraphPort {
  /**
   * Sibling entities sharing a producer family with `entityId` for the active
   * snapshot, EXCLUDING the anchor itself. Empty when the entity has no known
   * family or the substrate is unavailable.
   */
  getFamilySiblings(entityId: string, signal?: AbortSignal): Promise<readonly FamilySibling[]>;

  /**
   * Optional batch variant — collapses N anchor lookups into one round-trip
   * (the engine resolves a family for every alias-recalled anchor). Keyed by the
   * input entity id; absent keys have no family.
   */
  getFamilySiblingsBatch?(
    entityIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly FamilySibling[]>>;
}
