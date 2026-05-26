/**
 * ADR-010 / ADR-011: downstream readers must only consume
 * `plan.constraintGraph` / `compiled.constraintGraph` after their ADR-011
 * Phase-1b migration is explicit. The allow-list below enumerates every
 * file authorised to reference `.constraintGraph` on a plan / compiled
 * query / compiler result.
 *
 * Phase 1a (ADR-010): type + projector + compiler emission + planner thread.
 * Phase 1b.1 (ADR-011): first-reader migration —
 *   - `compiled-wine-query.ts`   (passthrough field)
 *   - `execution-compiler.ts`    (plan → compiled copy)
 *   - `compute-graph-coverage.ts`(graph-aware AND/OR/XOR coverage)
 *   - `search-usecase-provenance-closure.ts` (first migrated reader)
 *   - `search-usecase-hybrid-ranking-pipeline.ts`
 *     (call-site that threads `compiled.constraintGraph` into the stage builders)
 *
 * Phase 1b.3a (ADR-011 PR1): second-reader migration —
 *   - `graph-required-attributes.ts` (shared helper for provenance / decision)
 *   - `search-usecase-decision-input.ts` (graph-aware matched/unmet when graph present)
 *   - `search-usecase-hybrid-candidates.ts` (pre-rank coverage call-site now passes graph)
 *   - `search-usecase-post-route-phase.ts` (threads `compiled.constraintGraph` into
 *     `buildSearchDecisionInput`'s executionContext bag)
 *
 * Phase 1b.2 (ADR-012 PR3): LLM topology planner —
 *   - `constraint-topology-planner.ts` (LLM seam, intent gate, Zod validation)
 *   - `merge-topology-into-trivial.ts` (deterministic merge; fail-closed on collision)
 *   - `prompts/constraint-graph-topology.prompt.ts` (frozen prompt v1)
 *   - `container-core-builders.ts` (flag-gated composition)
 *
 * Phase 1b.3b (ADR-014 PR5): ranker + retrieval annotator graph-native —
 *   - `graph-tier-projection.ts` (hard/soft/inferred subgraph projection)
 *   - `graph-slot-constraints.ts` (slot→NormalizedConstraint projection)
 *   - `graph-hard-gate.ts` (ranker hard gate delegating to `computeGraphCoverage`)
 *   - `graph-soft-weight.ts` (ranker soft weight helper)
 *   - `signal-computer.ts` (accepts optional `graph` in hard/soft predicates)
 *   - `ranker.ts` (threads `compiled.constraintGraph` + emits atomRefs)
 *   - `candidate-pool.ts` (annotator receives graph for atomRef emission)
 *   - `candidate-constraint-evidence.ts` (atomRef-keyed match records)
 *   - `browse-retriever.ts`, `compare-retriever.ts` (graph-slot filter extraction)
 *   - `search-usecase-hybrid-candidates.ts` (specialized retriever call-sites
 *     pass compiled.constraintGraph)
 *   - `search-usecase-hybrid-retrieval-input.ts` (threads compiled.constraintGraph
 *     into the HybridRetrievalInput substrate for candidate-pool annotator parity)
 *
 * Phase 1c (ADR-013 PR4): BundleSelector + graph-aware executor —
 *   - `assignment-solver.ts` (pure K≤5 Hungarian-style exact solver)
 *   - `bundle-selector.ts` (graph → assignment orchestrator; reads
 *     subquery nodes + shares_budget edges + globalBudgets)
 *   - `bundle-ranked-result.ts` (carrier model composing RankedResult[]
 *     across subqueries with bundle-scoped metadata)
 *   - `search-usecase-graph-executor.ts` (wraps candidatePool.execute;
 *     pass-through on trivial graphs, bundle path on hybrid multi-subquery)
 *   - `bundle-selector-counters.ts` (telemetry counters; reads graph
 *     origin + subquery count for audit paths)
 *
 * Axis 2 (ADR-015 PR6): executor-internal retrieval critic + rewriter —
 *   - `retrieval-critic.ts` (deterministic critic; reads
 *     `compiled.constraintGraph` indirectly via computeGraphCoverage)
 *   - `query-rewriter.ts` (rewrites; reads queryPlan / retrieval-input
 *     graph fields when applicable)
 *   - `retrieval-critic-counters.ts` (telemetry counters)
 *
 * Future Phase-1b.* migrations MUST append their source files to the
 * allow-list in the same PR that migrates them. Bare `.constraintGraph`
 * leaks elsewhere fail this test.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
);

/**
 * Files explicitly allowed to reference `constraintGraph` in Phase 1a.
 * - The type itself
 * - The projector
 * - The compiler seam that calls the projector
 * - Planner surface that threads the field onto V2
 * - QueryPlanV2 type where the field is declared
 * - ADR-010 / plan doc references
 * - Regression tests that lock the contract
 */
const PHASE_1A_ALLOWLIST: readonly RegExp[] = [
  // Phase 1a (ADR-010): type + projector + planner/compiler emission.
  /src\/domain\/query\/model\/constraint-graph\.ts$/,
  /src\/domain\/query\/model\/query-plan\.ts$/,
  /src\/domain\/query\/service\/build-trivial-graph-from-atoms\.ts$/,
  /src\/domain\/query\/service\/constraint-compiler\.ts$/,
  /src\/domain\/query\/service\/planner\.ts$/,
  // Phase 1b.1 (ADR-011): first-reader migration + passthrough plumbing.
  /src\/domain\/query\/model\/compiled-wine-query\.ts$/,
  /src\/domain\/query\/service\/execution-compiler\.ts$/,
  /src\/domain\/query\/service\/compute-graph-coverage\.ts$/,
  /src\/application\/search\/search-usecase-provenance-closure\.ts$/,
  /src\/application\/search\/search-usecase-hybrid-ranking-pipeline\.ts$/,
  // Phase 1b.3a (ADR-011 PR1): shared helper + decision-input + pre-rank coverage.
  /src\/domain\/query\/service\/graph-required-attributes\.ts$/,
  /src\/application\/search\/search-usecase-decision-input\.ts$/,
  /src\/application\/search\/search-usecase-hybrid-candidates\.ts$/,
  /src\/application\/search\/search-usecase-post-route-phase\.ts$/,
  // Phase 1b.2 (ADR-012 PR3): LLM topology planner + merge + wiring.
  /src\/domain\/query\/service\/constraint-topology-planner\.ts$/,
  /src\/domain\/query\/service\/merge-topology-into-trivial\.ts$/,
  /src\/domain\/query\/service\/prompts\/constraint-graph-topology\.prompt\.ts$/,
  /src\/config\/container-core-builders\.ts$/,
  // Wave F1: deterministic pattern-based topology detector (LLM-free path).
  /src\/domain\/query\/service\/deterministic-topology-detector\.ts$/,
  /src\/domain\/query\/service\/topology-pattern-lexicon\.ts$/,
  // Wave F4: unified graph-path-decision telemetry across 6 readers.
  /src\/domain\/observability\/graph-path-telemetry\.ts$/,
  // Phase 1b.3b (ADR-014 PR5): ranker + retrieval annotator graph-native.
  /src\/domain\/query\/service\/graph-tier-projection\.ts$/,
  /src\/domain\/query\/service\/graph-slot-constraints\.ts$/,
  /src\/domain\/ranking\/service\/graph-hard-gate\.ts$/,
  /src\/domain\/ranking\/service\/graph-soft-weight\.ts$/,
  /src\/domain\/ranking\/service\/signal-computer\.ts$/,
  /src\/domain\/ranking\/service\/ranker\.ts$/,
  // Wave I3 (ADR-017): 4 graph-aware LTR features landed in c92cb50.
  /src\/domain\/ranking\/service\/ltr-features\.ts$/,
  /src\/domain\/retrieval\/service\/candidate-pool\.ts$/,
  /src\/domain\/retrieval\/service\/candidate-constraint-evidence\.ts$/,
  /src\/domain\/retrieval\/service\/browse-retriever\.ts$/,
  /src\/domain\/retrieval\/service\/compare-retriever\.ts$/,
  /src\/domain\/retrieval\/model\/retrieval-input\.ts$/,
  /src\/application\/search\/search-usecase-hybrid-retrieval-input\.ts$/,
  /src\/application\/search\/port\/search-pipeline-deps\.port\.ts$/,
  // Phase 1c (ADR-013 PR4): BundleSelector + graph-aware executor.
  /src\/domain\/retrieval\/service\/assignment-solver\.ts$/,
  /src\/domain\/retrieval\/service\/bundle-selector\.ts$/,
  /src\/domain\/response\/model\/bundle-ranked-result\.ts$/,
  /src\/application\/search\/search-usecase-graph-executor\.ts$/,
  /src\/domain\/observability\/bundle-selector-counters\.ts$/,
  // Machine V2 tool sidecar seam.
  /src\/interface\/claude-tools\/tool-executor\.ts$/,
  // Docs / tests / benchmarks remain globally allowed.
  /docs\//,
  /test\/regression\//,
  /test\/benchmark\//,
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      listTsFiles(abs, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('ConstraintGraph reader allow-list (ADR-010 / ADR-011)', () => {
  it('no src/ file outside the allow-list references plan.constraintGraph', () => {
    const srcRoot = join(REPO_ROOT, 'src');
    const files = listTsFiles(srcRoot);
    const offenders: string[] = [];

    for (const abs of files) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      if (PHASE_1A_ALLOWLIST.some((re) => re.test(rel))) continue;
      const src = readFileSync(abs, 'utf8');
      // Phase 1a ban: reading `.constraintGraph` off a plan / compiled query /
      // compiler result. Allow `constraintGraphEmissionRate` in bench etc.
      if (/\.constraintGraph\b(?!Emission)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
