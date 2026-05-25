/**
 * HyDE (Hypothetical Document Embeddings) system prompt — frozen at `v1`.
 *
 * Why a separate module
 * ---------------------
 * The HyDE prompt seeds a *dense vector* into the retrieval combine. Any
 * change to its wording shifts the embedding distribution and silently
 * invalidates historical bench comparisons. Splitting the prompt into its
 * own module + version constant + content fingerprint lets us:
 *   1. Lock the bench-replay contract on `HYDE_PROMPT_VERSION`.
 *   2. Detect accidental text drift via `HYDE_SYSTEM_PROMPT_FINGERPRINT`
 *      (drift forces a loud regression-test failure rather than a silent
 *      embedding shift).
 *   3. Surface the version in tracing/observability without coupling the
 *      generator's body to a magic string.
 *
 * If you intentionally change the prompt text:
 *   - Bump `HYDE_PROMPT_VERSION` (e.g. `'v1' → 'v2'`).
 *   - Update the locked fingerprint in
 *     `test/regression/hyde-prompt-version-fingerprint.regression.test.ts`
 *     to match the new text.
 *   - Add a CHANGELOG / RFC note so eval comparisons against historical
 *     embeddings are interpreted correctly.
 */

import { createHash } from 'node:crypto';

/** Maximum length of the hypothetical doc, enforced by Zod. Roughly the
 *  size of an enriched wine description in the catalog so the embedded
 *  vector stays in-distribution with corpus documents. Lives here so the
 *  fingerprint covers the literal value baked into the prompt body. */
export const HYDE_DOC_MAX_CHARS = 800;

/** Semantic version of the HyDE prompt. Bump on ANY text change. */
export const HYDE_PROMPT_VERSION = 'v1' as const;
export type HydePromptVersion = typeof HYDE_PROMPT_VERSION;

/**
 * System prompt for the HyDE generator. Byte-for-byte identical to the
 * v1 inline string previously embedded in `hyde-generator.ts`.
 *
 * The `${HYDE_DOC_MAX_CHARS}` interpolation is part of the *frozen*
 * prompt text — changing `HYDE_DOC_MAX_CHARS` will change the
 * fingerprint and forces a `HYDE_PROMPT_VERSION` bump.
 */
export const HYDE_SYSTEM_PROMPT = `You are a sommelier writing wine descriptions to seed a dense-vector retrieval index.

Given a user's wine search query, write a SHORT hypothetical wine description (1-2 paragraphs, max ${HYDE_DOC_MAX_CHARS} characters) that an ideal matching wine in our catalog would carry. The description should read like a real catalog entry, NOT a recommendation to the user.

Rules:
1. Be CONCRETE — name plausible grapes, regions, vintages, flavor notes, tannin/acidity profile, body, food pairings as relevant to the query. DO NOT use words like "could", "might", "perhaps".
2. Stay GENERIC if the query is broad. Do not invent a specific producer or SKU — describe a category-archetype wine.
3. Match the query language. Korean query → Korean description. English → English. Mixed input → English unless the wine context is clearly Korean.
4. NO marketing copy. NO second-person ("you'll love", "perfect for you"). NO closing sentences inviting purchase.
5. NO headings, lists, or markdown. Plain prose only.

Output strictly JSON matching: { "document": string }.`;

/** Length (hex chars) of the truncated SHA-256 fingerprint. 16 hex chars
 *  = 64 bits — collision-resistant enough for drift detection while
 *  staying short enough to embed in logs / traces / bench artefacts. */
const HYDE_PROMPT_FINGERPRINT_HEX_LEN = 16;

/**
 * Deterministic short fingerprint of {@link HYDE_SYSTEM_PROMPT}.
 *
 * Uses SHA-256 (Node built-in `crypto`) truncated per
 * {@link HYDE_PROMPT_FINGERPRINT_HEX_LEN}.
 *
 * Pure function of the prompt string, so identical input always yields
 * identical output across processes / Node versions / OSes.
 */
export function computeHydePromptFingerprint(prompt: string): string {
  return createHash('sha256')
    .update(prompt, 'utf8')
    .digest('hex')
    .slice(0, HYDE_PROMPT_FINGERPRINT_HEX_LEN);
}

/** Computed at module load — stable across all importers in a process. */
export const HYDE_SYSTEM_PROMPT_FINGERPRINT: string =
  computeHydePromptFingerprint(HYDE_SYSTEM_PROMPT);
