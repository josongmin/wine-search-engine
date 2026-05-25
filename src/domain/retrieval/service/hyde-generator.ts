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
import {
  HYDE_DOC_MAX_CHARS,
  HYDE_PROMPT_VERSION,
  HYDE_SYSTEM_PROMPT,
  HYDE_SYSTEM_PROMPT_FINGERPRINT,
  type HydePromptVersion,
} from './prompts/hyde-system-prompt.js';

// Re-export prompt governance constants so downstream observability /
// tracing / bench-replay code can read them from the generator module
// without depending on the prompt subdirectory directly.
export {
  HYDE_PROMPT_VERSION,
  HYDE_SYSTEM_PROMPT_FINGERPRINT,
  type HydePromptVersion,
};

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

/** Lower bound — anything shorter is unlikely to provide meaningful
 *  semantic signal beyond the original query. */
const HYDE_DOC_MIN_CHARS = 40;

/** Deterministic seed so HyDE docs are stable across replays. */
const HYDE_LLM_SEED = 5147;

/** First-failure-only log gate. Module-scope so the warning fires once
 *  per process (mirrors the multi-query generator's policy). */
let hydeFailureLogged = false;

// ---------------------------------------------------------------------------
// Prompt lives in ./prompts/hyde-system-prompt.ts (version + fingerprint).
// ---------------------------------------------------------------------------

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

  /** Semantic version of the system prompt this generator is bound to.
   *  Surface in tracing / bench-replay artefacts to detect drift. */
  readonly promptVersion: HydePromptVersion;

  /** Short deterministic content fingerprint of the prompt text. */
  readonly promptFingerprint: string;
}

export interface HydeGeneratorDeps {
  readonly structuredLlm: StructuredLlmPort;
  readonly model: string;
}

export function createHydeGenerator(deps: HydeGeneratorDeps): HydeGenerator {
  return {
    promptVersion: HYDE_PROMPT_VERSION,
    promptFingerprint: HYDE_SYSTEM_PROMPT_FINGERPRINT,
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
