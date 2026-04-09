/**
 * HyDE (Hypothetical Document Embeddings) prompt builder.
 *
 * Reference: Gao et al. 2022, "Precise Zero-Shot Dense Retrieval without
 * Relevance Labels". HyDE asks an LLM to generate a hypothetical passage for
 * a query, then embeds the passage (instead of the raw query) for dense
 * retrieval. This closes the query/document representation gap.
 *
 * This module is a PURE prompt builder: no I/O, no LLM calls. The caller is
 * responsible for actually invoking a chat model with the returned prompt.
 */

import type { QueryIntent } from '../model/query-intent.js';

export interface HyDERequest {
  readonly query: string;
  readonly intent: QueryIntent;
}

export interface HyDEPrompt {
  readonly system: string;
  readonly user: string;
  /** true when the calling intent should NOT run HyDE expansion at all. */
  readonly skip: boolean;
}

/**
 * Constant system prompt. Kept short to preserve the generation budget for
 * the hypothetical passage itself (~150 words). The 150-word cap roughly
 * matches one dense-retrieval passage chunk in the index.
 */
const HYDE_SYSTEM_PROMPT =
  'You are a wine sommelier. Output only the description, no preamble. Maximum 150 words.';

/**
 * Per-intent user-prompt templates. Each template produces a hypothetical
 * passage shaped like the kind of document the retriever ought to match.
 */
const HYDE_USER_TEMPLATES: Readonly<Record<QueryIntent, (query: string) => string>> = {
  entity_exact: (q) =>
    `Write a one-paragraph Wikipedia-style description of the wine: ${q}. Include producer, region, vintage, grape varieties, and tasting notes.`,
  entity_fuzzy: (q) =>
    `Write a one-paragraph Wikipedia-style description of the wine: ${q}. Include producer, region, vintage, grape varieties, and tasting notes.`,
  facet_search: (q) =>
    `Write a one-paragraph wine description matching these criteria: ${q}. Include the wine's region, grape composition, and style.`,
  semantic_discovery: (q) =>
    `Write a one-paragraph tasting note for a wine that fits this preference: ${q}. Focus on flavor, body, and structure.`,
  pairing_search: (q) =>
    `Write a tasting note for a wine that pairs perfectly with: ${q}. Explain why it pairs well.`,
  budget_search: (q) =>
    `Write a description of a value wine matching the budget criteria: ${q}.`,
  comparison_search: (q) =>
    `Write a one-paragraph comparison between: ${q}. Highlight regional and stylistic differences.`,
  mixed_query: (q) => `Write a one-paragraph wine description matching: ${q}.`,
};

/**
 * Intents that should NOT use HyDE. Currently none of the recognised intents
 * short-circuit, but this set exists so future additions (e.g. a
 * `knowledge_question` intent) can opt out without touching call sites.
 */
const HYDE_SKIP_INTENTS: ReadonlySet<QueryIntent> = new Set<QueryIntent>();

export function buildHyDEPrompt(request: HyDERequest): HyDEPrompt {
  const { query, intent } = request;
  if (HYDE_SKIP_INTENTS.has(intent)) {
    return { system: HYDE_SYSTEM_PROMPT, user: '', skip: true };
  }
  const template = HYDE_USER_TEMPLATES[intent];
  return {
    system: HYDE_SYSTEM_PROMPT,
    user: template(query),
    skip: false,
  };
}
