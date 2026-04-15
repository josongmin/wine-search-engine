/**
 * Wave F1 — DeterministicTopologyDetector.
 *
 * Pattern-based, LLM-free producer of XOR / multi-subquery topology
 * graphs. Most user queries that need non-trivial topology follow a
 * small, auditable set of deterministic patterns:
 *
 *   - XOR: `A 또는 B`, `either A or B`, `반반`, `각각` — emit a
 *     `group_xor` node wrapping the competing slot ids.
 *   - Multi-course pairing: `메인에 … 디저트에 …`,
 *     `main course … dessert …` — emit one `subquery` node per
 *     detected course under a root `group_and`.
 *   - Otherwise: return `null` so the compiler keeps the trivial graph.
 *
 * Unlike the LLM topology planner, this detector requires no external
 * dependency — it is pure, deterministic, allocation-light, and safe to
 * run on every request. That is the F1 unlock: the BundleSelector and
 * the Axis 2 retrieval critic can finally observe real hybrid graphs on
 * production traffic without waiting for LLM credential rollout.
 *
 * Contract:
 *  - Returns a `ConstraintGraph` whose node ids all live in the
 *    `topology/` namespace (so `mergeTopologyIntoTrivial` accepts the
 *    result byte-for-byte).
 *  - Returns `null` on no-match, empty atoms (XOR branch), or any
 *    precondition violation. Null semantics match the LLM planner.
 *  - Pure: no I/O, no clock reads, no crypto. Identical input ⇒
 *    identical output.
 *
 * See CLAUDE.md rules 8, 23, 25 for the Unicode / false-positive /
 * vocabulary-SSoT discipline this module inherits from
 * `./topology-pattern-lexicon.ts`.
 */

import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION,
  type ConstraintGraph,
  type ConstraintGraphNode,
} from '../model/constraint-graph.js';
import type { QueryDecompositionHint } from '../model/query-decomposition.js';
import {
  classifyCourseHits,
  matchesCourseKeywords,
  matchesSharedBudgetHint,
  matchesXorLexicon,
} from './topology-pattern-lexicon.js';
import type {
  ConstraintGraphEdge,
  SharesBudgetEdge,
} from '../model/constraint-graph.js';

const TOPOLOGY_NODE_ID_PREFIX = 'topology/';
/** XOR wrap-root id — stable so identical input → identical output. */
const TOPOLOGY_XOR_ROOT_ID = `${TOPOLOGY_NODE_ID_PREFIX}det-xor-root`;
/** Multi-subquery AND-root id. */
const TOPOLOGY_COURSE_ROOT_ID = `${TOPOLOGY_NODE_ID_PREFIX}det-course-root`;
/** Per-course subquery node id prefix (suffixed with canonical purpose). */
const TOPOLOGY_COURSE_SUBQUERY_ID_PREFIX = `${TOPOLOGY_NODE_ID_PREFIX}det-course-`;
/** Default cardinality emitted per subquery node. Mirrors the LLM prompt's
 *  guidance that each course slot should target ~3 wines to choose from. */
const DEFAULT_SUBQUERY_TARGET_CARDINALITY = 3;

export interface DeterministicTopologyInput {
  readonly atoms: readonly ConstraintAtom[];
  readonly normalizedQuery: string;
  readonly decompositionHint?: QueryDecompositionHint | undefined;
  /**
   * Slot ids as produced by {@link buildTrivialGraphFromAtoms}, in the
   * same order as `atoms`. The detector reuses these ids in its XOR
   * children references rather than inventing new slot ids.
   */
  readonly slotIds: readonly string[];
}

/**
 * Deterministic detector. Stateless; safe to reuse a single instance
 * across every request / every worker.
 */
export class DeterministicTopologyDetector {
  detect(input: DeterministicTopologyInput): ConstraintGraph | null {
    const { atoms, normalizedQuery, slotIds } = input;

    // Shape preconditions mirror the LLM planner's input contract so
    // the two branches stay interchangeable downstream.
    if (atoms.length !== slotIds.length) return null;

    // ─── Multi-course (pairing) branch ─────────────────────────────
    if (matchesCourseKeywords(normalizedQuery)) {
      return this.buildCourseSubqueryGraph(normalizedQuery);
    }

    // ─── XOR branch ────────────────────────────────────────────────
    if (matchesXorLexicon(normalizedQuery)) {
      return this.buildXorGraph(atoms, slotIds);
    }

    return null;
  }

  // ── internals ───────────────────────────────────────────────────

  private buildXorGraph(
    atoms: readonly ConstraintAtom[],
    slotIds: readonly string[],
  ): ConstraintGraph | null {
    if (atoms.length < 2) return null;

    // Locate the attribute tier that has the largest number of atoms —
    // that is the axis along which the user's XOR is expressed. Ties
    // are broken by first-seen-attribute to preserve determinism.
    const byAttribute = new Map<string, string[]>();
    const attributeOrder: string[] = [];
    for (let i = 0; i < atoms.length; i++) {
      const attr = atoms[i]!.attribute;
      let bucket = byAttribute.get(attr);
      if (bucket === undefined) {
        bucket = [];
        byAttribute.set(attr, bucket);
        attributeOrder.push(attr);
      }
      const slotId = slotIds[i];
      if (slotId === undefined) return null;
      bucket.push(slotId);
    }

    let pickedAttribute: string | null = null;
    let pickedSlots: readonly string[] = [];
    for (const attr of attributeOrder) {
      const bucket = byAttribute.get(attr)!;
      if (bucket.length >= 2 && bucket.length > pickedSlots.length) {
        pickedAttribute = attr;
        pickedSlots = bucket;
      }
    }

    if (pickedAttribute === null || pickedSlots.length < 2) {
      return null;
    }

    const xorNode: ConstraintGraphNode = {
      kind: 'group_xor',
      nodeId: TOPOLOGY_XOR_ROOT_ID,
      children: [...pickedSlots],
    };

    return {
      graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION,
      origin: 'planner_emitted',
      rootNodeId: TOPOLOGY_XOR_ROOT_ID,
      nodes: [xorNode],
      edges: [],
      globalBudgets: {},
    };
  }

  private buildCourseSubqueryGraph(
    normalizedQuery: string,
  ): ConstraintGraph | null {
    const hits = classifyCourseHits(normalizedQuery);
    if (hits.length < 2) return null;

    const subqueryNodes: ConstraintGraphNode[] = hits.map((h) => ({
      kind: 'subquery' as const,
      nodeId: `${TOPOLOGY_COURSE_SUBQUERY_ID_PREFIX}${h.purpose}`,
      purpose: h.purpose,
      targetCardinality: DEFAULT_SUBQUERY_TARGET_CARDINALITY,
    }));

    const rootNode: ConstraintGraphNode = {
      kind: 'group_and',
      nodeId: TOPOLOGY_COURSE_ROOT_ID,
      children: subqueryNodes.map((n) => n.nodeId),
    };

    // Wave H — shared-budget edge emission. When a multi-course query
    // ALSO carries a shared-budget phrase ("총 X원" / "total" / "altogether")
    // AND either a numeric amount OR the multi-subquery decomposition
    // signal (always true here since we're in the ≥2-course branch),
    // emit a `shares_budget:price_total` edge between every pair of
    // subqueries. BundleSelector (Phase 1c) consumes this edge to enforce
    // an aggregate price ceiling across the winning assignment.
    const edges: ConstraintGraphEdge[] = [];
    if (
      matchesSharedBudgetHint({
        query: normalizedQuery,
        hasMultiSubquery: true,
      })
    ) {
      for (let i = 0; i < subqueryNodes.length; i++) {
        for (let j = i + 1; j < subqueryNodes.length; j++) {
          const a = subqueryNodes[i]!.nodeId;
          const b = subqueryNodes[j]!.nodeId;
          const edge: SharesBudgetEdge = {
            kind: 'shares_budget',
            from: a,
            to: b,
            resource: 'price_total',
          };
          edges.push(edge);
        }
      }
    }

    return {
      graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION,
      origin: 'planner_emitted',
      rootNodeId: TOPOLOGY_COURSE_ROOT_ID,
      nodes: [rootNode, ...subqueryNodes],
      edges,
      globalBudgets: {},
    };
  }
}
