/**
 * Phase 1b.4: `buildRelaxedCompiledQuery` regenerates a trivial
 * `ConstraintGraph` from the relaxed bundle instead of stripping it.
 *
 * Context
 * -------
 * The Wave 1 hotfix (commit `e909609`) stripped `compiled.constraintGraph`
 * from the relaxed compiled query, forcing every graph-aware reader onto
 * its flat fallback path. That was a correctness-preserving safety patch
 * but a semantic loss: under Phase 1b.2 LLM topology (XOR/OR branches)
 * a relaxed query silently demoted to flat AND-all. Phase 1b.4 upgrades
 * to regeneration — the relaxed bundle is lifted to atoms and a
 * deterministic trivial graph is projected over that subset. Origin is
 * always stamped `'deterministic_from_atoms'` regardless of the original
 * graph's origin, because LLM-emitted topology branches may reference
 * slots that relaxation drops (unsound to preserve).
 *
 * Invariants locked by this test:
 *   1. Regenerated graph is NOT undefined when `CONSTRAINT_GRAPH_EMIT`
 *      is on (default).
 *   2. Regenerated graph's hard-tier slot count matches the relaxed
 *      bundle's hard count (NOT the original compiled graph's hard
 *      count, which would include dropped attributes).
 *   3. Regenerated graph's origin is `'deterministic_from_atoms'`
 *      even if the original graph was `'hybrid'` or `'planner_emitted'`.
 *   4. `CONSTRAINT_GRAPH_EMIT=false` → regenerated graph is undefined
 *      (parity with the compiler seam's rollback behaviour).
 *   5. Hard-slot attributes on the regenerated graph equal the
 *      relaxed bundle's hard-constraint attributes (set equality).
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRelaxedCompiledQuery } from '../../src/application/search/search-usecase-hybrid-ranking-pipeline.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION,
  graphSlotNodes,
  type ConstraintGraph,
  type ConstraintGraphOrigin,
  type SlotNode,
} from '../../src/domain/query/model/constraint-graph.js';

function makeBundle(hard: ConstraintBundle['hard']): ConstraintBundle {
  return { hard, soft: [], inferred: [] };
}

function makeCompiled(
  originalBundle: ConstraintBundle,
  originalGraph: ConstraintGraph,
): CompiledWineQuery {
  return {
    query: {
      rawQuery: 'test query',
      normalizedQuery: 'test query',
      intent: 'entity_exact',
      queryClass: 'unknown',
      anchors: [],
      constraints: originalBundle,
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as QueryPlanV1['uncertainty'],
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      retrievalPlan: {
        hardFilterTokens: ['country:Italy', 'region:Piedmont'],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'recommendation',
      routeSource: 'planner',
      budget: {
        maxCandidates: 20,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
    },
    constraintGraph: originalGraph,
  } as CompiledWineQuery;
}

function makeRelaxedPlan(relaxed: ConstraintBundle): QueryPlanV1 {
  return {
    rawQuery: 'test query',
    normalizedQuery: 'test query',
    intent: 'entity_exact',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: relaxed,
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

/**
 * Build a synthetic graph with `origin` override — we need to prove that
 * even a `hybrid`-origin graph is demoted on relaxation.
 */
function makeSyntheticGraph(
  origin: ConstraintGraphOrigin,
  hardAttributes: readonly string[],
): ConstraintGraph {
  const slots: SlotNode[] = hardAttributes.map((attribute, i) => ({
    kind: 'slot',
    nodeId: `slot-${attribute}-${i}`,
    atomRef: String(i),
    attribute,
    operator: '=',
    value: `val-${attribute}`,
    sourceTier: 'hard',
    sourceKind: 'explicit_utterance',
    confidence: 1,
  }));
  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION,
    origin,
    rootNodeId: 'synthetic-root',
    nodes: [
      {
        kind: 'group_and',
        nodeId: 'synthetic-root',
        children: slots.map((s) => s.nodeId),
      },
      ...slots,
    ],
    edges: [],
    globalBudgets: {},
  };
}

describe('buildRelaxedCompiledQuery graph regeneration (Phase 1b.4)', () => {
  const originalFlag = process.env['CONSTRAINT_GRAPH_EMIT'];

  beforeEach(() => {
    delete process.env['CONSTRAINT_GRAPH_EMIT'];
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env['CONSTRAINT_GRAPH_EMIT'];
    } else {
      process.env['CONSTRAINT_GRAPH_EMIT'] = originalFlag;
    }
  });

  const originalBundle: ConstraintBundle = makeBundle([
    {
      attribute: 'country',
      operator: '=',
      value: 'Italy',
      source_phrase: 'Italian',
      confidence: 1,
    },
    {
      attribute: 'region',
      operator: '=',
      value: 'Piedmont',
      source_phrase: 'Piedmont',
      confidence: 0.95,
    },
  ]);

  // Relaxation dropped `region`; only `country` survives.
  const relaxedBundle: ConstraintBundle = makeBundle([
    {
      attribute: 'country',
      operator: '=',
      value: 'Italy',
      source_phrase: 'Italian',
      confidence: 1,
    },
  ]);

  it('default flag (unset): regenerated graph is NOT undefined', () => {
    const originalGraph = makeSyntheticGraph('deterministic_from_atoms', [
      'country',
      'region',
    ]);
    const compiled = makeCompiled(originalBundle, originalGraph);
    const relaxedPlan = makeRelaxedPlan(relaxedBundle);

    const result = buildRelaxedCompiledQuery(compiled, relaxedPlan);

    expect(result.constraintGraph).toBeDefined();
  });

  it('regenerated graph hard-slot count matches the relaxed bundle hard count', () => {
    const originalGraph = makeSyntheticGraph('deterministic_from_atoms', [
      'country',
      'region',
    ]);
    const compiled = makeCompiled(originalBundle, originalGraph);
    const relaxedPlan = makeRelaxedPlan(relaxedBundle);

    const result = buildRelaxedCompiledQuery(compiled, relaxedPlan);
    const regenerated = result.constraintGraph;
    expect(regenerated).toBeDefined();
    const hardSlots = graphSlotNodes(regenerated as ConstraintGraph).filter(
      (s) => s.sourceTier === 'hard',
    );

    // Relaxed bundle has 1 hard constraint (country) — not 2 (country+region).
    expect(hardSlots.length).toBe(relaxedBundle.hard.length);
    expect(hardSlots.length).toBe(1);

    // And the original stale graph that would have leaked through had
    // 2 hard slots — so this assertion guards against regressing to
    // the pre-Wave1 bug where relaxation inherited the full graph.
    expect(hardSlots.length).toBeLessThan(
      graphSlotNodes(originalGraph).filter((s) => s.sourceTier === 'hard').length,
    );
  });

  it("regenerated graph origin is always 'deterministic_from_atoms' — even when the original origin was 'hybrid'", () => {
    // Simulate a Phase 1b.2 LLM-topology graph that carried XOR/OR
    // branching metadata. We can't replicate the full branching here
    // without a topology planner fixture, but the origin stamp alone
    // is enough to drive the regeneration contract: if we see 'hybrid'
    // on the output, the demotion didn't happen.
    const hybridGraph: ConstraintGraph = {
      ...makeSyntheticGraph('hybrid', ['country', 'region']),
      promptVersion: 'test-prompt-v1',
      llmModel: 'test-model',
    };
    const compiled = makeCompiled(originalBundle, hybridGraph);
    const relaxedPlan = makeRelaxedPlan(relaxedBundle);

    const result = buildRelaxedCompiledQuery(compiled, relaxedPlan);
    const regenerated = result.constraintGraph as ConstraintGraph;

    expect(regenerated.origin).toBe('deterministic_from_atoms');
    // Replay metadata from the LLM-origin graph must NOT leak through.
    expect(regenerated.promptVersion).toBeUndefined();
    expect(regenerated.llmModel).toBeUndefined();
  });

  it('regenerated hard-slot attributes equal the relaxed bundle hard attributes', () => {
    const originalGraph = makeSyntheticGraph('deterministic_from_atoms', [
      'country',
      'region',
    ]);
    const compiled = makeCompiled(originalBundle, originalGraph);
    const relaxedPlan = makeRelaxedPlan(relaxedBundle);

    const result = buildRelaxedCompiledQuery(compiled, relaxedPlan);
    const regenerated = result.constraintGraph as ConstraintGraph;
    const regeneratedHardAttrs = new Set(
      graphSlotNodes(regenerated)
        .filter((s) => s.sourceTier === 'hard')
        .map((s) => s.attribute),
    );
    const relaxedBundleHardAttrs = new Set(relaxedBundle.hard.map((c) => c.attribute));

    // Set equality: the relaxed graph's hard-slot set equals the relaxed
    // bundle's hard-constraint set. No dropped attributes leak through;
    // no phantom attributes appear.
    expect(regeneratedHardAttrs).toEqual(relaxedBundleHardAttrs);
  });

  it('CONSTRAINT_GRAPH_EMIT=false: regenerated graph is undefined (rollback parity with compiler seam)', () => {
    process.env['CONSTRAINT_GRAPH_EMIT'] = 'false';

    const originalGraph = makeSyntheticGraph('deterministic_from_atoms', [
      'country',
      'region',
    ]);
    const compiled = makeCompiled(originalBundle, originalGraph);
    const relaxedPlan = makeRelaxedPlan(relaxedBundle);

    const result = buildRelaxedCompiledQuery(compiled, relaxedPlan);

    expect(result.constraintGraph).toBeUndefined();
    // And the original stale graph must still have been stripped —
    // rollback mode must NOT inherit the pre-relaxation graph.
    expect(result).not.toHaveProperty('constraintGraph', originalGraph);
  });
});
