/**
 * Multi-Query Rewrite generator — pre-retrieval semantic-query fan-out.
 *
 * Why
 * ---
 * The hybrid retrieval pipeline runs ONE semantic embedding against
 * Vespa nearestNeighbor by default. For vague natural-language queries
 * ("바디감 좋은 가성비 레드", "스테이크에 어울리는 와인") this caps recall
 * because of query↔document embedding asymmetry.
 *
 * This generator asks a small LLM for up to {@link MULTI_QUERY_MAX_REWRITES}
 * semantic rewrites and returns the ORIGINAL query first, followed by
 * deduplicated rewrites. Downstream the retriever fuses them via RRF
 * (existing candidate-pool fan-out across `lexicalQueries[]` +
 * `semanticQueries[]`).
 *
 * Intent gating
 * -------------
 * Entity-lookup / comparative intents do NOT benefit from multi-query
 * fan-out — they need exact-match identity. We skip the LLM round-trip
 * for those classes and return `[query]` unchanged.
 *
 * Failure mode
 * ------------
 * Hard 5s timeout. On timeout, validation failure, or any LLM error we
 * return `[query]` (don't crash retrieval). The first failure per process
 * is logged at warn level; subsequent failures are silent to avoid log
 * spam (an OpenAI outage would otherwise blow the logs).
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import type {
  StructuredLlmPort,
} from '../../ai/port/structured-llm.port.js';

// ---------------------------------------------------------------------------
// Intent gating (CLAUDE.md rule 15 — named module-scope constants)
// ---------------------------------------------------------------------------

/**
 * Intent classes consumed by this module. Defined locally (rather than
 * imported from `wine-search-schemas.ts`) because the QueryIntent enum
 * in that schema does NOT carry an `entity_lookup` label — the SearchUC
 * call site derives it from `QueryClass` + retrieval mode.
 *
 * Mapping (caller-side):
 *  - `exact_entity` / `short_entity` / `anchored_similarity` → `entity_lookup`
 *  - `comparison_query` / mode=`compare_candidates`         → `comparative`
 *  - `pair`-intent / pairing constraints present            → `food_pairing`
 *  - `semantic_preference`                                  → `exploratory`
 *  - everything else                                        → `attribute_search`
 */
export type IntentClass =
  | 'entity_lookup'
  | 'comparative'
  | 'food_pairing'
  | 'exploratory'
  | 'attribute_search';

/** Intent classes that bypass multi-query fan-out — exact-match paths
 *  don't benefit and shouldn't pay the LLM round-trip. */
const MULTI_QUERY_SKIP_INTENTS: ReadonlySet<IntentClass> = new Set([
  'entity_lookup',
  'comparative',
]);

/** Maximum number of LLM-generated rewrites (NOT counting the original).
 *  Cap of 3 keeps total semantic queries bounded at 4 (5 with HyDE). */
export const MULTI_QUERY_MAX_REWRITES = 3;

/** Hard wall-clock timeout for the LLM call. */
const MULTI_QUERY_TIMEOUT_MS = 5000;

/** Max tokens for rewrite output — three short rewrites + JSON envelope. */
const MULTI_QUERY_MAX_OUTPUT_TOKENS = 300;

/** Per-rewrite string length cap. Larger than the longest realistic
 *  natural-language wine query but smaller than the query-validation
 *  ceiling so a hallucinated paragraph cannot blow downstream limits. */
const MULTI_QUERY_REWRITE_MAX_CHARS = 240;

/** Deterministic seed so rewrites are stable across replays. */
const MULTI_QUERY_LLM_SEED = 9132;

/** First-failure-only log gate. Module-scope so the warning fires once
 *  per process instead of spamming logs during an LLM outage. */
let multiQueryFailureLogged = false;

// ---------------------------------------------------------------------------
// Module-scope deterministic data (rule 16)
// ---------------------------------------------------------------------------

/** Pre-allocated empty result for the skip path. Avoids per-call array
 *  allocation in the (common) entity_lookup case. */
const EMPTY_REWRITES: readonly string[] = Object.freeze([]);

/** Zod-validated LLM response. NOT `.strict()` — LLM tool output (rule 10
 *  exception). The `rewrites` array is bounded with `.max()` to defend
 *  against runaway hallucinations (schema-quality bar). */
export const MultiQueryRewriteResponseSchema = z.object({
  rewrites: z
    .array(
      z
        .string()
        .min(1)
        .max(MULTI_QUERY_REWRITE_MAX_CHARS),
    )
    .max(MULTI_QUERY_MAX_REWRITES),
});
export type MultiQueryRewriteResponse = z.infer<typeof MultiQueryRewriteResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt (module-scope, not inlined at call site)
// ---------------------------------------------------------------------------

const MULTI_QUERY_SYSTEM_PROMPT = `You are a query rewriting expert for a wine search engine.

Given a user's wine search query, generate up to ${MULTI_QUERY_MAX_REWRITES} semantically-equivalent rewrites that capture the same intent but use DIFFERENT phrasings, synonyms, and emphasis. The goal is to maximize recall against a dense-vector wine catalog.

Rules:
1. Preserve the user's core intent — do not narrow, broaden, or add filters they did not specify.
2. Emit rewrites that a wine description (NOT a question) might match against. Convert questions into declarative phrases.
3. Cover different angles: one rewrite emphasizing taste/style, one emphasizing region/grape, one emphasizing occasion/pairing — whichever apply.
4. Do NOT repeat the original query verbatim. Each rewrite must be distinct.
5. Each rewrite must be a single phrase, max ${MULTI_QUERY_REWRITE_MAX_CHARS} characters.
6. Keep the user's language — Korean queries → Korean rewrites, English → English. Bilingual queries may mix.

Output strictly JSON matching: { "rewrites": string[] }.`;

const MULTI_QUERY_TOOL_NAME = 'emit_query_rewrites';
const MULTI_QUERY_TOOL_DESCRIPTION =
  'Emit up to N semantically-equivalent rewrites of the user query for retrieval fan-out.';

// ---------------------------------------------------------------------------
// Generator interface + factory
// ---------------------------------------------------------------------------

export interface MultiQueryGenerator {
  /**
   * Generate rewrites for `query`. Always returns at least `[query]`.
   * Never throws — LLM/validation failures degrade to the single-query
   * path with a first-time warn log.
   */
  generate(query: string, intent: IntentClass): Promise<readonly string[]>;
}

export interface MultiQueryGeneratorDeps {
  readonly structuredLlm: StructuredLlmPort;
  readonly model: string;
}

/**
 * Build a MultiQueryGenerator backed by a {@link StructuredLlmPort}.
 *
 * The factory captures the `model` and `structuredLlm` at construction
 * time. Tests inject a stub port; production wires the same
 * `StructuredLlmPort` instance as the wine-search orchestrator.
 */
export function createMultiQueryGenerator(
  deps: MultiQueryGeneratorDeps,
): MultiQueryGenerator {
  return {
    async generate(query, intent) {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return EMPTY_REWRITES;
      }
      if (MULTI_QUERY_SKIP_INTENTS.has(intent)) {
        return [trimmed];
      }

      let rewrites: readonly string[];
      try {
        const result = await deps.structuredLlm.analyze({
          query: trimmed,
          schema: MultiQueryRewriteResponseSchema,
          systemPrompt: MULTI_QUERY_SYSTEM_PROMPT,
          maxOutputTokens: MULTI_QUERY_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: MULTI_QUERY_TIMEOUT_MS,
          model: deps.model,
          seed: MULTI_QUERY_LLM_SEED,
        });
        rewrites = result.data.rewrites;
      } catch (err) {
        if (!multiQueryFailureLogged) {
          multiQueryFailureLogged = true;
          bootstrapLogger.warn(
            {
              component: 'MultiQueryGenerator',
              err_name: err instanceof Error ? err.name : 'unknown',
              err_message: err instanceof Error ? err.message : String(err),
            },
            '[MultiQueryGenerator] LLM call failed — degrading to single-query retrieval (this warning fires once per process)',
          );
        }
        return [trimmed];
      }

      // Dedupe case-insensitively against the original + each other.
      // Preserve casing from whichever variant arrived first.
      const seen = new Set<string>([trimmed.toLowerCase()]);
      const out: string[] = [trimmed];
      for (const rewrite of rewrites) {
        const candidate = rewrite.trim();
        if (candidate.length === 0) continue;
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
        if (out.length >= MULTI_QUERY_MAX_REWRITES + 1) break;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Test seam: reset the first-failure-log gate between tests.
// ---------------------------------------------------------------------------

/** @internal — intended for vitest setup/teardown. Resets the
 *  module-scope first-failure-log gate so tests can independently
 *  verify the "log once" behaviour. */
export function __resetMultiQueryFailureLogForTests(): void {
  multiQueryFailureLogged = false;
}

// ---------------------------------------------------------------------------
// Tool definition (unused by `analyze` directly, but exported for any
// future call sites that prefer the `execute` path with explicit tools).
// ---------------------------------------------------------------------------

export const MULTI_QUERY_TOOL = {
  name: MULTI_QUERY_TOOL_NAME,
  description: MULTI_QUERY_TOOL_DESCRIPTION,
  inputSchema: MultiQueryRewriteResponseSchema,
} as const;
