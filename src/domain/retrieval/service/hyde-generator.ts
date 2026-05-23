/**
 * HyDE (Hypothetical Document Embeddings) generator.
 *
 * Why
 * ---
 * For attribute / exploratory / food-pairing queries, the query and the
 * matching document have asymmetric vocabularies: a user asks
 * "스테이크에 어울리는 와인" but the matching wine description reads
 * "Cabernet Sauvignon with firm tannins and dark fruit, ideal companion
 * for grilled red meats". Embedding the query directly is sub-optimal —
 * embedding a *hypothetical* answer document and using THAT vector to
 * retrieve closes the gap (Gao et al., 2022 — "Precise Zero-Shot Dense
 * Retrieval without Relevance Labels").
 *
 * This generator asks a small LLM to write a 1-2 paragraph wine
 * description an ideal match would carry, then returns that string. The
 * caller adds it to `semanticEmbeddingQueries` (alongside the original);
 * candidate-pool embeds it and includes it in the dense-retrieval combine.
 *
 * Intent gating
 * -------------
 * Entity-lookup / comparative queries should NOT be answered by a
 * hallucinated doc — exact-match logic owns them. We return `null` for
 * those classes (skip).
 *
 * Failure mode
 * ------------
 * Hard 5s timeout. On any LLM/validation failure we return `null`. First
 * failure per process logs at warn; subsequent failures are silent.
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import type {
  StructuredLlmPort,
} from '../../ai/port/structured-llm.port.js';
import type { IntentClass } from './multi-query-generator.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Intent classes that bypass HyDE. Exact-match identity paths must not
 *  let a hallucinated doc dictate retrieval direction. */
const HYDE_SKIP_INTENTS: ReadonlySet<IntentClass> = new Set([
  'entity_lookup',
  'comparative',
]);

/** Hard wall-clock timeout for the LLM call. */
const HYDE_TIMEOUT_MS = 5000;

/** Max output tokens — sized for a 1-2 paragraph description. */
const HYDE_MAX_OUTPUT_TOKENS = 400;

/** Maximum length of the hypothetical doc, enforced by Zod. Roughly the
 *  size of an enriched wine description in the catalog so the embedded
 *  vector stays in-distribution with corpus documents. */
const HYDE_DOC_MAX_CHARS = 800;

/** Lower bound — anything shorter is unlikely to provide meaningful
 *  semantic signal beyond the original query. */
const HYDE_DOC_MIN_CHARS = 40;

/** Deterministic seed so HyDE docs are stable across replays. */
const HYDE_LLM_SEED = 5147;

/** First-failure-only log gate. Module-scope so the warning fires once
 *  per process (mirrors the multi-query generator's policy). */
let hydeFailureLogged = false;

// ---------------------------------------------------------------------------
// Prompt (module-scope, not inlined at call site)
// ---------------------------------------------------------------------------

const HYDE_SYSTEM_PROMPT = `You are a sommelier writing wine descriptions to seed a dense-vector retrieval index.

Given a user's wine search query, write a SHORT hypothetical wine description (1-2 paragraphs, max ${HYDE_DOC_MAX_CHARS} characters) that an ideal matching wine in our catalog would carry. The description should read like a real catalog entry, NOT a recommendation to the user.

Rules:
1. Be CONCRETE — name plausible grapes, regions, vintages, flavor notes, tannin/acidity profile, body, food pairings as relevant to the query. DO NOT use words like "could", "might", "perhaps".
2. Stay GENERIC if the query is broad. Do not invent a specific producer or SKU — describe a category-archetype wine.
3. Match the query language. Korean query → Korean description. English → English. Mixed input → English unless the wine context is clearly Korean.
4. NO marketing copy. NO second-person ("you'll love", "perfect for you"). NO closing sentences inviting purchase.
5. NO headings, lists, or markdown. Plain prose only.

Output strictly JSON matching: { "document": string }.`;

const HYDE_TOOL_NAME = 'emit_hypothetical_document';
const HYDE_TOOL_DESCRIPTION =
  'Emit a short hypothetical wine catalog description matching the user query.';

// ---------------------------------------------------------------------------
// Response schema (NOT .strict() — LLM tool output, rule 10 exception)
// ---------------------------------------------------------------------------

export const HydeResponseSchema = z.object({
  document: z
    .string()
    .min(HYDE_DOC_MIN_CHARS)
    .max(HYDE_DOC_MAX_CHARS),
});
export type HydeResponse = z.infer<typeof HydeResponseSchema>;

// ---------------------------------------------------------------------------
// Generator interface + factory
// ---------------------------------------------------------------------------

export interface HydeGenerator {
  /**
   * Generate a hypothetical document for `query`. Returns `null` for
   * intents that skip HyDE, or on any LLM/validation failure.
   */
  generate(query: string, intent: IntentClass): Promise<string | null>;
}

export interface HydeGeneratorDeps {
  readonly structuredLlm: StructuredLlmPort;
  readonly model: string;
}

export function createHydeGenerator(deps: HydeGeneratorDeps): HydeGenerator {
  return {
    async generate(query, intent) {
      const trimmed = query.trim();
      if (trimmed.length === 0) return null;
      if (HYDE_SKIP_INTENTS.has(intent)) return null;

      try {
        const result = await deps.structuredLlm.analyze({
          query: trimmed,
          schema: HydeResponseSchema,
          systemPrompt: HYDE_SYSTEM_PROMPT,
          maxOutputTokens: HYDE_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: HYDE_TIMEOUT_MS,
          model: deps.model,
          seed: HYDE_LLM_SEED,
        });
        const doc = result.data.document.trim();
        if (doc.length < HYDE_DOC_MIN_CHARS) {
          return null;
        }
        return doc;
      } catch (err) {
        if (!hydeFailureLogged) {
          hydeFailureLogged = true;
          bootstrapLogger.warn(
            {
              component: 'HydeGenerator',
              err_name: err instanceof Error ? err.name : 'unknown',
              err_message: err instanceof Error ? err.message : String(err),
            },
            '[HydeGenerator] LLM call failed — degrading to no HyDE (this warning fires once per process)',
          );
        }
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test seam.
// ---------------------------------------------------------------------------

/** @internal — resets the module-scope first-failure-log gate so tests
 *  can independently verify the "log once" behaviour. */
export function __resetHydeFailureLogForTests(): void {
  hydeFailureLogged = false;
}

// ---------------------------------------------------------------------------
// Tool definition (unused by `analyze` directly, but exported for
// future callers that prefer the `execute` path).
// ---------------------------------------------------------------------------

export const HYDE_TOOL = {
  name: HYDE_TOOL_NAME,
  description: HYDE_TOOL_DESCRIPTION,
  inputSchema: HydeResponseSchema,
} as const;
