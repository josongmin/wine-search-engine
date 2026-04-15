/**
 * ADR-016 — caps for evidence text embedded in small LLM NLI prompts.
 * Keeps verifier prompts bounded for cost and context-window safety.
 */

/** Max chars of `evidenceContext` injected into atomic-claim NLI prompts. */
export const ATOMIC_CLAIM_EVIDENCE_CONTEXT_PROMPT_MAX_CHARS = 2000;
