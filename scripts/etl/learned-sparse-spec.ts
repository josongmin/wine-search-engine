/**
 * T4.1a: Learned Sparse Artifact / Spec Contract
 *
 * Defines the serialization format for learned sparse weights
 * (SPLADE-style: token → weight map) used by the wine search engine.
 *
 * This file is the SSOT for:
 * - artifact format (what gets stored/loaded)
 * - serialization key names (what ETL writes)
 * - offline eval validation rules (what eval scripts check)
 *
 * Runtime integration (T4.2+): vespa-schema.sd + vespa-search-index.ts
 * will consume the ARTIFACT_FIELD_KEY to read sparse weights from the index.
 *
 * Must NOT change:
 * - runtime candidate generation (T4.3 owns this)
 * - search-index.port.ts
 * - candidate-pool.ts
 */

// ---------------------------------------------------------------------------
// Artifact format
// ---------------------------------------------------------------------------

/**
 * Single learned sparse vector entry.
 * Represents a SPLADE-style sparse weight for one token or subword.
 */
export interface LearnedSparseEntry {
  /** Token ID or surface-form string (model-dependent). */
  readonly token: string;
  /** Non-negative sparse weight. Zero-weight entries MUST be omitted. */
  readonly weight: number;
}

/**
 * Learned sparse vector for one wine entity / query.
 * Sparse representation: only non-zero weights are stored.
 */
export interface LearnedSparseVector {
  /** Non-zero token weights, sorted by weight descending. */
  readonly entries: readonly LearnedSparseEntry[];
  /** Sum of all weights (pre-computed for normalization). */
  readonly weightSum: number;
  /** Model ID that produced this vector (for train/serve skew detection). */
  readonly modelId: string;
  /** Schema version — bump when entry format changes. */
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Serialization keys (SSOT for ETL + eval + Vespa feed)
// ---------------------------------------------------------------------------

/**
 * Vespa field name for the learned sparse tensor.
 * Used in: vespa-schema.sd, mapping.ts, index-to-vespa.ts
 */
export const LEARNED_SPARSE_FIELD_KEY = 'learned_sparse_weights' as const;

/**
 * ETL NDJSON key for the learned sparse vector in Silver records.
 */
export const LEARNED_SPARSE_ETL_KEY = 'learnedSparseWeights' as const;

/**
 * Eval artifact presence key — used by offline eval scripts to verify
 * learned sparse vectors are present in the eval fixtures.
 */
export const LEARNED_SPARSE_EVAL_KEY = 'learned_sparse_present' as const;

/**
 * Minimum number of non-zero entries required for a valid sparse vector.
 * Vectors below this threshold are considered degenerate and should be
 * flagged in ingest contract tests.
 */
export const LEARNED_SPARSE_MIN_ENTRIES = 10;

/**
 * Maximum number of non-zero entries to store per entity.
 * Entries beyond this are trimmed by weight descending.
 */
export const LEARNED_SPARSE_MAX_ENTRIES = 128;

/**
 * Current schema version. Bump this when LearnedSparseVector format changes.
 */
export const LEARNED_SPARSE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Validation helpers (for ingest contract tests)
// ---------------------------------------------------------------------------

export interface LearnedSparseValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate a LearnedSparseVector against the artifact spec.
 * Used by ingest contract tests and ETL smoke validation.
 */
export function validateLearnedSparseVector(
  vec: LearnedSparseVector,
): LearnedSparseValidationResult {
  const errors: string[] = [];

  if (vec.entries.length < LEARNED_SPARSE_MIN_ENTRIES) {
    errors.push(
      `Too few entries: ${vec.entries.length} < ${LEARNED_SPARSE_MIN_ENTRIES}`,
    );
  }

  if (vec.entries.length > LEARNED_SPARSE_MAX_ENTRIES) {
    errors.push(
      `Too many entries: ${vec.entries.length} > ${LEARNED_SPARSE_MAX_ENTRIES}`,
    );
  }

  if (vec.schemaVersion !== LEARNED_SPARSE_SCHEMA_VERSION) {
    errors.push(
      `Schema version mismatch: got ${vec.schemaVersion}, expected ${LEARNED_SPARSE_SCHEMA_VERSION}`,
    );
  }

  for (const entry of vec.entries) {
    if (entry.weight <= 0) {
      errors.push(`Zero/negative weight for token '${entry.token}'`);
      break; // report only the first
    }
  }

  const computedSum = vec.entries.reduce((sum, e) => sum + e.weight, 0);
  if (Math.abs(computedSum - vec.weightSum) > 1e-4) {
    errors.push(
      `weightSum mismatch: stored=${vec.weightSum.toFixed(4)}, computed=${computedSum.toFixed(4)}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Trim a learned sparse vector to LEARNED_SPARSE_MAX_ENTRIES,
 * keeping the highest-weight entries.
 */
export function trimLearnedSparseVector(
  vec: LearnedSparseVector,
): LearnedSparseVector {
  if (vec.entries.length <= LEARNED_SPARSE_MAX_ENTRIES) return vec;

  const trimmed = [...vec.entries]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, LEARNED_SPARSE_MAX_ENTRIES);
  const weightSum = trimmed.reduce((sum, e) => sum + e.weight, 0);

  return { ...vec, entries: trimmed, weightSum };
}
