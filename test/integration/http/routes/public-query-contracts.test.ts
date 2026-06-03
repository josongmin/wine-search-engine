import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import {
  HybridSearchRouteContract,
  LexicalSearchRouteContract,
  SemanticSearchRouteContract,
} from '../../../../src/interface/http/routes/route-contracts.js';

// NOTE: POST /v1/lookup/wine was removed in the V2-only lookup cutover
// (catalog 8.0.0). The sole public lookup surface is POST /v2/entity-lookup,
// whose contract is asserted in the entity-lookup-v2 route tests.
describe('public query route contracts', () => {
  it('declares RFC-014 error responses for the canonical public query primitives', () => {
    expect(HybridSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(SemanticSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
    expect(LexicalSearchRouteContract.responses[403]).toBe(ErrorResponseSchema);
  });

  it('declares cooperative-abort (408) error responses for primitive search', () => {
    expect(HybridSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(SemanticSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
    expect(LexicalSearchRouteContract.responses[408]).toBe(ErrorResponseSchema);
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
  });
});
