/**
 * Fusion-weight sweep grid — Epic-16 / T16-2 calibration harness.
 *
 * Defines the search space for per-class RRF fusion weight calibration.
 * The grid is **centered on the current production priors** declared in
 * `src/domain/retrieval/service/per-class-fusion-config.ts` and extends
 * ±~50% on each side so a single sweep can both *confirm* the prior
 * (production weight should be in the top-k of the grid) and *discover*
 * a calibrated optimum.
 *
 * SCOPE — framework only. This module does not run the sweep, does not
 * call Vespa, and does not import from `src/`. It exposes:
 *   1. `SWEEP_WEIGHT_GRID` — the axis values.
 *   2. `enumerateGrid` — Cartesian-product generator over the axes.
 *   3. `WeightPoint` / `WeightAxis` types — shared with the calibration
 *      record schema (`./calibration-record.ts`).
 *
 * Wiring into the eval lane is out of scope; see `./index.ts` for the
 * CLI entrypoint and the TODO list.
 *
 * Rule 15 / Rule 16: every numeric is a named constant at module scope
 * with rationale. Rule 30: production prior values are NOT redefined
 * here — they live in `per-class-fusion-config.ts` and the regression
 * test cross-checks the grid against that SSoT.
 */

/**
 * Axis names accepted by the sweep grid. Must stay aligned with the
 * `FusionConfig` interface fields in
 * `src/domain/retrieval/service/per-class-fusion-config.ts`.
 */
export type WeightAxis =
  | 'sparseWeight'
  | 'denseWeight'
  | 'anchorWeight'
  | 'learnedSparseWeight';

/** A single Cartesian-product point selected from the grid. */
export interface WeightPoint {
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight: number;
}

/**
 * Default per-axis grid values. Hand-picked so each production prior
 * (0.5 / 0.8 / 1.0 / 1.5 / 2.0 — see WEIGHT_* constants in
 * per-class-fusion-config.ts) appears verbatim on at least one axis,
 * plus a low-end probe (0.3) to detect when a channel actively hurts.
 *
 * Production priors covered:
 *   WEIGHT_HALF        = 0.5  (sparse/dense/anchor)
 *   WEIGHT_DAMPED      = 0.8  (sparse)
 *   WEIGHT_NEUTRAL     = 1.0  (sparse/dense/anchor)
 *   WEIGHT_BOOST_MILD  = 1.5  (sparse/dense/anchor)
 *   WEIGHT_BOOST_STRONG = 2.0 (sparse/dense/anchor)
 *
 * `learnedSparseWeight` stays pinned at 0 — SPLADE serving has not
 * landed yet (Epic-16 / T16-6+). When SPLADE is wired in, expand this
 * axis (e.g. [0, 0.5, 1.0, 1.5]) and run a follow-up sweep.
 */
export const SWEEP_WEIGHT_GRID = {
  sparseWeight: [0.3, 0.5, 0.8, 1.0, 1.5, 2.0],
  denseWeight: [0.3, 0.5, 1.0, 1.5, 2.0],
  anchorWeight: [0.0, 0.5, 1.0, 1.5, 2.0],
  // Disabled until SPLADE serving lands; see Epic-16 / T16-6+.
  learnedSparseWeight: [0.0],
} as const satisfies Record<WeightAxis, readonly number[]>;

/** Shape of the grid object — useful when callers pass a custom grid. */
export type SweepWeightGrid = {
  readonly [A in WeightAxis]: readonly number[];
};

/**
 * Total number of grid points (Cartesian product cardinality).
 * Computed eagerly so callers can sanity-check sweep cost before
 * launching anything expensive.
 */
export function gridPointCount(grid: SweepWeightGrid): number {
  let n = 1;
  for (const axis of [
    'sparseWeight',
    'denseWeight',
    'anchorWeight',
    'learnedSparseWeight',
  ] as const) {
    n *= grid[axis].length;
  }
  return n;
}

/**
 * Yield every Cartesian-product `WeightPoint` from `grid`, in a
 * deterministic order (sparse → dense → anchor → learnedSparse,
 * with index-0 varying fastest along the innermost axis).
 *
 * Ordering is part of the contract — downstream telemetry indexes
 * sweep iterations and a reorder would invalidate result diffs.
 */
export function* enumerateGrid(
  grid: SweepWeightGrid = SWEEP_WEIGHT_GRID,
): Generator<WeightPoint> {
  for (const sparseWeight of grid.sparseWeight) {
    for (const denseWeight of grid.denseWeight) {
      for (const anchorWeight of grid.anchorWeight) {
        for (const learnedSparseWeight of grid.learnedSparseWeight) {
          yield {
            sparseWeight,
            denseWeight,
            anchorWeight,
            learnedSparseWeight,
          };
        }
      }
    }
  }
}
