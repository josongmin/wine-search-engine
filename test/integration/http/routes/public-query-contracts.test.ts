import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import {
  LookupRouteContract,
  SearchRouteContract,
} from '../../../../src/interface/http/routes/route-contracts.js';

describe('public query route contracts', () => {
  it('declares RFC-014 error responses for the canonical public query endpoints', () => {
    expect(SearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(LookupRouteContract.responses[403]).toBe(ErrorResponseSchema);
  });

  it('declares cooperative-abort (408) error responses for search and lookup', () => {
    expect(SearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(LookupRouteContract.responses[408]).toBe(ErrorResponseSchema);
  });

  it('pins the canonical query capability matrix in route contract metadata', () => {
    expect(SearchRouteContract.capabilities).toEqual([
      'security',
      'decomposition',
      'planner',
      'SAT',
      'cache',
      'route_resolution',
      'ranked_post_route',
    ]);
    expect(LookupRouteContract.capabilities).toEqual([
      'security',
      'planner',
      'SAT',
      'cache',
      'resolver_only',
    ]);
  });
});
