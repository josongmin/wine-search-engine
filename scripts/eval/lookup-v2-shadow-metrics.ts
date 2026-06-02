/**
 * Entity Lookup V2 — shadow-compare metrics (T-ELV2-08).
 *
 * Pure, infra-free scoring for a V1-vs-V2 shadow run. The live runner
 * (`run-lookup-v2-shadow-compare.ts`) loads the container, executes both the
 * legacy `/v1/lookup/wine` path and the `/v2/entity-lookup` path against the
 * hotset corpus, normalizes each into a {@link ShadowOutcome}, and feeds the
 * rows here. Keeping the scoring pure makes the cutover gate deterministic and
 * unit-testable without a database or Vespa.
 *
 * Cutover gate (RFC DoD §7 — V2 must beat V1 before cutover):
 *   1. V2 wrong-positive rate MUST NOT exceed V1's (precision-first; the whole
 *      point of V2 is to stop wrong-resolves like `opu one`).
 *   2. V2 correct-resolve recall MUST be at least V1's, within tolerance.
 *   3. V2 concept-redirect accuracy MUST be ≥ the configured floor (`까쇼`류).
 */

/** The 4-state V2 outcome; V1 is mapped onto the same space by the runner. */
export type ShadowStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

export interface ShadowSideOutcome {
  readonly status: ShadowStatus;
  /** Selected entity id when status === 'resolved', else undefined. */
  readonly topEntityId?: string | undefined;
  /** Selected entity label when resolved — enables hint-based correctness. */
  readonly topLabel?: string | undefined;
}

/** One labeled hotset query with both engines' normalized outcomes. */
export interface ShadowRow {
  readonly qid: string;
  readonly query: string;
  readonly expectedStatus: ShadowStatus;
  /** Preferred correctness key when expectedStatus === 'resolved'. */
  readonly expectedEntityId?: string | undefined;
  /**
   * Fallback correctness key when canonical ids are unavailable (the hotset
   * corpus carries human label hints, not ids): a resolve is correct when the
   * resolved label CONTAINS this normalized hint.
   */
  readonly expectedLabelHint?: string | undefined;
  readonly v1: ShadowSideOutcome;
  readonly v2: ShadowSideOutcome;
}

export interface SideMetrics {
  readonly total: number;
  /** status matches expected (and entity matches when resolved). */
  readonly correct: number;
  /** resolved to the WRONG entity, or resolved when expected was not resolve. */
  readonly wrongPositive: number;
  /** abstained (ambiguous/failed/redirect) — i.e. did not assert a resolve. */
  readonly abstained: number;
  readonly correctRate: number;
  readonly wrongPositiveRate: number;
  readonly abstainRate: number;
}

export interface ShadowReport {
  readonly rowCount: number;
  readonly v1: SideMetrics;
  readonly v2: SideMetrics;
  /** Concept-redirect accuracy on rows whose expectedStatus is redirect_discovery. */
  readonly v2ConceptRedirectAccuracy: number;
  /** Rows where V2 improved over V1 (V1 wrong/miss → V2 correct). */
  readonly improvements: number;
  /** Rows where V2 regressed vs V1 (V1 correct → V2 wrong/miss). */
  readonly regressions: number;
  readonly gate: CutoverGateResult;
}

export interface CutoverGateThresholds {
  /** Max allowed V2 wrong-positive rate relative to V1 (1.0 = no worse than V1). */
  readonly wrongPositiveRatioMax: number;
  /** Min allowed V2 correct-rate relative to V1 (0.98 = within 2% of V1). */
  readonly correctRateRatioMin: number;
  /** Absolute floor for concept-redirect accuracy. */
  readonly conceptRedirectAccuracyMin: number;
  /**
   * When true, a run in which NEITHER engine correctly resolved ANY of the
   * expected-resolve rows (N>0) is rejected as structurally uninformative — a
   * degraded substrate (e.g. empty blocker index) makes both engines abstain
   * 15/15, which the precision-first gates would otherwise PASS as a hollow
   * "V2 ≥ V1". Defends against the degenerate cutover-pass the audit flagged.
   */
  readonly requireNonDegenerate: boolean;
}

/** Conservative default gate — precision-first. */
export const DEFAULT_CUTOVER_GATE: CutoverGateThresholds = {
  wrongPositiveRatioMax: 1.0,
  correctRateRatioMin: 0.98,
  conceptRedirectAccuracyMin: 0.95,
  requireNonDegenerate: true,
};

export interface CutoverGateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

function normalizeForHint(value: string): string {
  // Lower-case, strip Latin accents (Pérignon ⇒ perignon), fold punctuation to
  // spaces, recompose so Hangul stays intact. Mirrors the lookup normalizer so
  // a label hint matches the resolved canonical label.
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Whether a resolved side matches the gold entity (by id, else by label hint). */
function resolvedMatchesGold(row: ShadowRow, side: ShadowSideOutcome): boolean {
  if (row.expectedEntityId !== undefined) {
    return side.topEntityId === row.expectedEntityId;
  }
  if (row.expectedLabelHint !== undefined && side.topLabel !== undefined) {
    return normalizeForHint(side.topLabel).includes(normalizeForHint(row.expectedLabelHint));
  }
  // No correctness key available — cannot confirm a correct resolve.
  return false;
}

function isResolveCorrect(row: ShadowRow, side: ShadowSideOutcome): boolean {
  if (row.expectedStatus !== side.status) {
    return false;
  }
  if (row.expectedStatus === 'resolved') {
    return side.status === 'resolved' && resolvedMatchesGold(row, side);
  }
  return true;
}

function isWrongPositive(row: ShadowRow, side: ShadowSideOutcome): boolean {
  if (side.status !== 'resolved') {
    return false;
  }
  // Resolved when the gold says it should NOT resolve, or resolved to the
  // wrong entity. Both are precision failures.
  if (row.expectedStatus !== 'resolved') {
    return true;
  }
  return !resolvedMatchesGold(row, side);
}

function computeSideMetrics(rows: readonly ShadowRow[], pick: (r: ShadowRow) => ShadowSideOutcome): SideMetrics {
  const total = rows.length;
  let correct = 0;
  let wrongPositive = 0;
  let abstained = 0;
  for (const row of rows) {
    const side = pick(row);
    if (isResolveCorrect(row, side)) correct += 1;
    if (isWrongPositive(row, side)) wrongPositive += 1;
    if (side.status !== 'resolved') abstained += 1;
  }
  return {
    total,
    correct,
    wrongPositive,
    abstained,
    correctRate: ratio(correct, total),
    wrongPositiveRate: ratio(wrongPositive, total),
    abstainRate: ratio(abstained, total),
  };
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

export function buildShadowReport(
  rows: readonly ShadowRow[],
  thresholds: CutoverGateThresholds = DEFAULT_CUTOVER_GATE,
): ShadowReport {
  const v1 = computeSideMetrics(rows, (r) => r.v1);
  const v2 = computeSideMetrics(rows, (r) => r.v2);

  const conceptRows = rows.filter((r) => r.expectedStatus === 'redirect_discovery');
  const conceptCorrect = conceptRows.filter((r) => r.v2.status === 'redirect_discovery').length;
  const v2ConceptRedirectAccuracy = ratio(conceptCorrect, conceptRows.length);

  let improvements = 0;
  let regressions = 0;
  for (const row of rows) {
    const v1ok = isResolveCorrect(row, row.v1);
    const v2ok = isResolveCorrect(row, row.v2);
    if (!v1ok && v2ok) improvements += 1;
    if (v1ok && !v2ok) regressions += 1;
  }

  const reasons: string[] = [];
  // Gate 1: wrong-positive must not get worse. When V1 has zero wrong-positives,
  // require V2 to also be zero (ratio is undefined → use absolute check).
  if (v1.wrongPositiveRate === 0) {
    if (v2.wrongPositiveRate > 0) {
      reasons.push(`V2 introduces wrong-positives (${pct(v2.wrongPositiveRate)}) where V1 had none`);
    }
  } else if (v2.wrongPositiveRate > v1.wrongPositiveRate * thresholds.wrongPositiveRatioMax) {
    reasons.push(`V2 wrong-positive rate ${pct(v2.wrongPositiveRate)} exceeds V1 ${pct(v1.wrongPositiveRate)}`);
  }
  // Gate 2: correct-rate must hold within tolerance.
  if (v2.correctRate < v1.correctRate * thresholds.correctRateRatioMin) {
    reasons.push(`V2 correct rate ${pct(v2.correctRate)} below V1 ${pct(v1.correctRate)} tolerance`);
  }
  // Gate 3: concept-redirect accuracy floor (only when there are concept rows).
  if (conceptRows.length > 0 && v2ConceptRedirectAccuracy < thresholds.conceptRedirectAccuracyMin) {
    reasons.push(`V2 concept-redirect accuracy ${pct(v2ConceptRedirectAccuracy)} below floor ${pct(thresholds.conceptRedirectAccuracyMin)}`);
  }
  // Gate 4 (non-degeneracy): if the corpus HAS expected-resolve rows but NEITHER
  // engine correctly resolved a single one, the substrate is degraded and the
  // "V2 ≥ V1" comparison is hollow — reject rather than pass a 0-resolve run.
  const expectedResolveRows = rows.filter((r) => r.expectedStatus === 'resolved');
  if (thresholds.requireNonDegenerate && expectedResolveRows.length > 0) {
    const v1ResolvedCorrect = expectedResolveRows.filter((r) => isResolveCorrect(r, r.v1)).length;
    const v2ResolvedCorrect = expectedResolveRows.filter((r) => isResolveCorrect(r, r.v2)).length;
    if (v1ResolvedCorrect === 0 && v2ResolvedCorrect === 0) {
      reasons.push(
        `degenerate run: neither engine resolved any of ${expectedResolveRows.length} expected-resolve rows `
          + `(degraded substrate — comparison is uninformative)`,
      );
    }
  }

  return {
    rowCount: rows.length,
    v1,
    v2,
    v2ConceptRedirectAccuracy,
    improvements,
    regressions,
    gate: { pass: reasons.length === 0, reasons },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
