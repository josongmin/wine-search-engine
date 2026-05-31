import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import {
  HybridSearchRouteContract,
  LexicalSearchRouteContract,
  LookupWineRouteContract,
  SemanticSearchRouteContract,
} from '../../../../src/interface/http/routes/route-contracts.js';

describe('public query route contracts', () => {
  it('declares RFC-014 error responses for the canonical public query primitives', () => {
    expect(HybridSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(SemanticSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(LexicalSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(LookupWineRouteContract.responses[403]).toBe(ErrorResponseSchema);
  });

  it('declares cooperative-abort (408) error responses for primitive search and lookup', () => {
    expect(HybridSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(SemanticSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(LexicalSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(LookupWineRouteContract.responses[408]).toBe(ErrorResponseSchema);
  });

  it('pins the canonical query capability matrix in route contract metadata', () => {
    expect(HybridSearchRouteContract.capabilities).toEqual([
      'security',
      'planner',
      'SAT',
      'cache',
      'route_resolution',
      'ranked_post_route',
    ]);
    expect(SemanticSearchRouteContract.capabilities).toEqual(HybridSearchRouteContract.capabilities);
    expect(LexicalSearchRouteContract.capabilities).toEqual(HybridSearchRouteContract.capabilities);
    expect(LookupWineRouteContract.capabilities).toEqual([
      'security',
      'planner',
      'SAT',
      'cache',
      'resolver_only',
    ]);
  });
});
