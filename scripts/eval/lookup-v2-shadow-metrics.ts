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
 *
 * PER-CLASS no-regression gate (Fix #3 — the 15-hotset overstated V2 and hid
 * V1's precision bug + the noisy_recall ceiling; the full eval_cases
 * distribution is the authority). The overall gates above can PASS while a
 * single query class silently regresses (e.g. an overall +pp lift masking a
 * noisy_recall drop). {@link evaluatePerClassGate} closes that hole: it works
 * on per-class V1/V2 tallies and is shared by the full-distribution scorer
 * (`run-entity-resolution-validation.ts`). It is pure so it is unit-testable
 * with hard-coded tallies and no live DB.
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
  /**
   * Optional ground-truth query class (`exact_entity`, `ambiguous_short_form`,
   * `noisy_recall`, `no_match`, …). When present, the report builder derives a
   * per-class tally and applies the per-class no-regression gate. The 15-query
   * hotset rows may omit it; the full eval_cases distribution always carries it.
   */
  readonly queryClass?: string | undefined;
  readonly expectedStatus: ShadowStatus;
  /**
   * Optional exact set of statuses that count as correct for this row. Use this
   * for precision-first "must not resolve" rows where multiple abstentions are
   * acceptable (`opu one` may fail OR clarify, but must never resolve).
   * When omitted, only `expectedStatus` is accepted.
   */
  readonly acceptedStatuses?: readonly ShadowStatus[] | undefined;
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
  /**
   * Per-class V1/V2 tallies derived from rows carrying a `queryClass`. Empty
   * when no row is labeled with a class (e.g. a hotset run keyed only by status).
   */
  readonly perClass: readonly PerClassEntry[];
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

function acceptedStatuses(row: ShadowRow): readonly ShadowStatus[] {
  return row.acceptedStatuses ?? [row.expectedStatus];
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
  if (!acceptedStatuses(row).includes(side.status)) {
    return false;
  }
  if (side.status === 'resolved') {
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
  if (!acceptedStatuses(row).includes('resolved')) {
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

/** Classify a side's outcome on one row into a correct/wrong/miss verdict. */
function classVerdict(row: ShadowRow, side: ShadowSideOutcome): 'correct' | 'wrong' | 'miss' {
  if (isWrongPositive(row, side)) return 'wrong';
  if (isResolveCorrect(row, side)) return 'correct';
  return 'miss';
}

/**
 * Group rows by `queryClass` into per-class V1/V2 tallies. Rows without a
 * `queryClass` are skipped (the per-class gate then has nothing to check on a
 * status-only hotset run). `shouldResolve` is derived from the row's expected
 * status: only `resolved` rows assert a target entity.
 */
function buildPerClassEntries(rows: readonly ShadowRow[]): PerClassEntry[] {
  interface MutableTally { correct: number; wrong: number; miss: number; total: number }
  const acc = new Map<string, { shouldResolve: boolean; v1: MutableTally; v2: MutableTally }>();
  const mk = (): MutableTally => ({ correct: 0, wrong: 0, miss: 0, total: 0 });
  for (const row of rows) {
    if (row.queryClass === undefined) continue;
    const entry = acc.get(row.queryClass)
      ?? { shouldResolve: row.expectedStatus === 'resolved', v1: mk(), v2: mk() };
    acc.set(row.queryClass, entry);
    entry.v1[classVerdict(row, row.v1)] += 1; entry.v1.total += 1;
    entry.v2[classVerdict(row, row.v2)] += 1; entry.v2.total += 1;
  }
  return [...acc.entries()]
    .map(([queryClass, e]) => ({ queryClass, shouldResolve: e.shouldResolve, v1: e.v1, v2: e.v2 }))
    .sort((a, b) => (a.queryClass < b.queryClass ? -1 : a.queryClass > b.queryClass ? 1 : 0));
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
  // Gate 4 (non-degeneracy): the corpus HAS expected-resolve rows, so a meaningful
  // cutover run must demonstrate RESOLUTION. Two failure modes:
  //   (a) neither engine resolved any → degraded substrate, comparison hollow;
  //   (b) V2 (the cutover TARGET) resolved NONE, even if V1 did → we cannot certify
  //       V2's resolution capability regardless of V1 (asymmetric escape closed —
  //       a precision-first abstain-everything V2 would otherwise pass vacuously
  //       off redirect/failed rows). Both reject the run.
  const expectedResolveRows = rows.filter((r) => r.expectedStatus === 'resolved');
  if (thresholds.requireNonDegenerate && expectedResolveRows.length > 0) {
    const v1ResolvedCorrect = expectedResolveRows.filter((r) => isResolveCorrect(r, r.v1)).length;
    const v2ResolvedCorrect = expectedResolveRows.filter((r) => isResolveCorrect(r, r.v2)).length;
    if (v1ResolvedCorrect === 0 && v2ResolvedCorrect === 0) {
      reasons.push(
        `degenerate run: neither engine resolved any of ${expectedResolveRows.length} expected-resolve rows `
          + `(degraded substrate — comparison is uninformative)`,
      );
    } else if (v2ResolvedCorrect === 0) {
      reasons.push(
        `degenerate run: V2 resolved 0 of ${expectedResolveRows.length} expected-resolve rows `
          + `(cannot certify the cutover target's resolution capability)`,
      );
    }
  }

  // Gate 5 (per-class no-regression): the overall correct-rate gate can PASS
  // while a single class silently regresses (Fix #3). When rows carry a
  // queryClass, fold the shared per-class gate's reasons into the verdict.
  const perClass = buildPerClassEntries(rows);
  if (perClass.length > 0) {
    const perClassResult = evaluatePerClassGate(perClass);
    reasons.push(...perClassResult.reasons);
  }

  return {
    rowCount: rows.length,
    v1,
    v2,
    v2ConceptRedirectAccuracy,
    improvements,
    regressions,
    perClass,
    gate: { pass: reasons.length === 0, reasons },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// PER-CLASS no-regression gate (Fix #3) — full-distribution authority.
// ---------------------------------------------------------------------------

/**
 * Per-class scoring tally for one engine. Mirrors the `Tally` shape produced
 * by the full-distribution scorer (`run-entity-resolution-validation.ts`):
 *   correct + wrong + miss === total.
 * `wrong` for a should-NOT-resolve class is a wrong-positive (resolved when it
 * should have abstained); for a should-resolve class it is a resolve to the
 * wrong entity.
 */
export interface ClassTally {
  readonly correct: number;
  readonly wrong: number;
  readonly miss: number;
  readonly total: number;
}

/** One query class with both engines' tallies + its resolve semantics. */
export interface PerClassEntry {
  readonly queryClass: string;
  /** false ⇒ the gold says this class must NOT resolve (abstain classes). */
  readonly shouldResolve: boolean;
  readonly v1: ClassTally;
  readonly v2: ClassTally;
}

export interface PerClassGateThresholds {
  /**
   * Min allowed V2 correct-rate relative to V1, PER CLASS. 0.98 mirrors the
   * overall `correctRateRatioMin`: a class may lose at most 2% of V1's
   * correct-rate before it counts as a regression. The full-distribution run
   * showed V2 matching or beating V1 on every class (exact_entity 72→100%,
   * ambiguous 80→100%, noisy_recall tie, no_match tie), so 0.98 is generous
   * headroom that still rejects a real per-class drop the overall lift hides.
   */
  readonly perClassCorrectRateRatioMin: number;
}

/** Default per-class gate — same 2% tolerance as the overall correct-rate gate. */
export const DEFAULT_PER_CLASS_GATE: PerClassGateThresholds = {
  perClassCorrectRateRatioMin: 0.98,
};

export interface PerClassGateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

function classCorrectRate(t: ClassTally): number {
  return ratio(t.correct, t.total);
}

/**
 * Pure per-class no-regression gate. FAILS when:
 *   (a) ANY class's V2 correct-rate < V1 correct-rate × `perClassCorrectRateRatioMin`
 *       (catches a single-class regression the overall lift would hide), OR
 *   (b) ANY should-NOT-resolve class has >0 V2 wrong-positives (abstain classes
 *       must resolve EXACTLY zero — a single wrong-positive on `ambiguous_short_form`
 *       or `no_match` is a hard precision failure, independent of overall rates).
 *
 * Pure + deterministic: iterates entries in a stable, class-name-sorted order so
 * the reasons array is reproducible regardless of input order.
 */
export function evaluatePerClassGate(
  entries: readonly PerClassEntry[],
  thresholds: PerClassGateThresholds = DEFAULT_PER_CLASS_GATE,
): PerClassGateResult {
  const reasons: string[] = [];
  const ordered = [...entries].sort((a, b) => (a.queryClass < b.queryClass ? -1 : a.queryClass > b.queryClass ? 1 : 0));
  for (const e of ordered) {
    // (b) abstain classes: EXACTLY zero V2 wrong-positives — checked first and
    // independently of correct-rate so a single injected wrong-positive fails
    // the gate even when the rate is otherwise fine.
    if (!e.shouldResolve && e.v2.wrong > 0) {
      reasons.push(
        `class ${e.queryClass} (should-NOT-resolve) has ${String(e.v2.wrong)} V2 wrong-positive(s); must be exactly 0`,
      );
    }
    // (a) per-class correct-rate no-regression vs V1.
    const v1Rate = classCorrectRate(e.v1);
    const v2Rate = classCorrectRate(e.v2);
    if (v2Rate < v1Rate * thresholds.perClassCorrectRateRatioMin) {
      reasons.push(
        `class ${e.queryClass} V2 correct-rate ${pct(v2Rate)} below V1 ${pct(v1Rate)} × `
          + `${thresholds.perClassCorrectRateRatioMin.toFixed(2)} tolerance`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}
