import type {
  EntityScopeGraphPort,
  LookupScopeGraphEdge,
  LookupScopeGraphRelationKind,
} from '../../domain/resolver/v2/entity-scope-graph.port.js';
import type { LookupSemanticEntityDescriptor } from '../../domain/resolver/v2/lookup-semantic-scope.js';
import { countScopeGraphEdgesByRelation } from '../../domain/resolver/v2/scope-graph-substrate.js';

export class SearchSnapshotEntityScopeGraph implements EntityScopeGraphPort {
  constructor(
    private readonly adjacency: ReadonlyMap<string, readonly LookupScopeGraphEdge[]>,
    private readonly descriptors: ReadonlyMap<string, LookupSemanticEntityDescriptor>,
  ) {}

  getRelatedEntities(
    entityId: string,
    relationKind: LookupScopeGraphRelationKind,
  ): Promise<readonly LookupScopeGraphEdge[]> {
    return Promise.resolve(
      (this.adjacency.get(entityId) ?? []).filter((edge) => edge.relationKind === relationKind),
    );
  }

  getRelatedEntitiesBatch(
    entityIds: readonly string[],
    relationKind: LookupScopeGraphRelationKind,
  ): Promise<ReadonlyMap<string, readonly LookupScopeGraphEdge[]>> {
    const related = new Map<string, readonly LookupScopeGraphEdge[]>();
    for (const entityId of entityIds) {
      const edges = (this.adjacency.get(entityId) ?? []).filter((edge) => edge.relationKind === relationKind);
      if (edges.length > 0) {
        related.set(entityId, edges);
      }
    }
    return Promise.resolve(related);
  }

  getSemanticDescriptor(
    entityId: string,
  ): LookupSemanticEntityDescriptor | undefined {
    return this.descriptors.get(entityId);
  }

  countEdgesByRelation(relationKind: LookupScopeGraphRelationKind): number {
    return countScopeGraphEdgesByRelation(this.adjacency, relationKind);
  }
}
