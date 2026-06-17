import { describe, expect, it } from 'vitest';
import { countScopeGraphEdgesByRelation } from '../../../src/domain/resolver/v2/scope-graph-substrate.js';

describe('countScopeGraphEdgesByRelation', () => {
  it('counts only edges matching the requested relation kind', () => {
    const adjacency = new Map([
      ['a', [
        { targetEntityId: 'b', relationKind: 'family' as const, weight: 1 },
        { targetEntityId: 'c', relationKind: 'line' as const, weight: 1 },
      ]],
      ['b', [
        { targetEntityId: 'a', relationKind: 'family' as const, weight: 1 },
      ]],
    ]);

    expect(countScopeGraphEdgesByRelation(adjacency, 'family')).toBe(2);
    expect(countScopeGraphEdgesByRelation(adjacency, 'line')).toBe(1);
    expect(countScopeGraphEdgesByRelation(adjacency, 'vintage')).toBe(0);
  });
});
