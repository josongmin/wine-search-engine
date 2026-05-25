/**
 * Calibration record — single artifact of one (queryClass, gridPoint)
 * evaluation in the fusion-weight sweep harness.
 *
 * Records are emitted as NDJSON so a sweep run is append-only and
 * resumable. They are the **input** format for any downstream selector
 * that promotes a calibrated config into
 * `src/domain/retrieval/service/per-class-fusion-config.ts`.
 *
 * SCOPE — schema only. This module does not produce records; the sweep
 * runner does. Promotion into the per-class config is a separate PR.
 *
 * Versioning policy: the `version` field is a literal `'v1'`. Any
 * breaking change to the record shape (added required field, renamed
 * metric) MUST bump to `'v2'` and the promotion tool must accept both
 * for a migration window.
 */

import { z } from 'zod';

/**
 * Allowed `queryClass` values — must stay 1:1 with the `QueryClass`
 * union exported from
 * `src/domain/retrieval/service/per-class-fusion-config.ts`. The
 * regression test cross-checks both lists.
 */
export const SWEEP_QUERY_CLASSES = [
  'specific_wine',
  'entity_exact',
  'browse',
  'compare',
  'pairing',
  'fallback',
] as const;
export type SweepQueryClass = (typeof SWEEP_QUERY_CLASSES)[number];

/** Schema version. Bumped only on breaking record-shape changes. */
export const CALIBRATION_RECORD_VERSION = 'v1' as const;

/** Minimum sample size at which downstream selectors trust the metrics. */
export const MIN_EVAL_SAMPLE_SIZE = 1;

const GridPointSchema = z
  .object({
    sparseWeight: z.number().finite().min(0).max(10),
    denseWeight: z.number().finite().min(0).max(10),
    anchorWeight: z.number().finite().min(0).max(10),
    learnedSparseWeight: z.number().finite().min(0).max(10),
  })
  .strict();

/**
 * Metric block — every value is a fraction in [0, 1]. Add new metrics
 * (e.g. nDCG@20, MAP) by extending this schema and bumping the version.
 */
const MetricsSchema = z
  .object({
    ndcgAt5: z.number().finite().min(0).max(1),
    ndcgAt10: z.number().finite().min(0).max(1),
    recallAt20: z.number().finite().min(0).max(1),
    mrr: z.number().finite().min(0).max(1),
  })
  .strict();

export const CalibrationRecordSchema = z
  .object({
    /** Schema version. Pinned to `'v1'` — see version policy above. */
    version: z.literal(CALIBRATION_RECORD_VERSION),

    /** Which per-class config this record informs. */
    queryClass: z.enum(SWEEP_QUERY_CLASSES),

    /** ISO-8601 UTC timestamp the eval was executed. */
    evaluatedAt: z.string().datetime(),

    /** The grid point evaluated. Must match a point yielded by `enumerateGrid`. */
    gridPoint: GridPointSchema,

    /** Retrieval-quality metrics produced by the eval lane. */
    metrics: MetricsSchema,

    /** Corpus identifier — e.g. 'gold-set-v2', 'silver-korean-v1'. */
    evalCorpus: z.string().min(1).max(120),

    /** Number of queries in the eval corpus that produced these metrics. */
    evalSampleSize: z.number().int().positive().max(1_000_000),
  })
  .strict();

export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/**
 * Convenience parser. Returns the validated record or throws a
 * `ZodError` — callers in the sweep runner should catch and log so a
 * single bad record does not abort the whole sweep.
 */
export function parseCalibrationRecord(raw: unknown): CalibrationRecord {
  return CalibrationRecordSchema.parse(raw);
}
