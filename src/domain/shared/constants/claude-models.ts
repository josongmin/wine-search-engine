/**
 * Single Source of Truth for Anthropic / Claude model identifiers.
 *
 * Why centralize: model migrations (Haiku 4.5 → 4.7, Sonnet 4.6 → 4.7) used
 * to require hunting through 6+ files with hardcoded model strings, and
 * `gen-ai-tracing.ts` pricing lookups would silently degrade for any model
 * the migration missed. CLAUDE.md rule 30 mandates that any constant used in
 * 2+ files lives in a shared module and is imported from there.
 *
 * Tier semantics:
 *  - HAIKU   — fast/cheap; injection classifier, judge, structured-output adapter.
 *  - SONNET  — balanced; main planner / synthesis paths.
 *  - OPUS    — only if a code path explicitly opts in via env (not a default).
 *
 * When upgrading a model:
 *  1. Update the constant here.
 *  2. Add the new model id (and any version-suffixed alias) to the pricing
 *     table in `infrastructure/telemetry/gen-ai-tracing.ts`.
 *  3. Run `grep -rn "claude-haiku-4-\|claude-sonnet-4-\|claude-opus-4-" src/`
 *     and confirm no stragglers remain outside the pricing table.
 */

/** Latest stable Haiku tier — fast, low-cost. */
export const CLAUDE_HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';

/** Latest stable Sonnet tier — balanced reasoning. */
export const CLAUDE_SONNET_MODEL_ID = 'claude-sonnet-4-6';
