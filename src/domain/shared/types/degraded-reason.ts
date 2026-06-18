/**
 * SSoT (CLAUDE.md rule 30) for the synthesis/agent `DegradedReason` taxonomy.
 *
 * This used to be declared FOUR times with no shared import — a pure TS union
 * in `synthesis-schemas.ts` plus three Zod enums (the application result
 * schema, the HTTP wire schema, and the wire DTO type). They drifted once
 * already: `llm_unavailable` (and `no_corpus_match`) were added to some copies
 * but not the application result schema, so `assertWineSearchResult` 500'd
 * every LLM-provider-unavailable agent request at runtime.
 *
 * Now there is ONE source: the `DEGRADED_REASONS` tuple below. The type derives
 * from it, and every Zod enum is built with `z.enum(DEGRADED_REASONS)` so a new
 * reason cannot be half-added again.
 */

/**
 * Why the synthesis runner (or the orchestrator's blocked path) returned a
 * degraded answer instead of a primary LLM synthesis. Per-value semantics:
 *
 * - `malformed_llm_output` — a WORKING LLM returned output that failed our
 *   schema (200 OK, bad JSON). Grounded Layer 2/3 fallback is legitimate.
 * - `timeout` / `circuit_open` — the LLM call did not complete (timed out, or
 *   the adapter circuit breaker was open). Provider-unavailable family.
 * - `no_results` — retrieval produced no grounding to synthesize from.
 * - `policy_blocked` — security block / unsupported intent short-circuit.
 * - `llm_unavailable` — the structured-LLM PROVIDER was unavailable (HTTP
 *   transport rejection: auth / credit-exhausted / 4xx-5xx). The model never
 *   ran, so the runner fails honestly (no fabricated grounded answer) rather
 *   than naming an arbitrary wine. Provider-unavailable family.
 * - `unexpected_error` — an unmodeled exception (not a typed StructuredLlm*
 *   error). Distinguished from `malformed_llm_output` for ops triage.
 * - `ungrounded_claim` — S3 grounding-verify: the primary answer asserted a
 *   wine fact absent from the grounding union; one re-synth still ungrounded.
 * - `no_corpus_match` — Wave 1 (Cluster F): a high-confidence anchor resolved
 *   to 0 candidates; the deterministic `corpusGapAdmission` template wins.
 */
export const DEGRADED_REASONS = [
  'malformed_llm_output',
  'timeout',
  'circuit_open',
  'no_results',
  'policy_blocked',
  'llm_unavailable',
  'unexpected_error',
  'ungrounded_claim',
  'no_corpus_match',
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];
