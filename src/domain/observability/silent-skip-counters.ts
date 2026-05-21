/**
 * T04-2: Silent-skip observability counters.
 *
 * Pipeline code paths that swallow errors or filter out malformed inputs
 * with `continue` / early return have historically been invisible to ops:
 * the request returns a partial result and no metric ever fires. This
 * module provides a lightweight in-process counter that each such site
 * increments, turning silent skips into observable signals.
 *
 * Usage:
 *   import { globalSilentSkipCounter } from '@observability/silent-skip-counters.js';
 *   globalSilentSkipCounter.increment('embedding_dim_mismatch', { expected, got });
 *
 * The counter is module-scoped mutable state — intentional: a single
 * process-wide tally is the point. Tests should call `reset()` between
 * cases via `createSilentSkipCounter()` for isolation or the global's
 * `reset()` in `beforeEach`.
 */
import { bootstrapLogger } from '../shared/bootstrap-logger.js';

export type SilentSkipKind =
  | 'embedding_dim_mismatch'
  | 'embedding_empty_vector'
  | 'embedding_zero_norm_combined'
  | 'embedding_non_finite_element'
  | 'embedding_array_hole'
  | 'cache_write_failure'
  | 'cache_read_failure'
  | 'unknown_channel_fallback'
  | 'json_parse_failure'
  | 'query_transliteration_variant_absent'
  | 'decision_evidence_items_absent'
  | 'browse_diversity_product_line_fallback_label'
  | 'browse_diversity_product_line_fallback_entity_id'
  | 'browse_diversity_region_producer_missing'
  // LTR inference: component scores missing before they collapse to 0.0.
  | 'ltr_inference_component_score_absent_semantic'
  | 'ltr_inference_component_score_absent_popularity'
  | 'ltr_inference_component_score_absent_attribute_alignment'
  | 'ltr_inference_component_score_absent_preference_alignment'
  | 'ltr_inference_component_score_absent_multilingual_score'
  | 'ltr_inference_component_score_absent_recency'
  // Bugbash 2026-04-14 retrieval audit:
  | 'blocker_disabled_snapshot_pointer_missing'
  | 'blocker_disabled_aliases_table_missing'
  | 'blocker_snapshot_resolve_failure'
  | 'blocker_alias_query_failure'
  | 'blocker_zero_candidates'
  // AdmissionGate §e: ConfidenceRefusalPolicy is bypassed when the
  // resolver's calibrated C was produced by the identity-fallback path
  // (no trained calibration_params for the query class). The counter
  // gives operators a metric to monitor calibration-pipeline health —
  // a high rate here means the hallucination guard is silently off.
  | 'admission_gate_confidence_refusal_skipped_untrusted'
  // Runtime plane composite-PK migration (016): learning/warmup read paths
  // must be scoped to the active snapshot; when the snapshot pointer table
  // is absent (fresh DB, pre-publish) these features degrade cleanly.
  | 'learning_warmup_disabled_snapshot_pointer_missing'
  | 'alias_checker_disabled_snapshot_pointer_missing';

export type LtrInferenceComponentScoreField =
  | 'semantic'
  | 'popularity'
  | 'attributeAlignment'
  | 'preferenceAlignment'
  | 'multilingualScore'
  | 'recency';

export type LtrInferenceComponentScoreAbsentKind =
  | 'ltr_inference_component_score_absent_semantic'
  | 'ltr_inference_component_score_absent_popularity'
  | 'ltr_inference_component_score_absent_attribute_alignment'
  | 'ltr_inference_component_score_absent_preference_alignment'
  | 'ltr_inference_component_score_absent_multilingual_score'
  | 'ltr_inference_component_score_absent_recency';

const LTR_INFERENCE_COMPONENT_SCORE_ABSENT_KIND_BY_FIELD: Readonly<
  Record<LtrInferenceComponentScoreField, LtrInferenceComponentScoreAbsentKind>
> = {
  semantic: 'ltr_inference_component_score_absent_semantic',
  popularity: 'ltr_inference_component_score_absent_popularity',
  attributeAlignment: 'ltr_inference_component_score_absent_attribute_alignment',
  preferenceAlignment: 'ltr_inference_component_score_absent_preference_alignment',
  multilingualScore: 'ltr_inference_component_score_absent_multilingual_score',
  recency: 'ltr_inference_component_score_absent_recency',
};

/** All known kinds — used for snapshot initialization and validation. */
const SILENT_SKIP_KINDS: readonly SilentSkipKind[] = [
  'embedding_dim_mismatch',
  'embedding_empty_vector',
  'embedding_zero_norm_combined',
  'embedding_non_finite_element',
  'embedding_array_hole',
  'cache_write_failure',
  'cache_read_failure',
  'unknown_channel_fallback',
  'json_parse_failure',
  'query_transliteration_variant_absent',
  'decision_evidence_items_absent',
  'browse_diversity_product_line_fallback_label',
  'browse_diversity_product_line_fallback_entity_id',
  'browse_diversity_region_producer_missing',
  'ltr_inference_component_score_absent_semantic',
  'ltr_inference_component_score_absent_popularity',
  'ltr_inference_component_score_absent_attribute_alignment',
  'ltr_inference_component_score_absent_preference_alignment',
  'ltr_inference_component_score_absent_multilingual_score',
  'ltr_inference_component_score_absent_recency',
  'blocker_disabled_snapshot_pointer_missing',
  'blocker_disabled_aliases_table_missing',
  'blocker_snapshot_resolve_failure',
  'blocker_alias_query_failure',
  'blocker_zero_candidates',
  'admission_gate_confidence_refusal_skipped_untrusted',
  'learning_warmup_disabled_snapshot_pointer_missing',
  'alias_checker_disabled_snapshot_pointer_missing',
] as const;

const SILENT_SKIP_KIND_SET: ReadonlySet<string> = new Set(SILENT_SKIP_KINDS);

export interface SilentSkipCounter {
  increment(
    kind: SilentSkipKind,
    context?: Readonly<Record<string, string | number>>,
  ): void;
  snapshot(): Readonly<Record<SilentSkipKind, number>>;
  reset(): void;
}

function createZeroedCounts(): Record<SilentSkipKind, number> {
  const counts = {} as Record<SilentSkipKind, number>;
  for (const kind of SILENT_SKIP_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

export function createSilentSkipCounter(): SilentSkipCounter {
  const counts = new Map<SilentSkipKind, number>(
    SILENT_SKIP_KINDS.map((kind) => [kind, 0] as const),
  );

  return {
    increment(kind, context) {
      // Runtime guard: protects against stringly-typed callers at JS boundaries.
      if (!SILENT_SKIP_KIND_SET.has(kind)) {
        throw new Error(`Unknown SilentSkipKind: ${kind as string}`);
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (context !== undefined) {
        bootstrapLogger.debug(
          { silentSkipKind: kind, ...context },
          '[silent-skip] increment',
        );
      }
    },
    snapshot() {
      const out = createZeroedCounts();
      for (const kind of SILENT_SKIP_KINDS) {
        out[kind] = counts.get(kind) ?? 0;
      }
      return Object.freeze(out);
    },
    reset() {
      for (const kind of SILENT_SKIP_KINDS) {
        counts.set(kind, 0);
      }
    },
  };
}

export function incrementLtrInferenceComponentScoreAbsent(
  field: LtrInferenceComponentScoreField,
  context?: Readonly<Record<string, string | number>>,
): void {
  globalSilentSkipCounter.increment(
    LTR_INFERENCE_COMPONENT_SCORE_ABSENT_KIND_BY_FIELD[field],
    context,
  );
}

/**
 * Process-wide shared instance. Production code should import this directly;
 * tests that need isolation should call `createSilentSkipCounter()` or
 * `globalSilentSkipCounter.reset()` in setup.
 */
export const globalSilentSkipCounter: SilentSkipCounter = createSilentSkipCounter();

// ─────────────────────────────────────────────────────────────────────────────
// Time-bucketed (time-series) silent-skip counters — maturity 4.
//
// Rationale: the request-scoped counter above is great for per-request
// telemetry, but cannot answer "is the schema-failure rate spiking in the
// last 5 minutes?" or "alert when low_confidence skips exceed N/min".
// This adds a per-reason ring of fixed-width time buckets plus a structural
// `checkThreshold` hook callers wire into alerting transports (Slack, PD,
// metrics push, etc.). The implementation is deliberately allocation-free
// on the hot path: a `Uint32Array` per reason, sized to `capacity`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verdict returned by `checkThreshold` — structural only; this module never
 * dispatches alerts itself.
 */
export interface SilentSkipThresholdVerdict {
  readonly kind: SilentSkipKind;
  readonly observed: number;
  readonly threshold: number;
  readonly tripped: boolean;
}

export interface TimeBucketedSilentSkipCountersOptions {
  /** Bucket width in milliseconds. Must be a positive integer. */
  readonly bucketWidthMs: number;
  /** Number of buckets retained in the ring. Window = `bucketWidthMs * capacity`. */
  readonly capacity: number;
  /** Injectable clock. Defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

export interface TimeBucketedSilentSkipCounters {
  /** Increment the current-time bucket for `kind`. Unknown kinds are silently dropped. */
  increment(kind: SilentSkipKind): void;
  /** Sum of events across the live window for `kind`. Unknown kinds return 0. */
  totalWithinWindow(kind: SilentSkipKind): number;
  /** Count in the bucket that contains `now()` for `kind`. Unknown kinds return 0. */
  currentBucketCount(kind: SilentSkipKind): number;
  /**
   * Structural threshold check: `tripped` is true iff the total within the
   * live window is **strictly greater than** `threshold`. Equality is NOT
   * tripped — this matches the convention used by alerting transports that
   * fire on "exceeds" rather than "reaches".
   */
  checkThreshold(kind: SilentSkipKind, threshold: number): SilentSkipThresholdVerdict;
  /** Clear all rings (all reasons). */
  reset(): void;
}

interface ReasonRing {
  readonly counts: Uint32Array;
  /** Bucket index (`floor(now / bucketWidthMs)`) most recently written. */
  lastBucketIndex: number;
  /** Whether the ring has ever been written. */
  initialized: boolean;
}

export function createTimeBucketedSilentSkipCounters(
  opts: TimeBucketedSilentSkipCountersOptions,
): TimeBucketedSilentSkipCounters {
  const { bucketWidthMs, capacity } = opts;
  const now = opts.now ?? ((): number => Date.now());

  if (!Number.isInteger(bucketWidthMs) || bucketWidthMs < 1) {
    throw new Error(
      `bucketWidthMs must be a positive integer, got ${String(bucketWidthMs)}`,
    );
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`capacity must be a positive integer, got ${String(capacity)}`);
  }

  const rings = new Map<SilentSkipKind, ReasonRing>();

  function getOrCreateRing(kind: SilentSkipKind): ReasonRing {
    let ring = rings.get(kind);
    if (ring === undefined) {
      ring = {
        counts: new Uint32Array(capacity),
        lastBucketIndex: 0,
        initialized: false,
      };
      rings.set(kind, ring);
    }
    return ring;
  }

  /**
   * Expire buckets that have fallen outside the live window relative to
   * `currentBucketIndex`. After this call the ring is consistent at
   * `currentBucketIndex`.
   */
  function advanceRing(ring: ReasonRing, currentBucketIndex: number): void {
    if (!ring.initialized) {
      ring.lastBucketIndex = currentBucketIndex;
      ring.initialized = true;
      return;
    }
    const delta = currentBucketIndex - ring.lastBucketIndex;
    if (delta <= 0) return;
    if (delta >= capacity) {
      ring.counts.fill(0);
    } else {
      // Zero each newly entered bucket slot.
      for (let i = 1; i <= delta; i++) {
        const slot = ((ring.lastBucketIndex + i) % capacity + capacity) % capacity;
        ring.counts[slot] = 0;
      }
    }
    ring.lastBucketIndex = currentBucketIndex;
  }

  function bucketIndexNow(): number {
    return Math.floor(now() / bucketWidthMs);
  }

  function slotOf(bucketIndex: number): number {
    // Two-step modulo handles negative bucket indices safely (now() < 0).
    return ((bucketIndex % capacity) + capacity) % capacity;
  }

  function sumWindow(ring: ReasonRing): number {
    let sum = 0;
    for (let i = 0; i < capacity; i++) {
      sum += ring.counts[i]!;
    }
    return sum;
  }

  return {
    increment(kind) {
      if (!SILENT_SKIP_KIND_SET.has(kind)) return; // silently drop unknown
      const ring = getOrCreateRing(kind);
      const current = bucketIndexNow();
      advanceRing(ring, current);
      ring.counts[slotOf(current)] = (ring.counts[slotOf(current)] ?? 0) + 1;
    },

    totalWithinWindow(kind) {
      if (!SILENT_SKIP_KIND_SET.has(kind)) return 0;
      const ring = rings.get(kind);
      if (ring === undefined || !ring.initialized) return 0;
      advanceRing(ring, bucketIndexNow());
      return sumWindow(ring);
    },

    currentBucketCount(kind) {
      if (!SILENT_SKIP_KIND_SET.has(kind)) return 0;
      const ring = rings.get(kind);
      if (ring === undefined || !ring.initialized) return 0;
      const current = bucketIndexNow();
      advanceRing(ring, current);
      return ring.counts[slotOf(current)] ?? 0;
    },

    checkThreshold(kind, threshold) {
      // Reuse totalWithinWindow semantics for the observed value.
      let observed = 0;
      if (SILENT_SKIP_KIND_SET.has(kind)) {
        const ring = rings.get(kind);
        if (ring !== undefined && ring.initialized) {
          advanceRing(ring, bucketIndexNow());
          observed = sumWindow(ring);
        }
      }
      return {
        kind,
        observed,
        threshold,
        tripped: observed > threshold,
      };
    },

    reset() {
      rings.clear();
    },
  };
}
