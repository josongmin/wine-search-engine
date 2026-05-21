/**
 * Regression: Search use-case fallback paths MUST declare
 * `calibrationTrusted: false` on their EntityResolveResult.decisionTrace.
 *
 * Root cause:
 *   `ResolverDecisionTrace.calibrationTrusted` (boolean) gates the
 *   AdmissionGate's confidence-refusal enforcement (RFC-016 §3, Epic 17.3).
 *   When `false`, the refusal floor is intentionally skipped because the
 *   value of `decisionConfidenceC` is a raw score, not a calibrated
 *   probability — refusing it against a fixed threshold would convert the
 *   hallucination guard into a quasi-random gate. When the field is
 *   `undefined`, the runtime check `if (!trusted)` matches the missing case
 *   and **silently skips** refusal even on paths that should be gated.
 *
 *   When `ResolverDecisionTrace` was extended with `calibrationTrusted`,
 *   three fallback construction sites in `src/application/search/*` were
 *   never updated, leaving their `decisionTrace.calibrationTrusted` as
 *   `undefined` at runtime. The bug is invisible to e2e tests (refusal is
 *   already wired to be permissive) but breaks the contract: the admission
 *   gate cannot tell whether the resolver ever ran a calibrator on this
 *   path.
 *
 * Contract under test (does not over-fit to a magic value):
 *   - Every fallback EntityResolveResult emitted by search use-case
 *     construction helpers MUST set `decisionTrace.calibrationTrusted`
 *     explicitly to `false`. These fallback paths either never invoke the
 *     calibrator (ranked-route uses the raw ranker score) or do so under
 *     degraded conditions (mixed-route fallback, hybrid missing-resolver),
 *     so the resulting `decisionConfidenceC` is not a trained-calibration
 *     probability.
 */

import { describe, expect, it } from 'vitest';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import { buildFailedMixedRouteExecution } from '../../src/application/search/search-usecase-mixed-route.js';
import { buildRankedRouteResolveResult } from '../../src/application/search/search-usecase-ranked-route-resolve.js';

function makeMinimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'unit-test',
    normalizedQuery: 'unit-test',
    queryFamily: 'attribute_constrained',
    intent: 'facet_search',
    queryClass: 'pure_constraint',
    suggestedRetrievalMode: 'attribute_search',
    suggestedRoute: 'hybrid',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { synonyms: [], related: [], ambiguousEntityHints: [] },
    policy: {
      requireIdentitySeal: false,
      requireConstraintEvidence: false,
      requireAnchorEvidence: false,
      allowSemanticFallback: true,
    },
    uncertainty: {
      anchorEntityUncertainty: 0,
      constraintParseUncertainty: 0,
      semanticAnchorUncertainty: 0,
      overall: 0,
    },
    ambiguity: { detected: false, types: [], severity: 'none' },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'heuristic-v1.0',
    plannerSnapshotRef: 'snapshot:test',
  };
}

function makeMinimalCompiled(plan: QueryPlanV1): CompiledWineQuery {
  return {
    plan,
    constraintBundle: { hard: [], soft: [], inferred: [] },
    retrievalPlan: {
      channels: [],
      candidatePool: { maxPerChannel: 50, totalCap: 200 },
    },
    execution: {
      effectiveRetrievalMode: 'attribute_search',
      executionTopology: 'general_only',
      budget: { maxCandidates: 50, perChannelTimeoutMs: 200, totalTimeoutMs: 1000 },
    },
  } as unknown as CompiledWineQuery;
}

describe('search-usecase fallback decisionTrace.calibrationTrusted contract', () => {
  it('buildFailedMixedRouteExecution declares calibrationTrusted=false', () => {
    const plan = makeMinimalPlan();
    const compiled = makeMinimalCompiled(plan);
    const execution = buildFailedMixedRouteExecution(plan, 'no_blocking_seeds', compiled);

    expect(execution.fusedResolveResult.decisionTrace).toHaveProperty('calibrationTrusted');
    expect(execution.fusedResolveResult.decisionTrace.calibrationTrusted).toBe(false);
  });

  it('buildRankedRouteResolveResult declares calibrationTrusted=false for general-only ranker output', () => {
    // The ranked-route path lifts the ranker's final score directly into
    // decisionConfidenceC without invoking a trained calibrator, so the
    // emitted decisionTrace must flag calibration as untrusted.
    const plan = makeMinimalPlan();
    const resolved = buildRankedRouteResolveResult(plan, [], {
      executionTopology: 'general_only',
      outcomeReasonCode: 'HYBRID_ROUTE',
    });

    expect(resolved.decisionTrace).toHaveProperty('calibrationTrusted');
    expect(resolved.decisionTrace.calibrationTrusted).toBe(false);
  });

  it('buildRankedRouteResolveResult declares calibrationTrusted=false for dual-lane ranker output without identity calibration', () => {
    const plan = makeMinimalPlan();
    const resolved = buildRankedRouteResolveResult(plan, [], {
      executionTopology: 'dual_lane',
      outcomeReasonCode: 'HYBRID_ROUTE',
    });

    expect(resolved.decisionTrace).toHaveProperty('calibrationTrusted');
    expect(resolved.decisionTrace.calibrationTrusted).toBe(false);
  });
});
