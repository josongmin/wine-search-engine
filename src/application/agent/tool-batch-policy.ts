/**
 * E7: TOOL_BATCH_POLICY — typed graph replacing validateParallelBatchPolicy().
 *
 * The old function expressed batch constraints as code flow (if/else chains).
 * Adding a new tool required modifying function logic, risking regression.
 *
 * This module expresses the same constraints as a declarative data structure:
 *  - canRunWith:    tools that may share a parallel batch with this tool
 *  - mustRunAlone:  if true, the tool cannot share a batch with ANY other tool
 *  - maxPerBatch:   maximum concurrent invocations of this tool in one batch
 *
 * Adding a new tool = adding a new entry to TOOL_BATCH_POLICY.
 * No code flow changes required.
 *
 * The existing validateParallelBatchPolicy() function in agent-orchestrator.ts
 * REMAINS in place for backward compatibility. evaluateBatchPolicy() in this
 * module is the E7 typed replacement — consumers can migrate to it incrementally.
 */

import type { AgentToolName } from './tool-outcome.js';

// ─── BatchPolicyEntry ─────────────────────────────────────────────────────────

export interface BatchPolicyEntry {
  /**
   * Other tools that may run in the same parallel batch as this tool.
   * Empty array = this tool cannot run with ANY other tool (except itself
   * if mustRunAlone is false and maxPerBatch > 1).
   */
  readonly canRunWith: readonly AgentToolName[];

  /**
   * If true, this tool must be the only tool in the batch (no parallel calls
   * with any other tool, including itself).
   */
  readonly mustRunAlone: boolean;

  /**
   * Maximum number of parallel invocations of this tool in one batch.
   * 1 = at most one call per batch; 4 = up to 4 parallel calls.
   */
  readonly maxPerBatch: number;
}

// ─── TOOL_BATCH_POLICY ────────────────────────────────────────────────────────

/**
 * Declarative batch policy graph for all known agent tools.
 *
 * Invariants encoded here (previously in validateParallelBatchPolicy code flow):
 *  - compare_wines:        must run alone (returns a full comparison payload;
 *                          mixing with other tools creates ambiguous synthesis)
 *  - check_drinking_window: can batch with itself (up to 4 parallel checks),
 *                           but not with search, pairing, or compare
 *  - get_food_pairings:    can batch with search_wines only
 *  - search_wines:         can batch with itself (multiple parallel queries) or get_food_pairings
 */
export const TOOL_BATCH_POLICY: Readonly<Record<AgentToolName, BatchPolicyEntry>> = {
  search_wines: {
    // Multiple search_wines calls may run in parallel (e.g. "compare two wines
    // by running two searches"). get_food_pairings is also a safe co-tool.
    canRunWith: ['get_food_pairings', 'search_wines'],
    mustRunAlone: false,
    maxPerBatch: 4,
  },
  compare_wines: {
    canRunWith: [],
    mustRunAlone: true,
    maxPerBatch: 1,
  },
  check_drinking_window: {
    canRunWith: ['check_drinking_window'],
    mustRunAlone: false,
    maxPerBatch: 4,
  },
  get_food_pairings: {
    canRunWith: ['search_wines'],
    mustRunAlone: false,
    maxPerBatch: 1,
  },
} as const;

// ─── evaluateBatchPolicy ──────────────────────────────────────────────────────

/**
 * E7: Evaluate whether a parallel batch of tool calls satisfies the policy graph.
 *
 * Returns { allowed: true } when the batch is valid, or
 * { allowed: false, reason: string, violatingTools: AgentToolName[] } when not.
 *
 * This is a pure replacement for the ad-hoc if/else chains in
 * validateParallelBatchPolicy() — same logic, data-driven.
 */
export function evaluateBatchPolicy(
  calls: readonly { readonly tool: string; readonly input: Record<string, unknown> }[],
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string; readonly violatingTools: readonly string[] } {
  if (calls.length === 0) {
    return { allowed: true };
  }

  // Single-call batch always allowed (no parallelism to validate)
  if (calls.length === 1) {
    return { allowed: true };
  }

  const toolNames = calls.map((c) => c.tool);

  // Helper: safe lookup that treats unknown tool names as undefined (cast via unknown).
  const getPolicy = (name: string): BatchPolicyEntry | undefined =>
    (TOOL_BATCH_POLICY as Record<string, BatchPolicyEntry | undefined>)[name];

  // Check mustRunAlone — if any tool requires solo execution and batch has >1 call
  for (const name of toolNames) {
    const policy = getPolicy(name);
    if (policy?.mustRunAlone) {
      return {
        allowed: false,
        reason: `'${name}' must run alone in a step`,
        violatingTools: [name],
      };
    }
  }

  // Check maxPerBatch — count occurrences of each tool
  const toolCounts = new Map<string, number>();
  for (const name of toolNames) {
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of toolCounts) {
    const policy = getPolicy(name);
    if (policy !== undefined && count > policy.maxPerBatch) {
      return {
        allowed: false,
        reason: `'${name}' exceeds maxPerBatch (${policy.maxPerBatch}): ${count} calls in batch`,
        violatingTools: [name],
      };
    }
  }

  // Reject unknown tools explicitly before canRunWith validation.
  // An unknown tool (not in TOOL_BATCH_POLICY) has no declared compatibility —
  // allowing it to silently bypass checks would violate the contract graph.
  for (const name of toolCounts.keys()) {
    if (getPolicy(name) === undefined) {
      return {
        allowed: false,
        reason: `Unknown tool '${name}' has no batch policy entry`,
        violatingTools: [name],
      };
    }
  }

  // Check canRunWith — for each tool, verify all co-batched tools are permitted
  const uniqueTools = [...toolCounts.keys()];
  for (const name of uniqueTools) {
    const policy = getPolicy(name);
    if (policy === undefined) continue; // unknown tool — already rejected above
    const coTools = uniqueTools.filter((t) => t !== name);
    for (const coTool of coTools) {
      if (!(policy.canRunWith as readonly string[]).includes(coTool)) {
        return {
          allowed: false,
          reason: `'${name}' cannot run in the same batch as '${coTool}'`,
          violatingTools: [name, coTool],
        };
      }
    }
  }

  return { allowed: true };
}
