import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import { extractHardConstraintsFromGraph } from '../../query/service/graph-slot-constraints.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { dedupeSparseHitsByEntity } from './browse-diversity.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import type { ConstraintFilter } from './constraint-filter.js';

/**
 * Shared sparse-retrieval pipeline helpers used by browse and compare retrievers.
 *
 * Both retrievers share the same outer shape:
 *   1. resolve `hardForFilter` (graph-aware when a graph is present)
 *   2. map hard constraints into Vespa sparse filter tokens
 *   3. run a sparse search + de-dup hits by canonical entityId
 *   4. retriever-specific shaping (diversify / anchor-exclude / etc.)
 *   5. annotate candidate constraint evidence + apply hard filter rejection
 *
 * Steps 1, 2, 3, 5 are byte-identical across browse / compare today. These
 * helpers extract those steps without forcing a base class or inheritance —
 * each retriever stays in control of its own retriever-specific shaping in
 * step 4. The helpers are pure (no I/O of their own beyond the injected
 * `SearchIndexPort.sparseSearch` and no module state).
 */

/**
 * ADR-014 Phase 1b.3b: when a constraint graph is present, hard-tier slot
 * values from the graph are the authoritative filter source — the flat
 * `constraints.hard` bundle silently drops OR/XOR context in hybrid graphs.
 * Trivial-graph emission is byte-identical to the pre-PR5 `constraints.hard`
 * path, so callers can pass either form interchangeably for simple cases.
 */
export function resolveHardForFilter(
  constraints: ConstraintBundle,
  graph: ConstraintGraph | undefined,
): readonly NormalizedConstraint[] {
  return graph !== undefined
    ? extractHardConstraintsFromGraph(graph)
    : constraints.hard;
}

/**
 * Map hard constraints to Vespa sparse filter tokens. Pure wrapper that
 * normalizes the return to a fresh array so callers can freely treat it as
 * `readonly string[]` without aliasing the upstream allocation.
 */
export function toSparseFilterTokens(
  hardForFilter: readonly NormalizedConstraint[],
): readonly string[] {
  return [...hardConstraintsToSparseFilterTokens(hardForFilter)];
}

/**
 * Run a sparse search and de-dup the returned hits by canonical entityId.
 *
 * `filters` is passed through as `undefined` when empty so the underlying
 * port can choose to skip filter assembly entirely (matching the prior
 * inline behavior of both retrievers).
 */
export async function searchAndDedupSparse(args: {
  readonly client: SearchIndexPort;
  readonly queries: readonly string[];
  readonly filters: readonly string[];
  readonly fetchLimit: number;
}): Promise<readonly SparseHit[]> {
  const { client, queries, filters, fetchLimit } = args;
  const rawHits = await client.sparseSearch(
    queries,
    filters.length > 0 ? filters : undefined,
    fetchLimit,
  );
  return dedupeSparseHitsByEntity(rawHits);
}

/**
 * Annotate constraint evidence on candidates, then reject anything that
 * fails the hard-filter applicability check. This is the tail of every
 * sparse retriever today.
 */
export function annotateAndApplyHardFilters(args: {
  readonly candidates: readonly HybridCandidate[];
  readonly constraints: ConstraintBundle;
  readonly graph: ConstraintGraph | undefined;
  readonly constraintFilter: ConstraintFilter;
  readonly hardForFilter: readonly NormalizedConstraint[];
}): readonly HybridCandidate[] {
  const { candidates, constraints, graph, constraintFilter, hardForFilter } = args;
  const annotated = annotateCandidateConstraintEvidenceBatch(
    candidates,
    constraints,
    graph,
  );
  return constraintFilter.applyHardFilters(annotated, hardForFilter);
}
