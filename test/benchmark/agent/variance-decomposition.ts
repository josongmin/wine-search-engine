/**
 * SOTA++ variance decomposition for agent benchmark observations.
 *
 * Given a tidy table of score observations indexed by (scenarioId, runIndex,
 * judgeSampleIndex, dimension), decompose the total variance of `score` into
 * variance attributable to:
 *
 *   - scenario   (between-scenario intrinsic difficulty)
 *   - run        (between-run variance WITHIN a scenario — agent stochasticity)
 *   - judge      (between-judge-sample variance WITHIN a run — judge noise)
 *   - residual   (everything else — finite-sample noise, interactions)
 *
 * This uses the standard balanced/unbalanced sum-of-squares ANOVA-style
 * decomposition with nested means:
 *
 *   total SS = Σ (x_{s,r,j} − x_global)²
 *   scenario SS = Σ_{s,r,j}     (x_s     − x_global)²
 *   run SS      = Σ_{s,r,j}     (x_{s,r} − x_s)²
 *   judge SS    = Σ_{s,r,j}     (x_{s,r,j} − x_{s,r})²   ← when judge is the
 *                                                          innermost level,
 *                                                          this equals residual
 *
 * "judge" and "residual" coincide when the innermost level is judge samples
 * and we have no further nesting; we emit both so the report shape can grow
 * without breaking consumers.
 *
 * Fractions sum to 1.0 (within floating-point tolerance) and use TOTAL SS in
 * the denominator, not Mean Squares — this is the "raw share of variance"
 * presentation called out in the task, not the F-stat MS form.
 *
 * Insight rule (mechanical):
 *   the source with the largest share is the next reliability lever — bumping
 *   its sample count is where the next 1pp of CI tightening lives.
 *
 * No external stats library, no heuristic shortcuts.
 */

const FRACTION_EPS = 1e-12;

export interface VarianceObservation {
  readonly scenarioId: number | string;
  readonly runIndex: number;
  readonly judgeSampleIndex: number;
  /** Restrict decomposition to a single dimension; undefined = pooled. */
  readonly dimension?: string;
  readonly score: number;
}

export interface VarianceDecomposition {
  /** Total sum of squares (Σ (x − x_global)²). */
  readonly totalSS: number;
  /** Between-scenario SS. */
  readonly scenarioSS: number;
  /** Between-run within-scenario SS. */
  readonly runSS: number;
  /** Between-judge within-run SS (innermost level). */
  readonly judgeSS: number;
  /** Residual SS — when judge IS innermost, equals judgeSS. */
  readonly residualSS: number;
  /** scenarioSS / totalSS. */
  readonly scenarioFraction: number;
  /** runSS / totalSS. */
  readonly runFraction: number;
  /** judgeSS / totalSS. */
  readonly judgeFraction: number;
  /** residualSS / totalSS. */
  readonly residualFraction: number;
  /** Total observation count. */
  readonly observationCount: number;
  /** Distinct scenario count. */
  readonly scenarioCount: number;
  /** Mean observations per scenario. */
  readonly meanRunsPerScenario: number;
  /** Mean judge samples per scenario-run. */
  readonly meanJudgeSamplesPerRun: number;
  /** Global grand mean of scores. */
  readonly grandMean: number;
  /** Insight: which source is the largest reliability lever right now. */
  readonly dominantSource: 'scenario' | 'run' | 'judge' | 'residual' | 'none';
}

type GroupKey = string;

function scenarioKey(id: number | string): GroupKey {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

function runKey(scenarioId: number | string, runIndex: number): GroupKey {
  return `${scenarioKey(scenarioId)}|r:${runIndex}`;
}

interface RunningAccumulator {
  sum: number;
  count: number;
}

function pushRunning(map: Map<GroupKey, RunningAccumulator>, key: GroupKey, value: number): void {
  const cur = map.get(key);
  if (cur === undefined) {
    map.set(key, { sum: value, count: 1 });
  } else {
    cur.sum += value;
    cur.count += 1;
  }
}

function meanOf(acc: RunningAccumulator | undefined): number {
  if (acc === undefined || acc.count === 0) return 0;
  return acc.sum / acc.count;
}

/**
 * Compute the ANOVA-style decomposition.
 *
 * Returns zero-valued fractions when there are fewer than 2 observations
 * (variance is undefined). Filters out non-finite scores rather than
 * propagating NaN — matches the rest of the benchmark's null-drop policy.
 */
export function decomposeVariance(
  observations: readonly VarianceObservation[],
): VarianceDecomposition {
  // Filter to finite scores only and (optionally) a single dimension.
  // The dimension filter happens at the caller's level; here we treat
  // dimension as opaque — any caller-tagging is preserved by partitioning
  // before calling decomposeVariance() for per-dimension analyses.
  const finite = observations.filter((o) => Number.isFinite(o.score));

  if (finite.length === 0) {
    return emptyDecomposition();
  }

  let sum = 0;
  for (const o of finite) sum += o.score;
  const grandMean = sum / finite.length;

  let totalSS = 0;
  for (const o of finite) {
    const d = o.score - grandMean;
    totalSS += d * d;
  }

  const scenarioAcc = new Map<GroupKey, RunningAccumulator>();
  const runAcc = new Map<GroupKey, RunningAccumulator>();
  for (const o of finite) {
    pushRunning(scenarioAcc, scenarioKey(o.scenarioId), o.score);
    pushRunning(runAcc, runKey(o.scenarioId, o.runIndex), o.score);
  }

  // Scenario SS = Σ n_s · (mean_s − grand_mean)² (algebraically identical to
  // ΣΣΣ (mean_s − grand_mean)² because every obs in scenario s contributes
  // the same per-cell term).
  let scenarioSS = 0;
  for (const acc of scenarioAcc.values()) {
    const meanS = acc.count > 0 ? acc.sum / acc.count : 0;
    const d = meanS - grandMean;
    scenarioSS += acc.count * d * d;
  }

  // Run SS = Σ n_{s,r} · (mean_{s,r} − mean_s)²
  let runSS = 0;
  for (const [key, acc] of runAcc) {
    // Key format: `n:<id>|r:<runIndex>` or `s:<id>|r:<runIndex>` — split on
    // `|r:` to recover the scenario key portion.
    const pipeIdx = key.indexOf('|r:');
    const sKey = pipeIdx >= 0 ? key.slice(0, pipeIdx) : key;
    const sAcc = scenarioAcc.get(sKey);
    const meanS = meanOf(sAcc);
    const meanSR = acc.count > 0 ? acc.sum / acc.count : 0;
    const d = meanSR - meanS;
    runSS += acc.count * d * d;
  }

  // Judge SS = Σ (x_{s,r,j} − mean_{s,r})² — i.e. variance within each
  // (scenario, run) cell across judge samples. This is the residual at the
  // innermost level.
  let judgeSS = 0;
  for (const o of finite) {
    const meanSR = meanOf(runAcc.get(runKey(o.scenarioId, o.runIndex)));
    const d = o.score - meanSR;
    judgeSS += d * d;
  }

  // Residual = totalSS - scenarioSS - runSS - judgeSS in a fully nested
  // balanced design, residual collapses to 0 (judge IS the innermost
  // level). We expose it explicitly so the report stays robust if a future
  // level is added (e.g. judge-prompt variants). Floating-point clamp.
  const residualSS = Math.max(0, totalSS - scenarioSS - runSS - judgeSS);

  const denom = totalSS > FRACTION_EPS ? totalSS : 1;
  const scenarioFraction = totalSS > FRACTION_EPS ? scenarioSS / denom : 0;
  const runFraction = totalSS > FRACTION_EPS ? runSS / denom : 0;
  const judgeFraction = totalSS > FRACTION_EPS ? judgeSS / denom : 0;
  const residualFraction = totalSS > FRACTION_EPS ? residualSS / denom : 0;

  const scenarioCount = scenarioAcc.size;
  const observationCount = finite.length;
  const meanRunsPerScenario = scenarioCount > 0
    ? runAcc.size / scenarioCount
    : 0;
  const meanJudgeSamplesPerRun = runAcc.size > 0
    ? observationCount / runAcc.size
    : 0;

  const dominantSource = pickDominantSource({
    scenarioFraction,
    runFraction,
    judgeFraction,
    residualFraction,
  });

  return {
    totalSS,
    scenarioSS,
    runSS,
    judgeSS,
    residualSS,
    scenarioFraction,
    runFraction,
    judgeFraction,
    residualFraction,
    observationCount,
    scenarioCount,
    meanRunsPerScenario,
    meanJudgeSamplesPerRun,
    grandMean,
    dominantSource,
  };
}

function emptyDecomposition(): VarianceDecomposition {
  return {
    totalSS: 0,
    scenarioSS: 0,
    runSS: 0,
    judgeSS: 0,
    residualSS: 0,
    scenarioFraction: 0,
    runFraction: 0,
    judgeFraction: 0,
    residualFraction: 0,
    observationCount: 0,
    scenarioCount: 0,
    meanRunsPerScenario: 0,
    meanJudgeSamplesPerRun: 0,
    grandMean: 0,
    dominantSource: 'none',
  };
}

function pickDominantSource(fracs: {
  readonly scenarioFraction: number;
  readonly runFraction: number;
  readonly judgeFraction: number;
  readonly residualFraction: number;
}): VarianceDecomposition['dominantSource'] {
  const entries: ReadonlyArray<readonly [VarianceDecomposition['dominantSource'], number]> = [
    ['scenario', fracs.scenarioFraction],
    ['run', fracs.runFraction],
    ['judge', fracs.judgeFraction],
    ['residual', fracs.residualFraction],
  ];
  let best: VarianceDecomposition['dominantSource'] = 'none';
  let bestVal = 0;
  for (const [name, val] of entries) {
    if (val > bestVal) {
      best = name;
      bestVal = val;
    }
  }
  return best;
}

/**
 * Insight line — printed by the runner when variance decomposition is
 * available. Mechanical, not LLM-written.
 */
export function formatVarianceInsight(d: VarianceDecomposition): string {
  if (d.dominantSource === 'none' || d.observationCount === 0) {
    return 'Variance decomposition: no observations (n=0).';
  }
  const labels: Record<Exclude<VarianceDecomposition['dominantSource'], 'none'>, string> = {
    scenario: 'between-scenario difficulty',
    run: 'between-run agent stochasticity',
    judge: 'within-run judge noise',
    residual: 'unexplained / interaction residual',
  };
  const fractionByName: Record<Exclude<VarianceDecomposition['dominantSource'], 'none'>, number> = {
    scenario: d.scenarioFraction,
    run: d.runFraction,
    judge: d.judgeFraction,
    residual: d.residualFraction,
  };
  const pct = (fractionByName[d.dominantSource] * 100).toFixed(1);
  const leverHint: Record<Exclude<VarianceDecomposition['dominantSource'], 'none'>, string> = {
    scenario: 'add scenarios (broaden coverage)',
    run: 'increase --runs N (more agent samples per scenario)',
    judge: 'increase --judge-samples (more judge votes)',
    residual: 'inspect interactions / add nested levels',
  };
  return (
    `Variance decomposition: dominant source is ${labels[d.dominantSource]} `
    + `(${pct}% share). Next reliability lever: ${leverHint[d.dominantSource]}.`
  );
}
