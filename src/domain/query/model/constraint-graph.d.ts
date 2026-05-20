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
import type { ConstraintAtom, ConstraintSourceKind, ConstraintTier } from '../../shared/types/constraint-atom.js';
import type { ConstraintOperator } from '../../shared/types/constraint-bundle.js';
/**
 * v1: trivial / deterministic graphs (ADR-010 Phase 1a).
 * v1.1: adds optional replay metadata (`promptVersion`, `generatedAt`,
 *       `llmModel`) carried by LLM-sourced topology graphs (ADR-012 Phase 1b.2).
 *
 * v1.1 is a pure superset of v1 — every v1 envelope parses under v1.1 Zod
 * unchanged. Rollback is a Zod version-pin with no data migration.
 */
export declare const CONSTRAINT_GRAPH_SCHEMA_VERSION = "constraint_graph_v1";
export declare const CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1 = "constraint_graph_v1.1";
export type ConstraintGraphSchemaVersion = typeof CONSTRAINT_GRAPH_SCHEMA_VERSION | typeof CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1;
/**
 * Where the graph came from. Phase 1a only emits `deterministic_from_atoms`;
 * Phase 1b adds `planner_emitted` and `hybrid`.
 */
export type ConstraintGraphOrigin = 'deterministic_from_atoms' | 'planner_emitted' | 'hybrid';
/** Mirrors NormalizedConstraint.value, restated to avoid the unbounded
 *  `string | number | {...} | readonly string[]` branching in callers. */
export type SlotValue = string | number | ReadonlyArray<string> | {
    readonly min: number;
    readonly max: number;
};
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
    readonly obligation?: SubqueryObligation | undefined;
}
export type SubqueryObligation = 'required' | 'optional';
export declare function getSubqueryObligation(node: Pick<SubqueryNode, 'obligation'>): SubqueryObligation;
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
export type ConstraintGraphNode = SlotNode | SubqueryNode | GroupAndNode | GroupOrNode | GroupXorNode;
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
export interface GlobalBudgetSet {
    readonly priceTotal?: {
        readonly currency: 'KRW' | 'USD';
        readonly max: number;
    };
    readonly candidateCount?: number;
    readonly walltime?: number;
}
export interface ConstraintGraph {
    readonly graphSchemaVersion: ConstraintGraphSchemaVersion;
    readonly origin: ConstraintGraphOrigin;
    readonly rootNodeId: string;
    readonly nodes: readonly ConstraintGraphNode[];
    readonly edges: readonly ConstraintGraphEdge[];
    readonly globalBudgets: GlobalBudgetSet;
    /**
     * ADR-012 Phase 1b.2 replay metadata. Present on LLM-sourced graphs
     * (`origin='planner_emitted' | 'hybrid'`); absent on deterministic
     * graphs. `generatedAt` is excluded from replay-hash comparisons.
     */
    readonly promptVersion?: string;
    readonly generatedAt?: string;
    readonly llmModel?: string;
}
export declare const ConstraintGraphSchema: z.ZodObject<{
    graphSchemaVersion: z.ZodUnion<[z.ZodLiteral<"constraint_graph_v1">, z.ZodLiteral<"constraint_graph_v1.1">]>;
    origin: z.ZodEnum<["deterministic_from_atoms", "planner_emitted", "hybrid"]>;
    rootNodeId: z.ZodString;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"slot">;
        nodeId: z.ZodString;
        atomRef: z.ZodString;
        attribute: z.ZodString;
        operator: z.ZodEnum<["=", "<=", ">=", "range", "in", "exclude", "not_in"]>;
        value: z.ZodType<SlotValue, z.ZodTypeDef, SlotValue>;
        sourceTier: z.ZodEnum<["hard", "soft", "inferred"]>;
        sourceKind: z.ZodEnum<["explicit_utterance", "implicit_slot", "planner_inferred", "session_carry", "system_default"]>;
        confidence: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        value: SlotValue;
        confidence: number;
        attribute: string;
        operator: "=" | "<=" | ">=" | "range" | "in" | "exclude" | "not_in";
        kind: "slot";
        nodeId: string;
        atomRef: string;
        sourceTier: "hard" | "soft" | "inferred";
        sourceKind: "explicit_utterance" | "implicit_slot" | "planner_inferred" | "session_carry" | "system_default";
    }, {
        value: SlotValue;
        confidence: number;
        attribute: string;
        operator: "=" | "<=" | ">=" | "range" | "in" | "exclude" | "not_in";
        kind: "slot";
        nodeId: string;
        atomRef: string;
        sourceTier: "hard" | "soft" | "inferred";
        sourceKind: "explicit_utterance" | "implicit_slot" | "planner_inferred" | "session_carry" | "system_default";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"subquery">;
        nodeId: z.ZodString;
        purpose: z.ZodString;
        targetCardinality: z.ZodNumber;
        obligation: z.ZodOptional<z.ZodEnum<["required", "optional"]>>;
    }, "strict", z.ZodTypeAny, {
        kind: "subquery";
        nodeId: string;
        purpose: string;
        targetCardinality: number;
        obligation?: "required" | "optional" | undefined;
    }, {
        kind: "subquery";
        nodeId: string;
        purpose: string;
        targetCardinality: number;
        obligation?: "required" | "optional" | undefined;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"group_and">;
        nodeId: z.ZodString;
        children: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        kind: "group_and";
        nodeId: string;
        children: string[];
    }, {
        kind: "group_and";
        nodeId: string;
        children: string[];
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"group_or">;
        nodeId: z.ZodString;
        children: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        kind: "group_or";
        nodeId: string;
        children: string[];
    }, {
        kind: "group_or";
        nodeId: string;
        children: string[];
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"group_xor">;
        nodeId: z.ZodString;
        children: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        kind: "group_xor";
        nodeId: string;
        children: string[];
    }, {
        kind: "group_xor";
        nodeId: string;
        children: string[];
    }>]>, "many">;
    edges: z.ZodArray<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"shares_budget">;
        from: z.ZodString;
        to: z.ZodString;
        resource: z.ZodEnum<["price_total", "time", "count"]>;
    }, "strict", z.ZodTypeAny, {
        kind: "shares_budget";
        from: string;
        to: string;
        resource: "price_total" | "time" | "count";
    }, {
        kind: "shares_budget";
        from: string;
        to: string;
        resource: "price_total" | "time" | "count";
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"complements">;
        from: z.ZodString;
        to: z.ZodString;
        reason: z.ZodEnum<["meal_course", "pairing", "variety"]>;
    }, "strict", z.ZodTypeAny, {
        reason: "pairing" | "meal_course" | "variety";
        kind: "complements";
        from: string;
        to: string;
    }, {
        reason: "pairing" | "meal_course" | "variety";
        kind: "complements";
        from: string;
        to: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"depends_on">;
        from: z.ZodString;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "depends_on";
        from: string;
        to: string;
    }, {
        kind: "depends_on";
        from: string;
        to: string;
    }>]>, "many">;
    globalBudgets: z.ZodObject<{
        priceTotal: z.ZodOptional<z.ZodObject<{
            currency: z.ZodEnum<["KRW", "USD"]>;
            max: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            max: number;
            currency: "KRW" | "USD";
        }, {
            max: number;
            currency: "KRW" | "USD";
        }>>;
        candidateCount: z.ZodOptional<z.ZodNumber>;
        walltime: z.ZodOptional<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        priceTotal?: {
            max: number;
            currency: "KRW" | "USD";
        } | undefined;
        candidateCount?: number | undefined;
        walltime?: number | undefined;
    }, {
        priceTotal?: {
            max: number;
            currency: "KRW" | "USD";
        } | undefined;
        candidateCount?: number | undefined;
        walltime?: number | undefined;
    }>;
    promptVersion: z.ZodOptional<z.ZodString>;
    generatedAt: z.ZodOptional<z.ZodString>;
    llmModel: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    graphSchemaVersion: "constraint_graph_v1" | "constraint_graph_v1.1";
    origin: "deterministic_from_atoms" | "planner_emitted" | "hybrid";
    rootNodeId: string;
    nodes: ({
        value: SlotValue;
        confidence: number;
        attribute: string;
        operator: "=" | "<=" | ">=" | "range" | "in" | "exclude" | "not_in";
        kind: "slot";
        nodeId: string;
        atomRef: string;
        sourceTier: "hard" | "soft" | "inferred";
        sourceKind: "explicit_utterance" | "implicit_slot" | "planner_inferred" | "session_carry" | "system_default";
    } | {
        kind: "subquery";
        nodeId: string;
        purpose: string;
        targetCardinality: number;
        obligation?: "required" | "optional" | undefined;
    } | {
        kind: "group_and";
        nodeId: string;
        children: string[];
    } | {
        kind: "group_or";
        nodeId: string;
        children: string[];
    } | {
        kind: "group_xor";
        nodeId: string;
        children: string[];
    })[];
    edges: ({
        kind: "shares_budget";
        from: string;
        to: string;
        resource: "price_total" | "time" | "count";
    } | {
        reason: "pairing" | "meal_course" | "variety";
        kind: "complements";
        from: string;
        to: string;
    } | {
        kind: "depends_on";
        from: string;
        to: string;
    })[];
    globalBudgets: {
        priceTotal?: {
            max: number;
            currency: "KRW" | "USD";
        } | undefined;
        candidateCount?: number | undefined;
        walltime?: number | undefined;
    };
    promptVersion?: string | undefined;
    generatedAt?: string | undefined;
    llmModel?: string | undefined;
}, {
    graphSchemaVersion: "constraint_graph_v1" | "constraint_graph_v1.1";
    origin: "deterministic_from_atoms" | "planner_emitted" | "hybrid";
    rootNodeId: string;
    nodes: ({
        value: SlotValue;
        confidence: number;
        attribute: string;
        operator: "=" | "<=" | ">=" | "range" | "in" | "exclude" | "not_in";
        kind: "slot";
        nodeId: string;
        atomRef: string;
        sourceTier: "hard" | "soft" | "inferred";
        sourceKind: "explicit_utterance" | "implicit_slot" | "planner_inferred" | "session_carry" | "system_default";
    } | {
        kind: "subquery";
        nodeId: string;
        purpose: string;
        targetCardinality: number;
        obligation?: "required" | "optional" | undefined;
    } | {
        kind: "group_and";
        nodeId: string;
        children: string[];
    } | {
        kind: "group_or";
        nodeId: string;
        children: string[];
    } | {
        kind: "group_xor";
        nodeId: string;
        children: string[];
    })[];
    edges: ({
        kind: "shares_budget";
        from: string;
        to: string;
        resource: "price_total" | "time" | "count";
    } | {
        reason: "pairing" | "meal_course" | "variety";
        kind: "complements";
        from: string;
        to: string;
    } | {
        kind: "depends_on";
        from: string;
        to: string;
    })[];
    globalBudgets: {
        priceTotal?: {
            max: number;
            currency: "KRW" | "USD";
        } | undefined;
        candidateCount?: number | undefined;
        walltime?: number | undefined;
    };
    promptVersion?: string | undefined;
    generatedAt?: string | undefined;
    llmModel?: string | undefined;
}>;
/** Return the slot nodes in a graph, in insertion order. */
export declare function graphSlotNodes(graph: ConstraintGraph): readonly SlotNode[];
/**
 * Look up an atom by a slot's `atomRef`. Phase 1a uses stringified array
 * indices; the helper centralises that convention so Phase 1b can change
 * the ID scheme without hunting down every caller.
 */
export declare function resolveAtomForSlot(slot: SlotNode, atoms: readonly ConstraintAtom[]): ConstraintAtom | undefined;
//# sourceMappingURL=constraint-graph.d.ts.map