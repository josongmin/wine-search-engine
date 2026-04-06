/**
 * T4.1: Retrieval Channel Contract
 *
 * Canonical channel vocabulary for the retrieval pipeline.
 * All channel names used in trace, port, profile, and dispatch
 * MUST reference this enum — never invent ad-hoc string literals.
 *
 * Channel taxonomy:
 *  - LEXICAL family: sparse_bm25, learned_sparse
 *  - SEMANTIC family: dense_semantic, dense_anchor
 *  - STRUCTURAL family: anchor_similarity, relative_filter
 *  - SPECIALIZED family: browse_producer, browse_region, compare_anchor
 */

// ---------------------------------------------------------------------------
// Channel enum
// ---------------------------------------------------------------------------

export const RETRIEVAL_CHANNELS = [
  // Lexical family
  'sparse_bm25',       // BM25 / inverted-index sparse retrieval
  'learned_sparse',    // SPLADE / learned sparse weights (T4.2+)

  // Semantic family
  'dense_semantic',    // General bi-encoder ANN
  'dense_anchor',      // Anchor-conditioned ANN (T4.4)

  // Structural family
  'anchor_similarity', // anchor neighborhood (T4.4 upgrade)
  'relative_filter',   // relative query filter path (T4.5)

  // Specialized family
  'browse_producer',   // Producer-scoped browse
  'browse_region',     // Region-scoped browse
  'compare_anchor',    // Comparison against anchor entity
] as const;

export type RetrievalChannel = (typeof RETRIEVAL_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Channel family groupings
// ---------------------------------------------------------------------------

export const LEXICAL_CHANNELS = ['sparse_bm25', 'learned_sparse'] as const satisfies readonly RetrievalChannel[];
export const SEMANTIC_CHANNELS = ['dense_semantic', 'dense_anchor'] as const satisfies readonly RetrievalChannel[];
export const STRUCTURAL_CHANNELS = ['anchor_similarity', 'relative_filter'] as const satisfies readonly RetrievalChannel[];
export const SPECIALIZED_CHANNELS = ['browse_producer', 'browse_region', 'compare_anchor'] as const satisfies readonly RetrievalChannel[];

export type LexicalChannel = (typeof LEXICAL_CHANNELS)[number];
export type SemanticChannel = (typeof SEMANTIC_CHANNELS)[number];
export type StructuralChannel = (typeof STRUCTURAL_CHANNELS)[number];
export type SpecializedChannel = (typeof SPECIALIZED_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const CHANNEL_SET = new Set<string>(RETRIEVAL_CHANNELS);

export function isRetrievalChannel(value: string): value is RetrievalChannel {
  return CHANNEL_SET.has(value);
}

export function isLexicalChannel(ch: RetrievalChannel): ch is LexicalChannel {
  return (LEXICAL_CHANNELS as readonly string[]).includes(ch);
}

export function isSemanticChannel(ch: RetrievalChannel): ch is SemanticChannel {
  return (SEMANTIC_CHANNELS as readonly string[]).includes(ch);
}

export function isSpecializedChannel(ch: RetrievalChannel): ch is SpecializedChannel {
  return (SPECIALIZED_CHANNELS as readonly string[]).includes(ch);
}

// ---------------------------------------------------------------------------
// Legacy alias map (backward compat for existing trace string literals)
// ---------------------------------------------------------------------------

/**
 * Maps old ad-hoc trace strings ('sparse', 'dense', 'anchor') to canonical
 * RetrievalChannel values. Used by migration shims.
 */
export const LEGACY_CHANNEL_ALIAS: Readonly<Record<string, RetrievalChannel>> = {
  sparse: 'sparse_bm25',
  dense: 'dense_semantic',
  anchor: 'anchor_similarity',
  learned_sparse: 'learned_sparse',
} as const;

/**
 * Coerce a legacy/unknown channel string to canonical RetrievalChannel.
 * Falls back to 'sparse_bm25' for unrecognized strings.
 */
export function toRetrievalChannel(raw: string): RetrievalChannel {
  if (isRetrievalChannel(raw)) return raw;
  const alias = LEGACY_CHANNEL_ALIAS[raw];
  return alias ?? 'sparse_bm25';
}
