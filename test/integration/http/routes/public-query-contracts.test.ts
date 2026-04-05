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
});
