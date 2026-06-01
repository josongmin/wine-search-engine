import { describe, it, expect } from 'vitest';
import { buildPlannerContextFromSearchRequest } from '../search-usecase-planner-context.js';
import type { SearchRequest } from '../search-request.dto.js';

/**
 * RFC-021 T-PSA-03 — the public primitive discovery routes set a
 * `retrievalLane`; that path authority must thread into the planner context as
 * `lockDiscoveryLane` so the planner cannot promote the request onto the
 * entity/mixed lanes. A request WITHOUT a lane (agent/batch/planner-auto) must
 * NOT lock the lane.
 */
describe('buildPlannerContextFromSearchRequest — lockDiscoveryLane', () => {
  it('locks the lane when the request carries a path-selected retrievalLane', () => {
    const req: SearchRequest = { query: '오푸스원 같은 와인', retrievalLane: 'hybrid' };
    expect(buildPlannerContextFromSearchRequest(req).lockDiscoveryLane).toBe(true);
  });

  it('locks the lane for semantic_only and lexical_only primitives', () => {
    for (const lane of ['semantic_only', 'lexical_only'] as const) {
      const req: SearchRequest = { query: 'q', retrievalLane: lane };
      expect(buildPlannerContextFromSearchRequest(req).lockDiscoveryLane).toBe(true);
    }
  });

  it('does NOT lock the lane for a plain (planner-auto) request', () => {
    const req: SearchRequest = { query: '오푸스원 같은 와인' };
    expect(buildPlannerContextFromSearchRequest(req).lockDiscoveryLane).toBeUndefined();
  });
});
