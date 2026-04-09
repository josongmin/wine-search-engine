import type { WineKG, WineKGNode, WineKGEdge, WineKGEdgeType } from '../model/wine-kg.js';

/** Maximum BFS depth — bounds traversal cost on adversarial graphs. */
const DEFAULT_MAX_DEPTH = 8;

export interface KGTraversalResult {
  readonly node: WineKGNode;
  readonly path: readonly WineKGEdgeType[];
  readonly distance: number;
}

export interface CompositionalInference {
  readonly attribute: string;
  readonly value: string;
  readonly confidence: number;
  readonly provenance: string;
}

/** Hardcoded compositional rules until KG-derived priors replace them. */
interface CompositionalRule {
  readonly when: readonly string[];
  readonly emit: { attribute: string; value: string; confidence: number };
  readonly id: string;
}
const COMPOSITIONAL_RULES: readonly CompositionalRule[] = [
  {
    id: 'bordeaux_red_grape_family',
    when: ['region:bordeaux', 'wine_type:red'],
    emit: { attribute: 'grape_family', value: 'Cabernet,Merlot', confidence: 0.85 },
  },
  {
    id: 'burgundy_red_grape_family',
    when: ['region:burgundy', 'wine_type:red'],
    emit: { attribute: 'grape_family', value: 'Pinot Noir', confidence: 0.9 },
  },
  {
    id: 'champagne_implies_sparkling',
    when: ['region:champagne'],
    emit: { attribute: 'wine_type', value: 'sparkling', confidence: 0.95 },
  },
  {
    id: 'champagne_implies_france',
    when: ['region:champagne'],
    emit: { attribute: 'country', value: 'France', confidence: 0.99 },
  },
];

export class KGOperations {
  private readonly aliasIndex: ReadonlyMap<string, string>;
  private readonly outEdges: ReadonlyMap<string, readonly WineKGEdge[]>;

  constructor(private readonly kg: WineKG) {
    const aliasMap = new Map<string, string>();
    for (const [id, node] of kg.nodes) {
      aliasMap.set(node.canonical.toLowerCase(), id);
      for (const alias of node.aliases) {
        aliasMap.set(alias.toLowerCase(), id);
      }
    }
    this.aliasIndex = aliasMap;

    const outMap = new Map<string, WineKGEdge[]>();
    for (const edge of kg.edges) {
      const list = outMap.get(edge.from) ?? [];
      list.push(edge);
      outMap.set(edge.from, list);
    }
    this.outEdges = outMap;
  }

  getNode(id: string): WineKGNode | undefined {
    return this.kg.nodes.get(id);
  }

  resolveAlias(surfaceForm: string): WineKGNode | undefined {
    const id = this.aliasIndex.get(surfaceForm.toLowerCase().trim());
    if (id === undefined) return undefined;
    return this.kg.nodes.get(id);
  }

  neighbors(nodeId: string, edgeType?: WineKGEdgeType): readonly WineKGNode[] {
    const edges = this.outEdges.get(nodeId);
    if (edges === undefined) return [];
    const out: WineKGNode[] = [];
    for (const edge of edges) {
      if (edgeType !== undefined && edge.type !== edgeType) continue;
      const target = this.kg.nodes.get(edge.to);
      if (target !== undefined) out.push(target);
    }
    return out;
  }

  traverse(
    nodeId: string,
    maxDepth: number = DEFAULT_MAX_DEPTH,
    edgeTypes?: readonly WineKGEdgeType[],
  ): readonly KGTraversalResult[] {
    if (this.kg.nodes.get(nodeId) === undefined) return [];
    const visited = new Set<string>([nodeId]);
    const queue: { id: string; path: WineKGEdgeType[]; distance: number }[] = [
      { id: nodeId, path: [], distance: 0 },
    ];
    const results: KGTraversalResult[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.distance > 0) {
        const node = this.kg.nodes.get(cur.id)!;
        results.push({ node, path: cur.path, distance: cur.distance });
      }
      if (cur.distance >= maxDepth) continue;
      const edges = this.outEdges.get(cur.id);
      if (edges === undefined) continue;
      for (const edge of edges) {
        if (edgeTypes !== undefined && !edgeTypes.includes(edge.type)) continue;
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push({
          id: edge.to,
          path: [...cur.path, edge.type],
          distance: cur.distance + 1,
        });
      }
    }
    return results;
  }

  ancestors(nodeId: string): readonly WineKGNode[] {
    const results = this.traverse(nodeId, DEFAULT_MAX_DEPTH, ['is_a', 'part_of']);
    return results.map((r) => r.node);
  }

  inferCompositional(mentionedIds: readonly string[]): readonly CompositionalInference[] {
    const mentionSet = new Set(mentionedIds.map((s) => s.toLowerCase()));
    const out: CompositionalInference[] = [];
    for (const rule of COMPOSITIONAL_RULES) {
      const allPresent = rule.when.every((req) => mentionSet.has(req));
      if (allPresent) {
        out.push({
          attribute: rule.emit.attribute,
          value: rule.emit.value,
          confidence: rule.emit.confidence,
          provenance: `compositional_rule:${rule.id}`,
        });
      }
    }
    return out;
  }
}
