import type { LookupSemanticEntityDescriptor } from './lookup-semantic-scope.js';

export const LOOKUP_SCOPE_GRAPH_RELATION_KINDS = ['family', 'line', 'vintage'] as const;
export type LookupScopeGraphRelationKind = (typeof LOOKUP_SCOPE_GRAPH_RELATION_KINDS)[number];

export interface LookupScopeGraphEdge {
  readonly targetEntityId: string;
  readonly relationKind: LookupScopeGraphRelationKind;
  readonly weight: number;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly vintage?: number | undefined;
}

export interface EntityScopeGraphPort {
  getRelatedEntities(
    entityId: string,
    relationKind: LookupScopeGraphRelationKind,
    signal?: AbortSignal,
  ): Promise<readonly LookupScopeGraphEdge[]>;

  getRelatedEntitiesBatch?(
    entityIds: readonly string[],
    relationKind: LookupScopeGraphRelationKind,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly LookupScopeGraphEdge[]>>;

  getSemanticDescriptor?(
    entityId: string,
  ): LookupSemanticEntityDescriptor | undefined;

  countEdgesByRelation?(
    relationKind: LookupScopeGraphRelationKind,
  ): number;
}
