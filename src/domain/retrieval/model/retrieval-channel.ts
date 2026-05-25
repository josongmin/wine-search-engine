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
import { DomainError } from '../../shared/error/domain-error.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';

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

/**
 * Named channel ids — prefer these over raw string literals at call sites
 * (RetrievalChannel SSoT codemod). Values mirror {@link RETRIEVAL_CHANNELS}.
 */
export const RETRIEVAL_CHANNEL_SPARSE_BM25 = 'sparse_bm25' as const satisfies RetrievalChannel;
/** SPLADE / learned sparse weights channel. */
export const RETRIEVAL_CHANNEL_LEARNED_SPARSE = 'learned_sparse' as const satisfies RetrievalChannel;
/** General bi-encoder ANN semantic channel. */
export const RETRIEVAL_CHANNEL_DENSE_SEMANTIC = 'dense_semantic' as const satisfies RetrievalChannel;
/** Anchor-neighborhood structural channel. */
export const RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY = 'anchor_similarity' as const satisfies RetrievalChannel;
/** Relative query filter structural channel. */
export const RETRIEVAL_CHANNEL_RELATIVE_FILTER = 'relative_filter' as const satisfies RetrievalChannel;
/** Producer-scoped browse channel. */
export const RETRIEVAL_CHANNEL_BROWSE_PRODUCER = 'browse_producer' as const satisfies RetrievalChannel;
/** Region-scoped browse channel. */
export const RETRIEVAL_CHANNEL_BROWSE_REGION = 'browse_region' as const satisfies RetrievalChannel;
/** Comparison against anchor entity channel. */
export const RETRIEVAL_CHANNEL_COMPARE_ANCHOR = 'compare_anchor' as const satisfies RetrievalChannel;

/** All named channel constants in {@link RETRIEVAL_CHANNELS} order. */
export const RETRIEVAL_CHANNEL_CONSTANTS = [
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_BROWSE_PRODUCER,
  RETRIEVAL_CHANNEL_BROWSE_REGION,
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const CHANNEL_SET = new Set<string>(RETRIEVAL_CHANNELS);

export function isRetrievalChannel(value: string): value is RetrievalChannel {
  return CHANNEL_SET.has(value);
}

// ---------------------------------------------------------------------------
// Legacy alias map (backward compat for existing trace string literals)
// ---------------------------------------------------------------------------

/**
 * Maps old ad-hoc trace strings ('sparse', 'dense', 'anchor') to canonical
 * RetrievalChannel values. Used by migration shims.
 */
const LEGACY_CHANNEL_ALIAS: Readonly<Record<string, RetrievalChannel>> = {
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
const PREFERRED_CHANNEL_ALIAS: Readonly<Record<string, string>> = {} as const;

/**
 * Coerce a legacy channel alias to canonical RetrievalChannel.
 * Unknown strings are rejected instead of falling back.
 */
export function toRetrievalChannel(raw: string): RetrievalChannel {
  if (isRetrievalChannel(raw)) return raw;
  const alias = LEGACY_CHANNEL_ALIAS[raw];
  if (alias !== undefined) return alias;

  globalSilentSkipCounter.increment('unknown_channel_fallback', {
    rawChannel: raw,
    outcome: 'rejected',
  });
  bootstrapLogger.warn(
    { rawChannel: raw },
    '[toRetrievalChannel] unknown channel; rejecting',
  );
  throw new DomainError('INTERNAL_INCONSISTENCY', `Unknown retrieval channel: ${raw}`);
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
function isCandidateChannel(value: string): value is RetrievalChannel {
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
