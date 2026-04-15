/**
 * ADR-014 Phase 1b.3b: trivial-graph byte-identical parity gate.
 *
 * The most critical lock in the PR5 train. Guarantees that for any
 * query whose compiled graph is the deterministic Phase-1a projection
 * (single `group_and` root with every atom as a slot child), the
 * ranker produces byte-identical output to the graph-absent path for
 * every field that existed pre-PR5.
 *
 * New additive fields (`matchedAtomRefs`, `unmetAtomRefs` on the
 * graph-present path) are exempt from the byte-identical check.
 *
 * Build-breaker gate: any divergence fails CI.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { Ranker } from '../../src/domain/ranking/service/ranker.js';
import { SignalComputer } from '../../src/domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../../src/domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../../src/domain/ranking/service/evidence-mapper.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/index.js';
import type { RankingInput } from '../../src/domain/ranking/model/ranking-input.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../src/domain/shared/types/index.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

function makeCandidate(
  id: string,
  overrides: Partial<HybridCandidate> = {},
): HybridCandidate {
  return {
    entityId: id as CanonicalEntityId,
    canonicalLabel: `Wine ${id}`,
    retrievalFusionScore: 0.5,
    fusionRrfTotal: 0.5,
    sparseRank: 1,
    denseRank: 1,
    wineType: 'red',
    region: 'Bordeaux',
    matchedConstraints: ['wine_type', 'region'],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    },
    ...overrides,
  } as unknown as HybridCandidate;
}

function makePlan(constraints: ConstraintBundle): QueryPlanV1 {
  return {
    rawQuery: 'red bordeaux',
    normalizedQuery: 'red bordeaux',
    intent: 'semantic_preference',
    route: 'hybrid',
    queryClass: 'semantic_preference',
    anchors: [],
    constraints,
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'hybrid',
      policyReasonCodes: [],
    },
    uncertainty: { overall: 0.1, ambiguityDetected: false, ambiguitySeverity: 'low' },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  } as unknown as QueryPlanV1;
}

function makeCompiled(plan: QueryPlanV1, withGraph: boolean): CompiledWineQuery {
  const base: CompiledWineQuery = {
    query: {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      intent: plan.intent,
      queryClass: plan.queryClass,
      anchors: plan.anchors,
      constraints: plan.constraints,
      expansions: { lexical: [], semantic: [] },
      uncertainty: plan.uncertainty,
      plannerVersion: plan.plannerVersion,
      policyRuleVersion: plan.policyRuleVersion,
      thresholdProfileId: plan.thresholdProfileId,
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: plan.route,
      effectiveRetrievalMode: 'default',
      routeSource: 'planner',
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  } as unknown as CompiledWineQuery;

  if (!withGraph) return base;
  const atoms = liftBundleToAtoms(plan.constraints);
  const graph = buildTrivialGraphFromAtoms(atoms);
  return {
    ...base,
    constraintGraph: graph,
  } as CompiledWineQuery;
}

function makeConstraint(attribute: string, value: string): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: value,
    confidence: 1,
  };
}

function makeRanker(): Ranker {
  return new Ranker(
    new SignalComputer(),
    new ScoreAggregator(),
    new EvidenceMapper(),
  );
}

function scrubAdditiveFields<T extends Record<string, unknown>>(obj: T): T {
  const copy = { ...obj } as Record<string, unknown>;
  delete copy.matchedAtomRefs;
  delete copy.unmetAtomRefs;
  return copy as T;
}

describe('ranker trivial-graph parity — ADR-014 byte-identical gate', () => {
  it('trivial-graph ranked output is byte-identical to graph-absent path', async () => {
    const constraints: ConstraintBundle = {
      hard: [
        makeConstraint('wine_type', 'red'),
        makeConstraint('region', 'Bordeaux'),
      ],
      soft: [],
      inferred: [],
    };
    const plan = makePlan(constraints);
    const candidates: readonly HybridCandidate[] = [
      makeCandidate('wine-001', { producer: 'Chateau A' }),
      makeCandidate('wine-002', { producer: 'Chateau B' }),
      makeCandidate('wine-003', { producer: 'Chateau C' }),
    ];

    const inputNoGraph: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints,
      compiled: makeCompiled(plan, false),
    };
    const inputWithGraph: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints,
      compiled: makeCompiled(plan, true),
    };

    const rNo = await makeRanker().rank(inputNoGraph);
    const rYes = await makeRanker().rank(inputWithGraph);

    expect(rNo.results.length).toBe(rYes.results.length);

    // Field-by-field equivalence excluding the additive matchedAtomRefs /
    // unmetAtomRefs fields introduced by PR5.
    for (let i = 0; i < rNo.results.length; i++) {
      const a = scrubAdditiveFields(rNo.results[i]!);
      const b = scrubAdditiveFields(rYes.results[i]!);
      expect(b.entityId).toBe(a.entityId);
      expect(b.finalScore).toBe(a.finalScore);
      expect(b.rank).toBe(a.rank);
      expect(b.componentScores).toEqual(a.componentScores);
      expect([...b.matchedConstraints]).toEqual([...a.matchedConstraints]);
      expect([...b.unmetConstraints]).toEqual([...a.unmetConstraints]);
      expect([...b.inferredConstraints]).toEqual([...a.inferredConstraints]);
    }
  });

  it('graph-present path additionally emits matchedAtomRefs per result', async () => {
    const constraints: ConstraintBundle = {
      hard: [makeConstraint('wine_type', 'red')],
      soft: [],
      inferred: [],
    };
    const plan = makePlan(constraints);
    const candidate = makeCandidate('wine-001', { producer: 'Chateau A' });
    const input: RankingInput = {
      queryPlan: plan,
      candidates: [candidate],
      constraints,
      compiled: makeCompiled(plan, true),
    };
    const result = await makeRanker().rank(input);
    const r0 = result.results[0];
    expect(r0).toBeDefined();
    expect(r0?.matchedAtomRefs).toBeDefined();
    expect(Array.isArray(r0?.matchedAtomRefs)).toBe(true);
  });

  it('graph-absent path does NOT emit matchedAtomRefs', async () => {
    const constraints: ConstraintBundle = {
      hard: [makeConstraint('wine_type', 'red')],
      soft: [],
      inferred: [],
    };
    const plan = makePlan(constraints);
    const candidate = makeCandidate('wine-001', { producer: 'Chateau A' });
    const input: RankingInput = {
      queryPlan: plan,
      candidates: [candidate],
      constraints,
      compiled: makeCompiled(plan, false),
    };
    const result = await makeRanker().rank(input);
    const r0 = result.results[0];
    expect(r0).toBeDefined();
    // exactOptionalPropertyTypes — field must be absent, not undefined.
    expect(r0 !== undefined && 'matchedAtomRefs' in r0).toBe(false);
  });
});
