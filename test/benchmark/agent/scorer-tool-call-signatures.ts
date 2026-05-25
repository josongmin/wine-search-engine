/**
 * Tool-call signatures + semantic invocation counting.
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition.
 * Pure helpers — no shared mutable state, no I/O. Used by both the
 * toolAccuracy dim (counts semantically distinct calls) and the
 * diagnostics formatter (stringifies tool arg values).
 */

import type { ToolCallTrace } from './scorer.js';

/**
 * Deterministic JSON stringify with sorted object keys. Two semantically
 * equivalent objects (same keys/values, different key insertion order)
 * produce the same string — required for de-duplicating tool calls by
 * their effective input rather than their literal string form.
 */
export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJsonStringify(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical signature for a tool call: `<tool>:<stable-stringified input>`.
 * Returns `null` when the input is missing or unparseable JSON; such calls
 * are counted as "opaque" by {@link countSemanticToolInvocations}.
 */
export function getToolCallSemanticSignature(call: ToolCallTrace): string | null {
  if (typeof call.input !== 'string' || call.input.trim().length === 0) {
    return null;
  }
  try {
    return `${call.tool}:${stableJsonStringify(JSON.parse(call.input) as unknown)}`;
  } catch {
    return null;
  }
}

/**
 * Count of tool invocations counted by semantic signature. Calls with
 * identical (tool, normalized-input) pairs are merged into a single
 * count entry; calls whose input is unparseable are counted as opaque
 * (each opaque call is a distinct invocation).
 *
 * This is the count the toolAccuracy dim uses to compare against the
 * scenario's expected tool invocations — preventing trivial input-string
 * shape differences (whitespace, key order) from being penalised as
 * "extra" tool calls.
 */
export function countSemanticToolInvocations(calls: readonly ToolCallTrace[]): number {
  const signatureCounts = new Map<string, number>();
  let opaqueCallCount = 0;
  for (const call of calls) {
    const signature = getToolCallSemanticSignature(call);
    if (signature !== null) {
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
      continue;
    }
    opaqueCallCount += 1;
  }
  return [...signatureCounts.values()].reduce((sum, count) => sum + count, opaqueCallCount);
}
