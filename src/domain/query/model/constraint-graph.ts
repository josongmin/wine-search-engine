/**
 * ADR-010 Phase 1a: ConstraintGraph — super-structure over ConstraintAtom.
 *
 * Graph nodes reference atoms by `atomRef`; edges carry the topology
 * (shared budget, complementarity, ordering) that the flat atom list
 * cannot express. Phase 1a produces only a **trivial graph** (one
 * `group_and` root, every atom as a slot child, no edges, no budget
 * extraction). Phase 1b upgrades the projector with LLM-emitted topology.
 *
 * Schema version carried per-graph so that replay and bench harnesses
 * detect drift deterministically.
 */

import { z } from 'zod';
import type {
  ConstraintAtom,
  ConstraintSourceKind,
  ConstraintTier,
} from '../../shared/types/constraint-atom.js';
import type { ConstraintOperator } from '../../shared/types/constraint-bundle.js';

// ─── Schema version ──────────────────────────────────────────────────────────

export const CONSTRAINT_GRAPH_SCHEMA_VERSION = 'constraint_graph_v1';
export type ConstraintGraphSchemaVersion = typeof CONSTRAINT_GRAPH_SCHEMA_VERSION;

// ─── Origin — audit the graph's upstream producer ────────────────────────────

/**
 * Where the graph came from. Phase 1a only emits `deterministic_from_atoms`;
 * Phase 1b adds `planner_emitted` and `hybrid`.
 */
export type ConstraintGraphOrigin =
  | 'deterministic_from_atoms'
  | 'planner_emitted'
  | 'hybrid';

// ─── Slot value shape ────────────────────────────────────────────────────────

/** Mirrors NormalizedConstraint.value, restated to avoid the unbounded
 *  `string | number | {...} | readonly string[]` branching in callers. */
export type SlotValue =
  | string
  | number
  | ReadonlyArray<string>
  | { readonly min: number; readonly max: number };

// ─── Nodes ───────────────────────────────────────────────────────────────────

export interface SlotNode {
  readonly kind: 'slot';
  readonly nodeId: string;
  /**
   * Index (stringified) into `QueryPlanV2.constraintAtoms` for the atom this
   * slot projects. Phase 1a relies on atom-array stability; Phase 1b may
   * promote atoms to carry intrinsic IDs.
   */
  readonly atomRef: string;
  readonly attribute: string;
  readonly operator: ConstraintOperator;
  readonly value: SlotValue;
  readonly sourceTier: ConstraintTier;
  readonly sourceKind: ConstraintSourceKind;
  readonly confidence: number;
}

export interface SubqueryNode {
  readonly kind: 'subquery';
  readonly nodeId: string;
  /** Human-readable tag — 'appetiser', 'main_course', 'dessert', etc. */
  readonly purpose: string;
  readonly targetCardinality: number;
}

export interface GroupAndNode {
  readonly kind: 'group_and';
  readonly nodeId: string;
  readonly children: readonly string[];
}

export interface GroupOrNode {
  readonly kind: 'group_or';
  readonly nodeId: string;
  readonly children: readonly string[];
}

export interface GroupXorNode {
  readonly kind: 'group_xor';
  readonly nodeId: string;
  readonly children: readonly string[];
}

export type ConstraintGraphNode =
  | SlotNode
  | SubqueryNode
  | GroupAndNode
  | GroupOrNode
  | GroupXorNode;

export type ConstraintGraphNodeKind = ConstraintGraphNode['kind'];

// ─── Edges ───────────────────────────────────────────────────────────────────

export type BudgetResource = 'price_total' | 'time' | 'count';
export type ComplementReason = 'meal_course' | 'pairing' | 'variety';

export interface SharesBudgetEdge {
  readonly kind: 'shares_budget';
  readonly from: string;
  readonly to: string;
  readonly resource: BudgetResource;
}

export interface ComplementsEdge {
  readonly kind: 'complements';
  readonly from: string;
  readonly to: string;
  readonly reason: ComplementReason;
}

export interface DependsOnEdge {
  readonly kind: 'depends_on';
  readonly from: string;
  readonly to: string;
}

export type ConstraintGraphEdge = SharesBudgetEdge | ComplementsEdge | DependsOnEdge;

// ─── Global budgets ──────────────────────────────────────────────────────────

export interface GlobalBudgetSet {
  readonly priceTotal?: { readonly currency: 'KRW' | 'USD'; readonly max: number };
  readonly candidateCount?: number;
  readonly walltime?: number;
}

// ─── Graph envelope ──────────────────────────────────────────────────────────

export interface ConstraintGraph {
  readonly graphSchemaVersion: ConstraintGraphSchemaVersion;
  readonly origin: ConstraintGraphOrigin;
  readonly rootNodeId: string;
  readonly nodes: readonly ConstraintGraphNode[];
  readonly edges: readonly ConstraintGraphEdge[];
  readonly globalBudgets: GlobalBudgetSet;
}

// ─── Zod schema (runtime validation / replay contract) ───────────────────────

/** Upper bound on node count — real wine queries have O(10) slots; 1024 is
 *  generous headroom for multi-course pairings without unbounded growth. */
const GRAPH_MAX_NODES = 1024;
/** Upper bound on edge count — same order of magnitude as nodes. */
const GRAPH_MAX_EDGES = 1024;
/** Upper bound on nodeId strings. */
const NODE_ID_MAX_LEN = 128;
/** Upper bound on attribute / purpose / reason strings. */
const LABEL_MAX_LEN = 128;

const SlotValueSchema: z.ZodType<SlotValue> = z.union([
  z.string().max(LABEL_MAX_LEN),
  z.number().finite(),
  z.array(z.string().max(LABEL_MAX_LEN)).readonly(),
  z.object({ min: z.number().finite(), max: z.number().finite() }).strict(),
]);

const ConstraintOperatorSchema = z.enum([
  '=', '<=', '>=', 'range', 'in', 'exclude', 'not_in',
]);

const ConstraintTierSchema = z.enum(['hard', 'soft', 'inferred']);

const ConstraintSourceKindSchema = z.enum([
  'explicit_utterance',
  'implicit_slot',
  'planner_inferred',
  'session_carry',
  'system_default',
]);

const SlotNodeSchema = z.object({
  kind: z.literal('slot'),
  nodeId: z.string().min(1).max(NODE_ID_MAX_LEN),
  atomRef: z.string().min(1).max(NODE_ID_MAX_LEN),
  attribute: z.string().min(1).max(LABEL_MAX_LEN),
  operator: ConstraintOperatorSchema,
  value: SlotValueSchema,
  sourceTier: ConstraintTierSchema,
  sourceKind: ConstraintSourceKindSchema,
  confidence: z.number().finite().min(0).max(1),
}).strict();

const SubqueryNodeSchema = z.object({
  kind: z.literal('subquery'),
  nodeId: z.string().min(1).max(NODE_ID_MAX_LEN),
  purpose: z.string().min(1).max(LABEL_MAX_LEN),
  targetCardinality: z.number().int().nonnegative(),
}).strict();

const groupSchema = <K extends 'group_and' | 'group_or' | 'group_xor'>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    nodeId: z.string().min(1).max(NODE_ID_MAX_LEN),
    children: z.array(z.string().min(1).max(NODE_ID_MAX_LEN)),
  }).strict();

const ConstraintGraphNodeSchema = z.discriminatedUnion('kind', [
  SlotNodeSchema,
  SubqueryNodeSchema,
  groupSchema('group_and'),
  groupSchema('group_or'),
  groupSchema('group_xor'),
]);

const SharesBudgetEdgeSchema = z.object({
  kind: z.literal('shares_budget'),
  from: z.string().min(1).max(NODE_ID_MAX_LEN),
  to: z.string().min(1).max(NODE_ID_MAX_LEN),
  resource: z.enum(['price_total', 'time', 'count']),
}).strict();

const ComplementsEdgeSchema = z.object({
  kind: z.literal('complements'),
  from: z.string().min(1).max(NODE_ID_MAX_LEN),
  to: z.string().min(1).max(NODE_ID_MAX_LEN),
  reason: z.enum(['meal_course', 'pairing', 'variety']),
}).strict();

const DependsOnEdgeSchema = z.object({
  kind: z.literal('depends_on'),
  from: z.string().min(1).max(NODE_ID_MAX_LEN),
  to: z.string().min(1).max(NODE_ID_MAX_LEN),
}).strict();

const ConstraintGraphEdgeSchema = z.discriminatedUnion('kind', [
  SharesBudgetEdgeSchema,
  ComplementsEdgeSchema,
  DependsOnEdgeSchema,
]);

const GlobalBudgetSetSchema = z.object({
  priceTotal: z.object({
    currency: z.enum(['KRW', 'USD']),
    max: z.number().finite().nonnegative(),
  }).strict().optional(),
  candidateCount: z.number().int().nonnegative().optional(),
  walltime: z.number().int().nonnegative().optional(),
}).strict();

export const ConstraintGraphSchema = z.object({
  graphSchemaVersion: z.literal(CONSTRAINT_GRAPH_SCHEMA_VERSION),
  origin: z.enum(['deterministic_from_atoms', 'planner_emitted', 'hybrid']),
  rootNodeId: z.string().min(1).max(NODE_ID_MAX_LEN),
  nodes: z.array(ConstraintGraphNodeSchema).max(GRAPH_MAX_NODES),
  edges: z.array(ConstraintGraphEdgeSchema).max(GRAPH_MAX_EDGES),
  globalBudgets: GlobalBudgetSetSchema,
}).strict();

export type ConstraintGraphValidated = z.infer<typeof ConstraintGraphSchema>;

// ─── Convenience accessors ───────────────────────────────────────────────────

/** Return the slot nodes in a graph, in insertion order. */
export function graphSlotNodes(graph: ConstraintGraph): readonly SlotNode[] {
  return graph.nodes.filter((n): n is SlotNode => n.kind === 'slot');
}

/**
 * Look up an atom by a slot's `atomRef`. Phase 1a uses stringified array
 * indices; the helper centralises that convention so Phase 1b can change
 * the ID scheme without hunting down every caller.
 */
export function resolveAtomForSlot(
  slot: SlotNode,
  atoms: readonly ConstraintAtom[],
): ConstraintAtom | undefined {
  const idx = Number(slot.atomRef);
  if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0 || idx >= atoms.length) {
    return undefined;
  }
  return atoms[idx];
}
