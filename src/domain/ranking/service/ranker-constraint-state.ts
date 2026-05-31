import { isBindingInferredConstraint } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../model/ranking-input.js';

/**
 * Query-level constraint context. Computed ONCE per rank() call and reused
 * for every candidate, rather than rebuilding the inferred-attribute list,
 * tracked-attribute Set, and soft-unmet derivation per-candidate.
 *
 * Allocation math (200-candidate query): previously ~7 intermediate arrays
 * + 2 Sets per candidate = ~1800 allocations; now 1 Set + 1 array for the
 * full request, plus only candidate-specific work in `buildConstraintState`.
 */
export interface QueryConstraintContext {
  readonly inferredConstraints: readonly string[];
  readonly trackedAttributes: ReadonlySet<string>;
  readonly softAttributes: readonly string[];
}

export function buildQueryConstraintContext(input: RankingInput): QueryConstraintContext {
  const inferredSeen = new Set<string>();
  const inferredConstraints: string[] = [];
  for (const constraint of input.constraints.inferred) {
    if (!isBindingInferredConstraint(constraint)) {
      continue;
    }
    if (!inferredSeen.has(constraint.attribute)) {
      inferredSeen.add(constraint.attribute);
      inferredConstraints.push(constraint.attribute);
    }
  }

  const trackedAttributes = new Set<string>();
  for (const c of input.constraints.hard) trackedAttributes.add(c.attribute);
  for (const c of input.constraints.soft) trackedAttributes.add(c.attribute);
  for (const a of inferredConstraints) trackedAttributes.add(a);

  const softAttributes: string[] = new Array<string>(input.constraints.soft.length);
  for (let i = 0; i < input.constraints.soft.length; i++) {
    softAttributes[i] = input.constraints.soft[i]!.attribute;
  }

  return { inferredConstraints, trackedAttributes, softAttributes };
}

export function buildConstraintState(
  candidate: HybridCandidate,
  queryCtx: QueryConstraintContext,
  graph?: ConstraintGraph  ,
): {
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
  readonly matchedAtomRefs?: readonly string[] | undefined;
  readonly unmetAtomRefs?: readonly string[] | undefined;
} {
  const matchedSet = new Set(candidate.matchedConstraints);

  // Collect unmet constraints into a single dedup set to avoid building
  // 3 intermediate arrays (softUnmet, inferredUnmet, spread concat) then
  // a 4th `[...new Set(...)]` over the concatenation.
  const unmetSet = new Set<string>();
  const unmetHard = candidate.unmetHardConstraints;
  if (unmetHard !== undefined) {
    for (const attr of unmetHard) unmetSet.add(attr);
  }
  for (const attr of queryCtx.softAttributes) {
    if (!matchedSet.has(attr)) unmetSet.add(attr);
  }
  for (const attr of queryCtx.inferredConstraints) {
    if (!matchedSet.has(attr)) unmetSet.add(attr);
  }
  const unmetConstraints: string[] = [];
  for (const attr of unmetSet) unmetConstraints.push(attr);

  // Filter matched constraints against the query-level tracked-attributes
  // Set (built once per request in buildQueryConstraintContext).
  const tracked = queryCtx.trackedAttributes;
  const matchedConstraints: string[] = [];
  for (const attribute of candidate.matchedConstraints) {
    if (tracked.has(attribute)) matchedConstraints.push(attribute);
  }

  // ADR-014 Phase 1b.3b: prefer annotator-provided `matchedAtomRefs` /
  // `unmetAtomRefs` when the candidate already carries them (batch
  // annotator path); otherwise reconstruct from the graph nodes here so
  // unit tests and non-annotated inputs still see the graph-derived slot
  // IDs. Absent graph → keep the flat legacy shape unchanged.
  if (graph !== undefined) {
    if (
      candidate.matchedAtomRefs !== undefined &&
      candidate.unmetAtomRefs !== undefined
    ) {
      return {
        matchedConstraints,
        unmetConstraints,
        inferredConstraints: queryCtx.inferredConstraints,
        matchedAtomRefs: candidate.matchedAtomRefs,
        unmetAtomRefs: candidate.unmetAtomRefs,
      };
    }
    const matchedAtomRefs: string[] = [];
    const unmetAtomRefs: string[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'slot') continue;
      if (matchedSet.has(node.attribute)) {
        matchedAtomRefs.push(node.nodeId);
      } else {
        unmetAtomRefs.push(node.nodeId);
      }
    }
    return {
      matchedConstraints,
      unmetConstraints,
      inferredConstraints: queryCtx.inferredConstraints,
      matchedAtomRefs,
      unmetAtomRefs,
    };
  }

  return {
    matchedConstraints,
    unmetConstraints,
    inferredConstraints: queryCtx.inferredConstraints,
  };
}
