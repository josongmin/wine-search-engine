/**
 * Wine knowledge graph (Epic-11) — typed graph of wine-domain entities and
 * relationships, used by entity resolver, ontology expansion, compositional
 * inference, and Phase B retrieval features.
 *
 * The graph is intentionally a small, deterministic, replayable artifact:
 * nodes/edges are immutable after construction, and the loader validates
 * that there are no orphan edges or is_a/part_of cycles.
 */

export type WineKGNodeType =
  | 'wine'
  | 'producer'
  | 'region'
  | 'sub_region'
  | 'appellation'
  | 'country'
  | 'grape'
  | 'grape_family'
  | 'wine_type'
  | 'style'
  | 'occasion';

export type WineKGEdgeType =
  | 'is_a'
  | 'part_of'
  | 'produces'
  | 'made_from'
  | 'belongs_to'
  | 'has_style'
  | 'typical_for'
  | 'pairs_with';

export interface WineKGNode {
  readonly id: string;
  readonly type: WineKGNodeType;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly attributes?: Readonly<Record<string, string | number>>;
}

export interface WineKGEdge {
  readonly from: string;
  readonly to: string;
  readonly type: WineKGEdgeType;
  /** Optional weight in [0, 1] — confidence or strength of the relationship. */
  readonly weight?: number;
}

export interface WineKG {
  readonly version: string;
  readonly nodes: ReadonlyMap<string, WineKGNode>;
  readonly edges: readonly WineKGEdge[];
}
