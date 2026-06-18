import type { LookupScopeGraphEdge, LookupScopeGraphRelationKind } from './entity-scope-graph.port.js';

/**
 * Count scope-graph edges for a relation kind — used for bootstrap observability
 * when `family_graph` would otherwise fire with `hitCount: 0` silently.
 */
export function countScopeGraphEdgesByRelation(
  adjacency: ReadonlyMap<string, readonly LookupScopeGraphEdge[]>,
  relationKind: LookupScopeGraphRelationKind,
): number {
  let count = 0;
  for (const edges of adjacency.values()) {
    for (const edge of edges) {
      if (edge.relationKind === relationKind) {
        count += 1;
      }
    }
  }
  return count;
}
