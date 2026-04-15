/**
 * ADR-010 Phase 1a: deterministic ConstraintGraph projector.
 *
 * Builds a "trivial graph" from a flat ConstraintAtom list: one
 * `group_and` root, every atom promoted to a `slot` child, no edges,
 * empty `globalBudgets`. Semantically equivalent to the flat bundle the
 * existing readers already consume — graph is additive.
 *
 * Phase 1b will upgrade this with budget extraction, XOR detection, and
 * multi-subquery decomposition (LLM-emitted topology).
 *
 * Pure function: no I/O, deterministic for identical input.
 */

import { createHash } from 'node:crypto';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION,
  type ConstraintGraph,
  type ConstraintGraphNode,
  type SlotNode,
  type SlotValue,
} from '../model/constraint-graph.js';

/** Prefix for the root node — fixed so two callers don't collide. */
const ROOT_NODE_ID_PREFIX = 'root-and';
/** Prefix for slot nodes. Deterministic hash appended for uniqueness. */
const SLOT_NODE_ID_PREFIX = 'slot';
/** Hex chars of the SHA-256 used to fingerprint a slot's identity. 16 is
 *  sufficient collision resistance for per-request constraint slot IDs
 *  (O(10) per query) while keeping IDs short for logs. */
const SLOT_HASH_PREFIX_CHARS = 16;

function fingerprintSlot(atom: ConstraintAtom, atomRef: string): string {
  const payload = JSON.stringify({
    atomRef,
    attribute: atom.attribute,
    operator: atom.operator,
    value: atom.value,
    sourceTier: atom.source_tier,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, SLOT_HASH_PREFIX_CHARS);
}

function fingerprintGraphRoot(slotIds: readonly string[]): string {
  const payload = JSON.stringify(slotIds);
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return `${ROOT_NODE_ID_PREFIX}-${digest.slice(0, SLOT_HASH_PREFIX_CHARS)}`;
}

function atomValueToSlotValue(value: ConstraintAtom['value']): SlotValue {
  // NormalizedConstraint.value is already one of the SlotValue variants.
  // Returning it directly is a no-op at runtime; the signature is the
  // single choke point for any future widening.
  return value;
}

/**
 * Build a trivial ConstraintGraph from a flat list of atoms. See
 * ADR-010 for invariants.
 *
 * @param atoms  Atom array — usually from `liftBundleToAtoms(bundle)` or
 *               `QueryPlanV2.constraintAtoms`.
 * @returns Graph with one root `group_and` node, one `slot` node per atom,
 *          empty edges, and empty globalBudgets.
 */
export function buildTrivialGraphFromAtoms(
  atoms: readonly ConstraintAtom[],
): ConstraintGraph {
  const slotNodes: SlotNode[] = atoms.map((atom, index) => {
    const atomRef = String(index);
    const fp = fingerprintSlot(atom, atomRef);
    return {
      kind: 'slot',
      nodeId: `${SLOT_NODE_ID_PREFIX}-${fp}`,
      atomRef,
      attribute: atom.attribute,
      operator: atom.operator,
      value: atomValueToSlotValue(atom.value),
      sourceTier: atom.source_tier,
      sourceKind: atom.source_kind,
      confidence: atom.confidence,
    };
  });

  const slotIds = slotNodes.map((n) => n.nodeId);
  const rootNodeId = fingerprintGraphRoot(slotIds);

  const nodes: ConstraintGraphNode[] = [
    { kind: 'group_and', nodeId: rootNodeId, children: slotIds },
    ...slotNodes,
  ];

  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION,
    origin: 'deterministic_from_atoms',
    rootNodeId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}
