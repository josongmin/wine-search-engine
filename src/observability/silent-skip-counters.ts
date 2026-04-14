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
import { bootstrapLogger } from '../config/bootstrap-logger.js';

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
  // Bugbash 2026-04-14 retrieval audit:
  | 'blocker_disabled_snapshot_pointer_missing'
  | 'blocker_disabled_aliases_table_missing'
  | 'blocker_snapshot_resolve_failure'
  | 'blocker_alias_query_failure'
  // Runtime plane composite-PK migration (016): learning/warmup read paths
  // must be scoped to the active snapshot; when the snapshot pointer table
  // is absent (fresh DB, pre-publish) these features degrade cleanly.
  | 'learning_warmup_disabled_snapshot_pointer_missing'
  | 'learning_adapter_disabled_snapshot_pointer_missing'
  | 'alias_checker_disabled_snapshot_pointer_missing';

export type LtrInferenceComponentScoreField =
  | 'semantic'
  | 'popularity'
  | 'attributeAlignment'
  | 'preferenceAlignment'
  | 'multilingualScore';

export type LtrInferenceComponentScoreAbsentKind =
  | 'ltr_inference_component_score_absent_semantic'
  | 'ltr_inference_component_score_absent_popularity'
  | 'ltr_inference_component_score_absent_attribute_alignment'
  | 'ltr_inference_component_score_absent_preference_alignment'
  | 'ltr_inference_component_score_absent_multilingual_score';

const LTR_INFERENCE_COMPONENT_SCORE_ABSENT_KIND_BY_FIELD: Readonly<
  Record<LtrInferenceComponentScoreField, LtrInferenceComponentScoreAbsentKind>
> = {
  semantic: 'ltr_inference_component_score_absent_semantic',
  popularity: 'ltr_inference_component_score_absent_popularity',
  attributeAlignment: 'ltr_inference_component_score_absent_attribute_alignment',
  preferenceAlignment: 'ltr_inference_component_score_absent_preference_alignment',
  multilingualScore: 'ltr_inference_component_score_absent_multilingual_score',
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
  'blocker_disabled_snapshot_pointer_missing',
  'blocker_disabled_aliases_table_missing',
  'blocker_snapshot_resolve_failure',
  'blocker_alias_query_failure',
  'learning_warmup_disabled_snapshot_pointer_missing',
  'learning_adapter_disabled_snapshot_pointer_missing',
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
