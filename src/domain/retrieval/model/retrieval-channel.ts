/**
 * T4.1: Retrieval Channel Contract
 *
 * Canonical channel vocabulary for the retrieval pipeline.
 * All channel names used in trace, port, profile, and dispatch
 * MUST reference this enum — never invent ad-hoc string literals.
 *
 * Channel taxonomy:
 *  - LEXICAL family: sparse_bm25, learned_sparse
 *  - SEMANTIC family: dense_semantic
 *  - STRUCTURAL family: anchor_similarity, relative_filter
 *  - SPECIALIZED family: browse_producer, browse_region, compare_anchor
 */
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';

// ---------------------------------------------------------------------------
// Channel enum
// ---------------------------------------------------------------------------

export const RETRIEVAL_CHANNELS = [
  // Lexical family
  'sparse_bm25',       // BM25 / inverted-index sparse retrieval
  'learned_sparse',    // SPLADE / learned sparse weights (T4.2+)

  // Semantic family
  'dense_semantic',    // General bi-encoder ANN

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
export const SEMANTIC_CHANNELS = ['dense_semantic'] as const satisfies readonly RetrievalChannel[];
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
 * Preferred canonical output labels for compatibility channels.
 *
 * The map is intentionally empty after compat removal; the helper remains as
 * the SSOT seam for any future raw-input aliases.
 */
export const PREFERRED_CHANNEL_ALIAS: Readonly<Record<string, string>> = {} as const;

/**
 * Coerce a legacy/unknown channel string to canonical RetrievalChannel.
 * Falls back to 'sparse_bm25' for unrecognized strings.
 */
export function toRetrievalChannel(raw: string): RetrievalChannel {
  if (isRetrievalChannel(raw)) return raw;
  const alias = LEGACY_CHANNEL_ALIAS[raw];
  if (alias !== undefined) return alias;
  globalSilentSkipCounter.increment('unknown_channel_fallback', {
    rawChannel: raw,
    fallback: 'sparse_bm25',
  });
  bootstrapLogger.warn(
    { rawChannel: raw, fallback: 'sparse_bm25' },
    '[toRetrievalChannel] unknown channel; falling back to sparse_bm25',
  );
  return 'sparse_bm25';
}

/**
 * Normalize a channel label to the preferred canonical outward-facing form
 * without coercing unknown strings to a fallback channel.
 */
export function preferCanonicalRetrievalChannelLabel(channel: string): string {
  return PREFERRED_CHANNEL_ALIAS[channel] ?? channel;
}

/**
 * Normalize an ordered channel list to preferred canonical outward-facing
 * labels while preserving first-seen order and removing duplicates created by
 * compatibility aliases.
 */
export function preferCanonicalRetrievalChannelLabels(
  channels: readonly string[],
): string[] {
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const channel of channels) {
    const next = preferCanonicalRetrievalChannelLabel(channel);
    if (!seen.has(next)) {
      seen.add(next);
      canonical.push(next);
    }
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// CandidateChannel guard + canonicalization (SSoT — bugbash A fix)
// CandidateChannel === RetrievalChannel (see candidate-envelope.ts).
// Using RetrievalChannel here to avoid circular imports.
// ---------------------------------------------------------------------------

/**
 * Type guard: is this string a known CandidateChannel (= RetrievalChannel)?
 * Delegates to isRetrievalChannel.
 */
export function isCandidateChannel(value: string): value is RetrievalChannel {
  return isRetrievalChannel(value);
}

/**
 * Canonicalize a raw channel string to CandidateChannel, returning null if
 * unrecognized. Used by candidate-pool and evidence-accumulator for
 * provenance normalization.
 */
export function toCanonicalCandidateChannel(channel: string): RetrievalChannel | null {
  const canonical = preferCanonicalRetrievalChannelLabel(channel);
  return isCandidateChannel(canonical) ? canonical : null;
}
