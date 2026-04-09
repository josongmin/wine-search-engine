/**
 * LTR feature logging utility — bridges online serving and offline LTR training.
 *
 * Calling sites (search ranker, benchmark runner) invoke `extractFeatureBatch`
 * to materialize a per-candidate feature vector for the current query.
 * The resulting batch can be serialized to NDJSON for offline LightGBM training.
 *
 * This module is intentionally pure: no I/O, no global state. Persistence is
 * the caller's responsibility (debug pipeline, file dump script, etc.).
 */

import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { NormalizedConstraint } from '../../shared/types/index.js';
import { extractLTRFeatures, type LTRFeatureVector } from './ltr-features.js';

export interface FeatureLogEntry {
  readonly queryId: string;
  readonly entityId: string;
  readonly features: LTRFeatureVector;
  readonly timestamp: number;
}

export interface FeatureLogBatch {
  readonly queryId: string;
  readonly entries: readonly FeatureLogEntry[];
}

export interface ExtractFeatureBatchInput {
  readonly queryId: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly candidates: readonly HybridCandidate[];
  readonly hardConstraints: readonly NormalizedConstraint[];
  readonly softConstraints: readonly NormalizedConstraint[];
  readonly inferredConstraints?: readonly NormalizedConstraint[];
  readonly degradationFlags: {
    readonly dense: boolean;
    readonly sparse: boolean;
    readonly anchor: boolean;
  };
  readonly entityLinkConfidence?: number;
}

/**
 * Extract LTR feature vectors for every candidate in a single query.
 * Returns a batch keyed by queryId so downstream consumers can group/serialize.
 */
export function extractFeatureBatch(input: ExtractFeatureBatchInput): FeatureLogBatch {
  const timestamp = Date.now();
  const entries: FeatureLogEntry[] = [];
  for (const candidate of input.candidates) {
    const features = extractLTRFeatures({
      query: input.query,
      normalizedQuery: input.normalizedQuery,
      candidate,
      hardConstraints: input.hardConstraints,
      softConstraints: input.softConstraints,
      ...(input.inferredConstraints !== undefined ? { inferredConstraints: input.inferredConstraints } : {}),
      degradationFlags: input.degradationFlags,
      ...(input.entityLinkConfidence !== undefined ? { entityLinkConfidence: input.entityLinkConfidence } : {}),
    });
    entries.push({
      queryId: input.queryId,
      entityId: String(candidate.entityId),
      features,
      timestamp,
    });
  }
  return { queryId: input.queryId, entries };
}

/**
 * Serialize a feature log batch to newline-delimited JSON for file dumps.
 * Each line is one FeatureLogEntry with a stable key order.
 */
export function serializeBatchToNdjson(batch: FeatureLogBatch): string {
  const lines: string[] = [];
  for (const entry of batch.entries) {
    lines.push(JSON.stringify(entry));
  }
  return lines.join('\n');
}
