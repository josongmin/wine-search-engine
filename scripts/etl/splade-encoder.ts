/**
 * RFC-022 P1 — Learned-Sparse (SPLADE) encoder PORT.
 *
 * This file defines the seam only. The production implementation
 * (naver/splade-v3 served in-process via onnxruntime-node, mirroring
 * src/infrastructure/ml/drinking-window-predictor.ts) lands in RFC-022 P2.
 *
 * TRAIN/SERVE INVARIANT (RFC-022 §2, §4 — non-negotiable):
 *   A SPLADE inner product `sum_t q_t · d_t` is only meaningful when the query
 *   vector and the document vector were produced by the SAME model and vocab.
 *   Therefore every {@link LearnedSparseVector} carries `modelId` +
 *   `schemaVersion`, and any consumer that fuses a query vector with a doc
 *   vector MUST compare these and fall back to a 0 contribution (never a
 *   mismatched dot product) when they differ. The doc-side (this ETL) and the
 *   query-side (P3) MUST be wired to the same encoder identity.
 *
 * P1 scope: interface + the doc-side wiring seam in index-to-vespa.ts. No
 * encoder is injected by the production batch driver yet, so the doc-side
 * remains byte-identical to today until P2 provides a real encoder. A
 * deterministic stub lives in the test suite (not in production code) so the
 * wiring can be exercised end-to-end without the model artifact.
 */

import type { LearnedSparseVector } from './learned-sparse-spec.js';

/**
 * A SPLADE-style learned-sparse text encoder.
 *
 * `encode` is intentionally synchronous: the ETL feeds documents in batches and
 * the onnxruntime-node session exposes a sync-friendly run loop; if a future
 * backend needs async I/O this port can be widened to `Promise` at that time.
 */
export interface SpladeEncoder {
  /**
   * Model identity, copied into every produced vector for train/serve skew
   * detection. Doc-side and query-side MUST agree on this exact string.
   */
  readonly modelId: string;

  /** Artifact schema version (see LEARNED_SPARSE_SCHEMA_VERSION). */
  readonly schemaVersion: number;

  /**
   * Encode source text into a sparse token→weight vector. Returns `undefined`
   * for input the encoder cannot meaningfully represent (e.g. empty text) so
   * the ETL omits the field rather than indexing an empty tensor.
   */
  encode(text: string): LearnedSparseVector | undefined;
}
