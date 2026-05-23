/**
 * Multi-query semantic-query fan-out for hybrid retrieval.
 *
 * Combines the original query, LLM-generated rewrites, and an optional
 * HyDE document into a deduplicated, capped list of semantic queries
 * the candidate pool will run against Vespa.
 *
 * Cap rationale (rule 15):
 *  - 1 original + up to 3 rewrites + 1 HyDE = 5 maximum.
 *  - The candidate pool combines all semantic embeddings into ONE primary
 *    vector via {@link combineSemanticEmbeddings}. A cap of 5 keeps the
 *    embedding-batch payload + average-vector geometry well-behaved and
 *    bounds Vespa per-request load.
 */

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Maximum number of semantic queries in the final fanout. Rule 22:
 *  this aligns with `MULTI_QUERY_MAX_REWRITES=3` + 1 original + 1 HyDE. */
export const MULTI_QUERY_FANOUT_MAX_QUERIES = 5;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface MultiQueryFanoutInput {
  /** The original (already-normalized) user query. Must be a non-empty
   *  string; whitespace-only is rejected by `.trim()` length check. */
  readonly query: string;
  /** Zero or more LLM-rewritten variants. The caller has already
   *  validated each rewrite (max 240 chars, non-empty). */
  readonly rewrites: readonly string[];
  /** Optional HyDE hypothetical document. `null` / `undefined` means
   *  HyDE was skipped (gated intent) or failed (LLM error). */
  readonly hydeDocument?: string | null | undefined;
}

export interface MultiQueryFanoutResult {
  /** Deduplicated, capped semantic query strings. The first element is
   *  always the original `query` (when non-empty). */
  readonly semanticQueries: readonly string[];
  /** How many candidates we attempted to fan out (pre-dedupe / pre-cap).
   *  Useful for telemetry without revealing prompt content. */
  readonly inputCount: number;
  /** Whether the cap actually kicked in. */
  readonly capped: boolean;
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Build a deduplicated, capped semantic-query list.
 *
 * Dedup key
 * ---------
 * Lowercase + trim. Preserves the casing of whichever variant arrives
 * first (original > rewrites > HyDE). This is intentional — the original
 * query usually carries the most natural casing.
 *
 * Cap
 * ---
 * Total semantic queries are bounded at {@link MULTI_QUERY_FANOUT_MAX_QUERIES}.
 * Excess inputs are dropped silently (telemetry surfaces via `capped`).
 */
export function expandSemanticQueriesForFanout(
  input: MultiQueryFanoutInput,
): MultiQueryFanoutResult {
  const inputs: string[] = [];
  const originalTrimmed = input.query.trim();
  if (originalTrimmed.length > 0) {
    inputs.push(originalTrimmed);
  }
  for (const rewrite of input.rewrites) {
    const trimmed = rewrite.trim();
    if (trimmed.length === 0) continue;
    inputs.push(trimmed);
  }
  const hyde = input.hydeDocument;
  if (typeof hyde === 'string') {
    const trimmedHyde = hyde.trim();
    if (trimmedHyde.length > 0) {
      inputs.push(trimmedHyde);
    }
  }

  // Compute the unique-key set up-front so `capped` reflects how many
  // distinct queries we DROPPED for the cap, not how many we admitted.
  // Otherwise the cap check + early-break collapse `seen.size` to the
  // cap value and `capped` would be silently false even when entries
  // were dropped.
  const uniqueKeys = new Set<string>();
  for (const candidate of inputs) {
    uniqueKeys.add(candidate.toLowerCase());
  }
  const capped = uniqueKeys.size > MULTI_QUERY_FANOUT_MAX_QUERIES;

  const admitted = new Set<string>();
  const out: string[] = [];
  for (const candidate of inputs) {
    const key = candidate.toLowerCase();
    if (admitted.has(key)) continue;
    admitted.add(key);
    out.push(candidate);
    if (out.length >= MULTI_QUERY_FANOUT_MAX_QUERIES) break;
  }

  return {
    semanticQueries: out,
    inputCount: inputs.length,
    capped,
  };
}

/**
 * Convenience: merge fanout output into an existing semantic-queries
 * array, preserving any extra terms already supplied by the planner
 * (e.g. structured expansions from constraint atoms) — those go FIRST
 * after the rewrites/HyDE so existing dedup logic keeps them stable.
 *
 * Returns a fresh readonly array. Never mutates inputs.
 */
export function mergeFanoutWithExisting(
  fanout: readonly string[],
  existing: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...fanout, ...existing]) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
