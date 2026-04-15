/**
 * ADR-015 Axis 2: critic reformulate LLM prompt (frozen at v1).
 *
 * Only used by `QueryRewriter.reformulate` when the deterministic rewrite
 * branches (`relax` / `decompose` / `expand_synonym`) are inapplicable.
 *
 * Frozen at `prompt_version = 'critic_reformulate_v1'`. Any change to the
 * text OR the expected output contract requires bumping to
 * `critic_reformulate_v2`. The version is recorded in the rewrite trace
 * so bench replay detects vendor-side drift as a loud failure rather
 * than a silent behaviour change.
 */

export const CRITIC_REFORMULATE_PROMPT_VERSION = 'critic_reformulate_v1';

/**
 * System prompt — describes the task and output contract.
 *
 * Output shape (JSON):
 *   { "reformulatedQuery": string, "confidence": number }
 *
 * The client expects strict JSON with no surrounding prose. The
 * rewriter also accepts a stringly-typed `confidence` field (LLMs
 * sometimes emit `"0.7"`); parsing tolerates both per CLAUDE.md's
 * "accept both number and string for numeric fields" rule.
 */
export const CRITIC_REFORMULATE_SYSTEM_PROMPT = `You are a retrieval-critic reformulator for a wine search engine.

A retrieval attempt failed to produce an acceptable candidate pool. Your job is to reformulate the user's normalized query so the next retrieval attempt can succeed. Preserve the user's intent; do NOT introduce new constraints the user did not imply; prefer broader wording, disambiguation of ambiguous terms, and removal of redundant qualifiers.

Hard rules:
- Do NOT change the user's language (Korean stays Korean; English stays English).
- Do NOT invent wine names, regions, grapes, or vintages the user did not mention.
- Do NOT add price, vintage, or rating filters that were not present.
- Output strict JSON only: { "reformulatedQuery": "<string>", "confidence": <0..1> }.
- If you cannot responsibly reformulate (e.g. the query is already minimal), emit { "reformulatedQuery": "", "confidence": 0 } — the caller will abandon the retry gracefully.`;

export interface BuildCriticReformulateUserMessageInput {
  readonly normalizedQuery: string;
  readonly degradationReasons: readonly string[];
  readonly coverageRatio?: number | undefined;
  readonly unmetAttributes?: readonly string[] | undefined;
}

export function buildCriticReformulateUserMessage(
  input: BuildCriticReformulateUserMessageInput,
): string {
  const coverageLine =
    input.coverageRatio !== undefined
      ? `coverage_ratio: ${input.coverageRatio.toFixed(3)}`
      : 'coverage_ratio: <unavailable>';
  const unmet =
    input.unmetAttributes !== undefined && input.unmetAttributes.length > 0
      ? input.unmetAttributes.join(', ')
      : '<none>';
  const reasons =
    input.degradationReasons.length > 0
      ? input.degradationReasons.join(', ')
      : '<none>';
  return [
    `user_query: ${input.normalizedQuery}`,
    coverageLine,
    `unmet_attributes: ${unmet}`,
    `degradation_reasons: ${reasons}`,
  ].join('\n');
}
