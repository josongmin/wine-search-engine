/**
 * ADR-012 Phase 1b.2: constraint-graph topology LLM prompt.
 *
 * Frozen at `prompt_version = 'ctg_topology_v1'`. Any change to the text
 * OR the expected-output schema requires bumping to `ctg_topology_v2`.
 * The version is emitted into every graph envelope so bench replay
 * detects vendor-side drift (model updates) as a loud failure instead
 * of a silent behaviour change.
 */

export const CTG_TOPOLOGY_PROMPT_VERSION = 'ctg_topology_v1';

/**
 * System prompt — describes the task, the output schema, and the
 * disjoint-namespace contract. Deliberately terse so vendor prompt
 * caching stays effective.
 *
 * Output shape (JSON):
 *   {
 *     "origin": "planner_emitted",
 *     "rootNodeId": "topology/root",
 *     "nodes": [ { "kind": "group_and" | "group_or" | "group_xor" | "subquery",
 *                  "nodeId": "topology/<stable>",
 *                  "children"?: string[], "purpose"?: string,
 *                  "targetCardinality"?: number } ],
 *     "edges": [ { "kind": "shares_budget" | "complements" | "depends_on",
 *                  "from": "topology/*", "to": "topology/*",
 *                  "resource"?: "price_total" | "time" | "count",
 *                  "reason"?: "meal_course" | "pairing" | "variety" } ],
 *     "globalBudgets": { "priceTotal"?: { "currency": "KRW"|"USD", "max": number },
 *                        "candidateCount"?: number, "walltime"?: number }
 *   }
 *
 * Slot nodes are NOT emitted — those come from the deterministic trivial
 * projector and are referenced by `children` via their pre-existing
 * `slot-<hash>` ids (provided in the user message alongside atoms).
 */
export const CTG_TOPOLOGY_SYSTEM_PROMPT = `You are a constraint-topology planner for a wine search engine.

Given a user's normalized query + the list of constraint atoms + any decomposition hint, emit the *topology* (groups, subqueries, cross-subquery edges, global budgets) that the downstream executor needs. DO NOT emit slot nodes — those already exist and are referenced by their provided \`slot-<hash>\` ids.

Hard rules:
- Every node id you emit MUST start with "topology/" — never reuse a "slot-" id.
- Your emitted \`rootNodeId\` is the new graph root; it must be one of your topology nodes.
- \`children\` of your groups may include slot ids (unchanged) AND your topology node ids.
- \`edges[].from\` and \`edges[].to\` MUST both reference topology ids (not slot ids) — cross-subquery relations between subqueries.
- If the user's query is single-intent with no disjunction/pairing, return an empty \`nodes\` array — the caller will keep the trivial graph.
- Output strict JSON only. No prose, no markdown.`;

export function buildUserMessage(input: {
  readonly normalizedQuery: string;
  readonly atoms: ReadonlyArray<{
    readonly slotId: string;
    readonly attribute: string;
    readonly operator: string;
    readonly value: unknown;
    readonly sourceTier: string;
  }>;
  readonly decompositionHint?: {
    readonly subQueryCount: number;
    readonly strategy?: string;
  };
}): string {
  const hintLine =
    input.decompositionHint !== undefined
      ? `Decomposition hint: subQueryCount=${input.decompositionHint.subQueryCount}${
          input.decompositionHint.strategy !== undefined
            ? `, strategy=${input.decompositionHint.strategy}`
            : ''
        }`
      : 'Decomposition hint: none';

  const atomsLine = input.atoms
    .map(
      (a) =>
        `  ${a.slotId}: ${a.attribute} ${a.operator} ${JSON.stringify(a.value)} [${a.sourceTier}]`,
    )
    .join('\n');

  return [
    `Query: ${input.normalizedQuery}`,
    hintLine,
    'Atoms (slotId: attribute operator value [tier]):',
    atomsLine,
  ].join('\n');
}
