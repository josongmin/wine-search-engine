/**
 * Regression — entity-route anchor refresh (Wave 1 of the entity-route
 * structural fix; replaces the historical `lookup_wine → mode='hybrid'`
 * workaround from commit a344fe64; see memory `project_entity_route_broken`).
 *
 * Background. The planner extracts anchors at analysis time from the alias
 * matcher / KG. The PG alias overlay is loaded asynchronously per request.
 * For a class of queries (Latin-script wine labels like "Opus One",
 * "Almaviva 2019", and their Korean equivalents like "오푸스원") the
 * planner-stage anchor extraction returned zero anchors even though the
 * overlay contained matching canonical/translation rows. With no anchors
 * the entity route's resolver produced zero candidates and `entity_lookup`
 * silently degraded to 0 results.
 *
 * Fix. `PlannerV1Adapter` now accepts an optional `anchorRefresh` callback
 * that closes over the alias-overlay port. After the planner returns, when
 *   `effectiveRetrievalMode === 'entity_lookup'` AND `anchors.length === 0`
 * the adapter re-queries the overlay with the normalized query and merges
 * any recovered anchors back into the plan. The plan is re-compiled so
 * downstream consumers (entity route, observability) see a consistent
 * (anchors, route, mode, policy) tuple. When the refresh also returns
 * empty, the adapter falls through to the original 0-anchor plan with the
 * `no_alias_match` reason carried on the refresh result.
 *
 * Invariants exercised here:
 *   1. Refresh fires on (entity_lookup ∧ anchors.length === 0) and replaces
 *      the empty anchor set with the overlay-recovered set.
 *   2. Refresh returns no_match → original plan flows through unchanged
 *      (zero anchors, entity_lookup mode, reason surfaced).
 *   3. Non-entity_lookup modes never invoke the refresh callback (no-op
 *      guard — hybrid / similar_items / recommendation MUST NOT trigger
 *      the overlay re-query path).
 *   4. Refresh failures propagate (CLAUDE.md execution baseline: alias-
 *      overlay errors must not be silently swallowed).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PlannerV1Adapter,
  buildAnchorRefreshCallbackFromAliasOverlay,
} from '../../src/config/planner-v1-adapter.js';
import {
  ANCHOR_REFRESH_NO_MATCH_REASON,
  refreshAnchorsFromAliasOverlay,
  type AnchorRefreshAliasOverlayPort,
} from '../../src/domain/query/service/anchor-refresh.js';
import type { Planner } from '../../src/domain/query/service/planner.js';
import type { QueryPlanV2 } from '../../src/domain/query/model/query-plan.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

const OPUS_ONE_ID = 'opus-one-2018' as CanonicalEntityId;

function makeV2Plan(overrides: Partial<QueryPlanV2> = {}): QueryPlanV2 {
  return {
    rawQuery: 'Opus One',
    normalizedQuery: 'opus one',
    intent: 'entity_exact',
    suggestedRoute: 'entity',
    suggestedRetrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    uncertainty: {
      overall: 0.2,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.85,
      constraintConfidence: 0.9,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

function makePlanner(v2: QueryPlanV2): Planner {
  return { plan: vi.fn().mockResolvedValue(v2) } as unknown as Planner;
}

function makeOverlayWithMatch(): AnchorRefreshAliasOverlayPort {
  return {
    findMatches: vi.fn(async (_query: string) => [
      {
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        entityIds: [OPUS_ONE_ID],
        matchConfidence: 0.95,
      },
    ]),
  };
}

function makeEmptyOverlay(): AnchorRefreshAliasOverlayPort {
  return { findMatches: vi.fn(async (_query: string) => []) };
}

describe('PlannerV1Adapter — anchor refresh (entity-route safety net)', () => {
  it('refreshes anchors when entity_lookup mode has zero anchors and overlay has a match', async () => {
    const planner = makePlanner(makeV2Plan());
    const overlay = makeOverlayWithMatch();
    const adapter = new PlannerV1Adapter(planner, {
      anchorRefresh: buildAnchorRefreshCallbackFromAliasOverlay(overlay),
    });

    const result = await adapter.planWithCompiled('Opus One');

    expect(result.compiled.execution.effectiveRetrievalMode).toBe('entity_lookup');
    expect(result.v1.anchors).toHaveLength(1);
    expect(result.v1.anchors[0]?.candidateEntityIds).toContain(OPUS_ONE_ID);
    expect(result.v1.anchors[0]?.source).toBe('alias');
    // The compiled snapshot must agree with V1 — same anchors, same mode.
    expect(result.compiled.query.anchors).toHaveLength(1);
    expect(result.compiled.query.anchors[0]?.candidateEntityIds).toContain(OPUS_ONE_ID);

    // Overlay was queried exactly once with the normalized surface.
    expect(overlay.findMatches).toHaveBeenCalledTimes(1);
    expect(overlay.findMatches).toHaveBeenCalledWith('opus one');
  });

  it('falls through unchanged when overlay has no match (surfaces no_alias_match)', async () => {
    const planner = makePlanner(makeV2Plan());
    const overlay = makeEmptyOverlay();
    const adapter = new PlannerV1Adapter(planner, {
      anchorRefresh: buildAnchorRefreshCallbackFromAliasOverlay(overlay),
    });

    const result = await adapter.planWithCompiled('Opus One');

    // Original plan flows through: zero anchors, entity_lookup mode preserved.
    expect(result.v1.anchors).toHaveLength(0);
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('entity_lookup');
    expect(overlay.findMatches).toHaveBeenCalledTimes(1);

    // The contract for the no-match reason is held by the domain service,
    // exercised directly here so future refactors of the callback shape
    // do not silently drop the diagnostic.
    const direct = await refreshAnchorsFromAliasOverlay(
      { normalizedQuery: 'opus one', existingAnchors: [] },
      overlay,
    );
    expect(direct.status).toBe('no_match');
    if (direct.status === 'no_match') {
      expect(direct.reason).toBe(ANCHOR_REFRESH_NO_MATCH_REASON);
      expect(direct.anchors).toEqual([]);
    }
  });

  it('does NOT invoke the refresh callback for non-entity_lookup modes', async () => {
    // hybrid / attribute_search / similar_items / recommendation — none of
    // these may trigger the overlay re-query because their retrieval lanes
    // do not require entity anchors. Picking attribute_search as the
    // representative exploratory mode.
    const planner = makePlanner(
      makeV2Plan({
        suggestedRoute: 'hybrid',
        suggestedRetrievalMode: 'attribute_search',
        intent: 'semantic_discovery',
        queryClass: 'semantic_preference',
      }),
    );
    const overlay = makeOverlayWithMatch();
    const adapter = new PlannerV1Adapter(planner, {
      anchorRefresh: buildAnchorRefreshCallbackFromAliasOverlay(overlay),
    });

    const result = await adapter.planWithCompiled('red wine with smoke');

    expect(result.compiled.execution.effectiveRetrievalMode).toBe('attribute_search');
    expect(result.v1.anchors).toHaveLength(0);
    expect(overlay.findMatches).not.toHaveBeenCalled();
  });

  it('does NOT invoke the refresh callback when entity_lookup mode already has anchors', async () => {
    const existing: AnchorCandidate = {
      surfaceForm: 'Opus One',
      normalizedForm: 'opus one',
      candidateEntityIds: [OPUS_ONE_ID],
      confidence: 0.95,
      source: 'alias',
    };
    const planner = makePlanner(makeV2Plan({ anchors: [existing] }));
    const overlay = makeOverlayWithMatch();
    const adapter = new PlannerV1Adapter(planner, {
      anchorRefresh: buildAnchorRefreshCallbackFromAliasOverlay(overlay),
    });

    const result = await adapter.planWithCompiled('Opus One');

    expect(result.v1.anchors).toEqual([existing]);
    expect(overlay.findMatches).not.toHaveBeenCalled();
  });

  it('propagates overlay errors instead of swallowing them', async () => {
    const planner = makePlanner(makeV2Plan());
    const overlay: AnchorRefreshAliasOverlayPort = {
      findMatches: vi.fn(async () => {
        throw new Error('alias overlay down');
      }),
    };
    const adapter = new PlannerV1Adapter(planner, {
      anchorRefresh: buildAnchorRefreshCallbackFromAliasOverlay(overlay),
    });

    await expect(adapter.planWithCompiled('Opus One')).rejects.toThrow('alias overlay down');
  });

  it('omits the refresh hook entirely when no callback is supplied (back-compat)', async () => {
    const planner = makePlanner(makeV2Plan());
    const adapter = new PlannerV1Adapter(planner); // no options

    const result = await adapter.planWithCompiled('Opus One');

    expect(result.v1.anchors).toHaveLength(0);
    expect(result.compiled.execution.effectiveRetrievalMode).toBe('entity_lookup');
  });
});

describe('refreshAnchorsFromAliasOverlay — direct unit coverage', () => {
  it('preserves existing planner anchors and appends only new refresh matches', async () => {
    const existing: AnchorCandidate = {
      surfaceForm: 'Opus One',
      normalizedForm: 'opus one',
      candidateEntityIds: [OPUS_ONE_ID],
      confidence: 0.7,
      source: 'planner_heuristic',
      lookupVariants: ['opus'],
    };
    const overlay: AnchorRefreshAliasOverlayPort = {
      // First row matches the existing anchor by (normalizedForm, entityIds)
      // and must be DROPPED (dedup); second row is genuinely new.
      findMatches: vi.fn(async () => [
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: [OPUS_ONE_ID],
          matchConfidence: 0.95,
        },
        {
          surfaceForm: 'Opvs One',
          normalizedForm: 'opvs one',
          entityIds: ['opus-one-vintage-rare' as CanonicalEntityId],
          matchConfidence: 0.82,
        },
      ]),
    };

    const result = await refreshAnchorsFromAliasOverlay(
      { normalizedQuery: 'opus one', existingAnchors: [existing] },
      overlay,
    );

    expect(result.status).toBe('refreshed');
    if (result.status === 'refreshed') {
      // Original anchor is first (preserved as-is — keeps planner_heuristic provenance).
      expect(result.anchors[0]).toBe(existing);
      // Only the new (non-duplicate) row was appended.
      expect(result.anchors).toHaveLength(2);
      expect(result.anchors[1]?.normalizedForm).toBe('opvs one');
      expect(result.refreshedCount).toBe(1);
    }
  });

  it('returns no_match when the normalized query is empty or whitespace only', async () => {
    const overlay = makeOverlayWithMatch();

    const empty = await refreshAnchorsFromAliasOverlay(
      { normalizedQuery: '', existingAnchors: [] },
      overlay,
    );
    expect(empty.status).toBe('no_match');
    expect(overlay.findMatches).not.toHaveBeenCalled();

    const blank = await refreshAnchorsFromAliasOverlay(
      { normalizedQuery: '   ', existingAnchors: [] },
      overlay,
    );
    expect(blank.status).toBe('no_match');
    expect(overlay.findMatches).not.toHaveBeenCalled();
  });

  it('drops overlay matches with empty entityIds (cannot anchor an empty candidate)', async () => {
    const overlay: AnchorRefreshAliasOverlayPort = {
      findMatches: vi.fn(async () => [
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: [],
          matchConfidence: 0.5,
        },
      ]),
    };

    const result = await refreshAnchorsFromAliasOverlay(
      { normalizedQuery: 'opus one', existingAnchors: [] },
      overlay,
    );

    expect(result.status).toBe('no_match');
    expect(result.anchors).toEqual([]);
  });
});
