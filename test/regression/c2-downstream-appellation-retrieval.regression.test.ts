import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConstraintSAT } from '../../src/domain/query/service/constraint-sat.js';
import { QuerySanitizer } from '../../src/domain/security/service/query-sanitizer.js';
import { runSearchPreRoutePhase } from '../../src/application/search/search-usecase-pre-route-phase.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { SearchRequest } from '../../src/application/search/search-request.dto.js';
import type { QueryPlannerPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResponseBuilder } from '../../src/domain/response/service/response-builder.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';
import { buildRetrievalPlan } from '../../src/domain/retrieval/service/retrieval-plan-builder.js';
import { logSearchEvent } from '../../src/observability/log-search-event.js';

vi.mock('../../src/observability/log-search-event.js', () => ({
  logSearchEvent: vi.fn(),
}));

/**
 * C2-Downstream regression — bare-appellation queries (e.g. "바롤로",
 * "Pauillac", "Brunello") must NOT emit a hard `appellation` YQL filter.
 *
 * RCA: Vespa `wine_entity` schema declares `appellation` as
 * `summary | attribute | index`, but the live ETL leaves the field empty
 * on every indexed document (`appellation matches "."` → 0/11,367 hits).
 * Hard-filtering on it collapses the candidate pool to zero. The
 * pre-route phase must demote planner-extracted appellation hard
 * constraints to soft so lexical/semantic retrieval recovers candidates
 * via the populated `canonical_label` / `region` fields.
 *
 * Append-only regression: removing the demotion (or moving it to a
 * conditional branch that misses these queries) must fail this test.
 */

const APPELLATION_DEMOTION_MAPPING_VERSION = 'c2-downstream-appellation-demotion-v1';

function constraint(
  partial: Omit<NormalizedConstraint, 'source_phrase' | 'confidence'> &
    Partial<Pick<NormalizedConstraint, 'source_phrase' | 'confidence'>>,
): NormalizedConstraint {
  return {
    source_phrase: 'test',
    confidence: 0.9,
    ...partial,
  };
}

function buildPlanWithAppellationHard(rawQuery: string, canonical: string): QueryPlanV1 {
  return {
    rawQuery,
    normalizedQuery: rawQuery,
    intent: 'entity_exact' as const,
    route: 'hybrid' as const,
    retrievalMode: 'attribute_search' as const,
    queryClass: 'short_entity',
    anchors: [],
    constraints: {
      hard: [
        constraint({ attribute: 'appellation', operator: '=', value: canonical, mapping_version: 'entity-resolver-v1.0' }),
      ],
      soft: [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    admission_context: {
      requires_identity_seal: false,
      requires_constraint_evidence: true,
      requires_anchor_evidence: false,
    },
  } as QueryPlanV1;
}

function buildCompiledForPlan(plan: QueryPlanV1) {
  return {
    query: {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      intent: plan.intent,
      queryClass: plan.queryClass,
      anchors: plan.anchors,
      constraints: plan.constraints,
      expansions: plan.expansions,
      uncertainty: plan.uncertainty,
      plannerVersion: plan.plannerVersion,
      policyRuleVersion: plan.policyRuleVersion,
      thresholdProfileId: plan.thresholdProfileId,
      retrievalPlan: buildRetrievalPlan(plan.constraints),
    },
    execution: {
      effectiveRoute: 'hybrid' as const,
      effectiveRetrievalMode: 'attribute_search' as const,
      routeSource: 'planner' as const,
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
    },
  };
}

async function runPreRouteFor(plan: QueryPlanV1, request: SearchRequest) {
  const compiled = buildCompiledForPlan(plan);
  const queryPlanner: QueryPlannerPort = {
    plan: vi.fn(async () => plan),
    planWithCompiled: vi.fn(async () => ({ v1: plan, compiled })),
  };
  return runSearchPreRoutePhase({
    request,
    requestId: 'r-c2-downstream',
    startTime: Date.now(),
    snapshotVersions: undefined,
    securityGateDeps: { querySanitizer: new QuerySanitizer() },
    queryPlanner,
    responseBuilder: { build: vi.fn() } as unknown as ResponseBuilder,
    constraintSAT: new ConstraintSAT(),
    cacheService: undefined,
    decomposedSearch: undefined,
  });
}

describe('C2-Downstream regression: appellation hard → soft demotion', () => {
  beforeEach(() => {
    vi.mocked(logSearchEvent).mockClear();
  });

  describe.each([
    ['바롤로', 'Barolo'],
    ['Pauillac', 'Pauillac'],
    ['Brunello', 'Brunello di Montalcino'],
    ['브루넬로', 'Brunello di Montalcino'],
  ])('%s → appellation=%s', (rawQuery, canonical) => {
    it('demotes appellation hard constraint to soft', async () => {
      const plan = buildPlanWithAppellationHard(rawQuery, canonical);
      const result = await runPreRouteFor(plan, { query: rawQuery });
      expect(result.outcome).toBe('continue');
      if (result.outcome !== 'continue') return;

      // Hard appellation MUST be removed.
      expect(result.plan.constraints.hard.some((c) => c.attribute === 'appellation')).toBe(false);

      // Soft MUST now carry the demoted appellation with the dedicated
      // mapping_version tag (which keeps it OUT of the soft→hard promotion
      // allow-list in constraint-to-sparse-filter-tokens.ts).
      const demotedSoft = result.plan.constraints.soft.filter((c) => c.attribute === 'appellation');
      expect(demotedSoft.length).toBe(1);
      expect(demotedSoft[0]!.value).toBe(canonical);
      expect(demotedSoft[0]!.mapping_version).toBe(APPELLATION_DEMOTION_MAPPING_VERSION);

      // Compiled side must mirror the demotion so downstream retrieval sees
      // the new constraint bundle.
      expect(
        result.compiled.query.constraints.hard.some((c) => c.attribute === 'appellation'),
      ).toBe(false);
      expect(
        result.compiled.query.constraints.soft.some((c) => c.attribute === 'appellation'),
      ).toBe(true);

      // Provenance policy must downgrade `requireConstraintEvidence` to false
      // (no remaining hard constraints) so the decision layer does not flag
      // constraint-evidence shortfall on every Barolo query.
      expect(result.compiled.execution.provenancePolicy.requireConstraintEvidence).toBe(false);
      expect(result.plan.admission_context?.requires_constraint_evidence).toBe(false);
    });
  });

  it('preserves other hard constraints alongside the appellation demotion', async () => {
    const plan: QueryPlanV1 = {
      ...buildPlanWithAppellationHard('Barolo red wine', 'Barolo'),
      constraints: {
        hard: [
          constraint({ attribute: 'appellation', operator: '=', value: 'Barolo', mapping_version: 'entity-resolver-v1.0' }),
          constraint({ attribute: 'wine_type', operator: '=', value: 'red', mapping_version: 'rule-based-v1.0' }),
          constraint({ attribute: 'country', operator: '=', value: 'Italy', mapping_version: 'entity-resolver-v1.0' }),
        ],
        soft: [],
        inferred: [],
      },
    };
    const result = await runPreRouteFor(plan, { query: 'Barolo red wine' });
    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') return;

    const remainingHardAttrs = result.plan.constraints.hard.map((c) => c.attribute).sort();
    expect(remainingHardAttrs).toEqual(['country', 'wine_type']);

    // requires_constraint_evidence stays TRUE because non-appellation hard
    // constraints are still present.
    expect(result.compiled.execution.provenancePolicy.requireConstraintEvidence).toBe(true);
    expect(result.plan.admission_context?.requires_constraint_evidence).toBe(true);
  });

  it('is a no-op when the plan has no appellation hard constraint', async () => {
    const plan: QueryPlanV1 = {
      ...buildPlanWithAppellationHard('Italian wine', 'Barolo'),
      constraints: {
        hard: [constraint({ attribute: 'country', operator: '=', value: 'Italy', mapping_version: 'entity-resolver-v1.0' })],
        soft: [],
        inferred: [],
      },
    };
    const result = await runPreRouteFor(plan, { query: 'Italian wine' });
    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') return;
    expect(result.plan.constraints.hard.map((c) => c.attribute)).toEqual(['country']);
    expect(result.plan.constraints.soft.length).toBe(0);
  });

  it('demotes agent-supplied structured appellation filters as well (Vespa data limitation is source-agnostic)', async () => {
    const plan: QueryPlanV1 = buildPlanWithAppellationHard('Barolo', 'Barolo');
    // Reset the planner's hard bundle so the only appellation constraint comes
    // from the agent's structured filters.
    const planNoAppellation: QueryPlanV1 = {
      ...plan,
      constraints: { hard: [], soft: [], inferred: [] },
    };

    const agentAppellationFilter = constraint({
      attribute: 'appellation',
      operator: '=',
      value: 'Barolo',
      mapping_version: 'agent-structured-v1',
    });
    const result = await runPreRouteFor(planNoAppellation, {
      query: 'Barolo',
      filters: [agentAppellationFilter],
    });
    expect(result.outcome).toBe('continue');
    if (result.outcome !== 'continue') return;
    expect(result.plan.constraints.hard.some((c) => c.attribute === 'appellation')).toBe(false);
    expect(result.plan.constraints.soft.some((c) => c.attribute === 'appellation')).toBe(true);
  });
});
