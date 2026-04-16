/**
 * ADR-011 Phase 1b (PR2): Graph-aware bench metric helpers.
 *
 * Parallel, dual-emit companion to the flat `scrInferred` / `csrInferred`
 * bucket-set computations in {@link ./constraint-metrics.ts}. These helpers
 * return `null` when no graph is available so the flat path remains the
 * historical source of truth — the dual-emit contract is additive, never a
 * replacement.
 *
 * What changes vs the flat path:
 *  - `scrInferredGraph`: recall of *expected inferred attribute names*
 *    measured against the graph's root-satisfaction semantics. AND / OR / XOR
 *    groupings drive which expected attributes count as matched instead of a
 *    flat set intersection. On a trivial (all-AND-root) graph the value is
 *    byte-identical to the flat recall — locked in the regression file.
 *  - `csrInferredGraph`: graph-aware satisfaction of the inferred-tier
 *    extracted constraints. For each extracted inferred constraint a graph
 *    is built over its attribute and we check whether the observation haystack
 *    covers enough attributes to drive the root to satisfied. Trivial graphs
 *    reduce to the per-attribute ratio the flat path already reports.
 *
 * Pure, deterministic, no I/O. Importing this module is safe from any bench
 * or regression lane.
 */

import type { NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
import type { ConstraintGraph } from '../../../src/domain/query/model/constraint-graph.js';
import { computeGraphCoverage } from '../../../src/domain/query/service/compute-graph-coverage.js';
import type { ExpectedConstraint } from './scenario.js';

// Module-scope shared tier weights — intentionally NOT re-imported from
// constraint-metrics.ts to keep this helper free of test-util circular
// dependency risk. Values mirror TIER_WEIGHT_* (rule 25: shared constants
// must not drift — there is a single test that locks agreement, see
// bench-graph-metric-dual-emit.regression.test.ts).
//
// Exported so the regression lane can assert agreement against the primary
// TIER_WEIGHT_* constants without re-declaring magic numbers.
export const GRAPH_METRIC_TIER_WEIGHT_HARD = 0.6;
export const GRAPH_METRIC_TIER_WEIGHT_SOFT = 0.2;
export const GRAPH_METRIC_TIER_WEIGHT_INFERRED = 0.2;

/** Return type for `computeScrInferredGraph`. */
interface GraphScrResult {
  /** `null` when no graph was provided OR when the expected inferred bucket is empty. */
  readonly value: number | null;
}

/** Return type for `computeCsrInferredGraph`. */
interface GraphCsrResult {
  /** `null` when no graph was provided OR when no extracted inferred constraints exist. */
  readonly value: number | null;
}

function attributeSetOf(constraints: readonly { attribute: string }[]): Set<string> {
  const out = new Set<string>();
  for (const c of constraints) out.add(c.attribute);
  return out;
}

/**
 * Compute graph-aware `scrInferredGraph`.
 *
 * Semantics: an expected inferred attribute counts as matched iff the
 * graph-aware root-satisfaction analysis would report the attribute covered
 * given the intersection of extracted and expected attributes. Trivial
 * (flat) graphs collapse to set intersection, so the output equals flat
 * recall byte-for-byte under `buildTrivialGraphFromAtoms(...)`.
 *
 * Returns `null` when:
 *  - `graph` is `undefined` (caller opted out of graph semantics)
 *  - `expectedInferred` is empty (measurement not applicable — matches the
 *    flat `scrInferred === null` contract in `scoreSemanticConstraintRecall`)
 */
export function computeScrInferredGraph(input: {
  readonly graph: ConstraintGraph | undefined;
  readonly extractedInferred: readonly NormalizedConstraint[];
  readonly expectedInferred: readonly ExpectedConstraint[] | undefined;
}): GraphScrResult {
  const { graph, extractedInferred, expectedInferred } = input;
  if (graph === undefined) return { value: null };
  if (expectedInferred === undefined || expectedInferred.length === 0) {
    return { value: null };
  }

  const extractedAttrs = attributeSetOf(extractedInferred);
  const expectedAttrs = attributeSetOf(expectedInferred);

  // A matched-attribute set is the intersection: attributes the extractor
  // *emitted* that the expectation *also demanded*.
  const satisfied = new Set<string>();
  for (const a of expectedAttrs) if (extractedAttrs.has(a)) satisfied.add(a);

  const coverage = computeGraphCoverage(graph, satisfied);

  // Expected attributes that the graph-aware analysis marks matched
  // (matchedAttributes is unique, sourced from satisfied slot nodes under
  // AND/OR/XOR semantics). Expected attrs not surfaced by the graph are
  // treated as misses, identical to flat recall denominator.
  let hits = 0;
  for (const a of expectedAttrs) {
    if (coverage.matchedAttributes.includes(a)) hits++;
  }
  return { value: hits / expectedAttrs.size };
}

/**
 * Compute graph-aware `csrInferredGraph`.
 *
 * Semantics: for each extracted inferred constraint, check whether the
 * observation haystack *evidences the attribute* (via the caller-supplied
 * `observationAttributes` set) under graph-aware satisfaction semantics.
 * The flat CSR path measures pure ratio of evidenced / total extracted;
 * the graph-aware path weights by which attributes are required to make
 * the root group satisfy, so an XOR group with one arm covered counts as
 * fully satisfied (flat would count 0.5 of 2 arms).
 *
 * Returns `null` when:
 *  - `graph` is `undefined`
 *  - `extractedInferred` is empty (measurement not applicable — matches the
 *    flat `csrInferred === null` contract in `scoreConstraintSatisfactionRate`)
 */
export function computeCsrInferredGraph(input: {
  readonly graph: ConstraintGraph | undefined;
  readonly extractedInferred: readonly NormalizedConstraint[];
  readonly observationAttributes: ReadonlySet<string>;
}): GraphCsrResult {
  const { graph, extractedInferred, observationAttributes } = input;
  if (graph === undefined) return { value: null };
  if (extractedInferred.length === 0) return { value: null };

  const coverage = computeGraphCoverage(graph, observationAttributes);

  // Denominator: the *extracted inferred attributes that appear in the graph
  // at all* — if an extracted constraint has no slot node in the graph it
  // cannot contribute a graph-aware signal. Fall back to the full extracted
  // set when the graph includes every attribute (the common trivial-graph case).
  const extractedAttrs = attributeSetOf(extractedInferred);
  const graphAttrs = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === 'slot') graphAttrs.add(node.attribute);
  }
  const measurable = new Set<string>();
  for (const a of extractedAttrs) if (graphAttrs.has(a)) measurable.add(a);

  if (measurable.size === 0) {
    // Extracted constraints reference attributes the graph never saw — no
    // graph-aware signal possible. Treat as `null` (not applicable) per the
    // same rule used for empty inputs.
    return { value: null };
  }

  let hits = 0;
  for (const a of measurable) {
    if (coverage.matchedAttributes.includes(a)) hits++;
  }
  return { value: hits / measurable.size };
}
