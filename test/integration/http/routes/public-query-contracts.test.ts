import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import {
  HybridRouteContract,
  InterpretRouteContract,
  ResolveRouteContract,
  SearchRouteContract,
} from '../../../../src/interface/http/routes/route-contracts.js';

describe('public query route contracts', () => {
  it('declares RFC-014 error responses for policy-blocked public query endpoints', () => {
    expect(SearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(HybridRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(InterpretRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(ResolveRouteContract.responses[403]).toBe(ErrorResponseSchema);
  });

  it('declares cooperative-abort (408) error responses for search-family endpoints', () => {
    expect(SearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(HybridRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(InterpretRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(ResolveRouteContract.responses[408]).toBe(ErrorResponseSchema);
  });

  it('pins the search-family capability matrix in route contract metadata', () => {
    expect(SearchRouteContract.capabilities).toEqual([
      'security',
      'decomposition',
      'planner',
      'SAT',
      'cache',
      'route_resolution',
      'ranked_post_route',
    ]);
    expect(HybridRouteContract.capabilities).toEqual([
      'security',
      'decomposition',
      'planner',
      'SAT',
      'cache',
      'forced_hybrid_retrieval',
      'ranked_post_route',
    ]);
    expect(InterpretRouteContract.capabilities).toEqual([
      'security',
      'planner_only',
    ]);
    expect(ResolveRouteContract.capabilities).toEqual([
      'security',
      'planner',
      'SAT',
      'resolver_only',
    ]);
  });
});
