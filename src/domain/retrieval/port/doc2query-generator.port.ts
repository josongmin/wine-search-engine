/**
 * Port (driven side) for Doc2Query-style document expansion by query
 * prediction.
 *
 * At index time, a generator model produces N synthetic queries that the
 * document COULD answer. These queries are stored in a dedicated BM25
 * field (`synthetic_queries`) so the inverted index matches more diverse
 * user phrasings — typos, Korean natural-language, food pairings, and
 * slot-specific intents that the original document text misses.
 *
 * Reference: Nogueira et al. 2019
 * "Document Expansion by Query Prediction" (arXiv:1904.08375).
 *
 * SOTA++ adaptations for this project (2026-04-10):
 *   - Structured wine input (not just free text) so the prompt can build
 *     slot-specific queries grounded in producer / region / grape / price.
 *   - Korean alias injection to prevent hallucinated romanization.
 *   - Slot-based output contract with explicit Korean natural-language
 *     slots (food pairing, occasion, style, beginner, hashtag).
 */

/**
 * Structured input for Doc2Query generation. Implementations should use
 * every field they can to ground synthetic queries in the actual wine
 * attributes — avoiding hallucination, covering intent slots, and
 * exploiting existing Korean aliases produced by upstream ETL stages.
 */
export interface Doc2QueryInput {
  readonly canonicalLabel: string;
  readonly producer: string;
  /** Full region path, e.g. "Spain / Ribera del Duero / Castilla y León". */
  readonly region: string;
  /** ISO country name when available; '' when the upstream field is empty. */
  readonly country: string;
  /** Primary grape variety when available (null in much of the corpus). */
  readonly grapePrimary: string | null;
  readonly grapes: readonly string[];
  /** Body score in [0, 1]. Often 0.5 default in the current corpus. */
  readonly body: number;
  /** Tannin score in [0, 1]. Often 0.5 default. */
  readonly tannin: number;
  readonly priceUsd: number | null;
  /** 'value' | 'mid' | 'premium' | 'luxury'. */
  readonly priceBand: string;
  readonly vintageYear: number | null;
  readonly alcoholPct: number | null;
  readonly flavorProfiles: readonly string[];
  readonly pairingTags: readonly string[];
  /** Drinking window hint when present. */
  readonly drinkingWindowStart: number | null;
  readonly drinkingWindowEnd: number | null;
  readonly isTopRated: boolean;
  /**
   * Korean aliases already validated by the upstream
   * `generate-korean-aliases.ts` step. Injecting these into the prompt
   * lets the LLM reuse canonical Korean romanization instead of
   * hallucinating its own (e.g. "페트뤼스" vs "피에르뤼스").
   */
  readonly koreanAliases: readonly string[];
  /** Number of synthetic queries to request (slot budget). */
  readonly numQueries: number;
}

export interface Doc2QueryGeneration {
  readonly entityId: string;
  readonly syntheticQueries: readonly string[];
}

export interface Doc2QueryGeneratorPort {
  /**
   * Generate N synthetic queries that this wine document COULD answer.
   *
   * Implementations MUST return an empty array when `numQueries <= 0` or
   * when `canonicalLabel` is empty/whitespace-only (no I/O, no model
   * invocation). On partial failures (e.g. LLM returns 10 when 15 were
   * requested), implementations SHOULD return whatever usable queries
   * came back rather than throwing.
   */
  generate(input: Doc2QueryInput): Promise<readonly string[]>;

  readonly modelId: string;
}
