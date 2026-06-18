/**
 * Entity Lookup V2 — authority parity metrics.
 *
 * The parity runner compares the shared lookup-direct authority against the
 * full application container's `/v2/entity-lookup` wiring over the same corpus.
 * The gate is structural: pass only when both authorities emit identical lookup
 * outcomes. This file also retains the full-distribution per-class gate used by
 * `run-entity-resolution-validation.ts`.
 */

export type LookupEvalStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

export interface LookupEvalSideOutcome {
  readonly status: LookupEvalStatus;
  readonly topEntityId?: string | undefined;
  readonly topLabel?: string | undefined;
}

export interface LookupEvalRow {
  readonly qid: string;
  readonly query: string;
  readonly queryClass?: string | undefined;
  readonly expectedStatus: LookupEvalStatus;
  readonly acceptedStatuses?: readonly LookupEvalStatus[] | undefined;
  readonly expectedEntityId?: string | undefined;
  readonly expectedLabelHint?: string | undefined;
}

export interface ParityRow extends LookupEvalRow {
  readonly direct: LookupEvalSideOutcome;
  readonly fullContainer: LookupEvalSideOutcome;
}

export interface SideMetrics {
  readonly total: number;
  readonly correct: number;
  readonly wrongPositive: number;
  readonly abstained: number;
  readonly correctRate: number;
  readonly wrongPositiveRate: number;
  readonly abstainRate: number;
}

export interface ParityDivergence {
  readonly qid: string;
  readonly query: string;
  readonly mismatch: 'status' | 'resolved_entity' | 'resolved_label';
  readonly direct: LookupEvalSideOutcome;
  readonly fullContainer: LookupEvalSideOutcome;
}

export interface ParityReport {
  readonly rowCount: number;
  readonly direct: SideMetrics;
  readonly fullContainer: SideMetrics;
  readonly divergences: readonly ParityDivergence[];
  readonly gate: {
    readonly pass: boolean;
    readonly reasons: readonly string[];
  };
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function normalizeForHint(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function acceptedStatuses(row: LookupEvalRow): readonly LookupEvalStatus[] {
  return row.acceptedStatuses ?? [row.expectedStatus];
}

function resolvedMatchesGold(row: LookupEvalRow, side: LookupEvalSideOutcome): boolean {
  if (row.expectedEntityId !== undefined) {
    return side.topEntityId === row.expectedEntityId;
  }
  if (row.expectedLabelHint !== undefined && side.topLabel !== undefined) {
    return normalizeForHint(side.topLabel).includes(normalizeForHint(row.expectedLabelHint));
  }
  return false;
}

function isResolveCorrect(row: LookupEvalRow, side: LookupEvalSideOutcome): boolean {
  if (!acceptedStatuses(row).includes(side.status)) {
    return false;
  }
  if (side.status === 'resolved') {
    return resolvedMatchesGold(row, side);
  }
  return true;
}

function isWrongPositive(row: LookupEvalRow, side: LookupEvalSideOutcome): boolean {
  if (side.status !== 'resolved') {
    return false;
  }
  if (!acceptedStatuses(row).includes('resolved')) {
    return true;
  }
  return !resolvedMatchesGold(row, side);
}

function computeSideMetrics(
  rows: readonly LookupEvalRow[],
  pick: (row: LookupEvalRow) => LookupEvalSideOutcome,
): SideMetrics {
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

export function buildParityReport(rows: readonly ParityRow[]): ParityReport {
  const direct = computeSideMetrics(rows, (row) => row.direct);
  const fullContainer = computeSideMetrics(rows, (row) => row.fullContainer);
  const divergences: ParityDivergence[] = [];
  for (const row of rows) {
    if (row.direct.status !== row.fullContainer.status) {
      divergences.push({
        qid: row.qid,
        query: row.query,
        mismatch: 'status',
        direct: row.direct,
        fullContainer: row.fullContainer,
      });
      continue;
    }
    if (row.direct.status === 'resolved' && row.direct.topEntityId !== row.fullContainer.topEntityId) {
      divergences.push({
        qid: row.qid,
        query: row.query,
        mismatch: 'resolved_entity',
        direct: row.direct,
        fullContainer: row.fullContainer,
      });
      continue;
    }
    if (
      row.direct.status === 'resolved'
      && row.fullContainer.status === 'resolved'
      && row.direct.topLabel !== row.fullContainer.topLabel
    ) {
      divergences.push({
        qid: row.qid,
        query: row.query,
        mismatch: 'resolved_label',
        direct: row.direct,
        fullContainer: row.fullContainer,
      });
    }
  }

  const reasons = divergences.map((divergence) =>
    `[${divergence.qid}] ${divergence.mismatch}: direct=${formatOutcome(divergence.direct)} fullContainer=${formatOutcome(divergence.fullContainer)}`,
  );

  return {
    rowCount: rows.length,
    direct,
    fullContainer,
    divergences,
    gate: {
      pass: divergences.length === 0,
      reasons,
    },
  };
}

function formatOutcome(outcome: LookupEvalSideOutcome): string {
  if (outcome.status !== 'resolved') {
    return outcome.status;
  }
  return `${outcome.status}:${outcome.topEntityId ?? 'unknown'}:${outcome.topLabel ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------
// PER-CLASS no-regression gate — full-distribution authority.
// ---------------------------------------------------------------------------

export interface ClassTally {
  readonly correct: number;
  readonly wrong: number;
  readonly miss: number;
  readonly total: number;
}

export interface PerClassEntry {
  readonly queryClass: string;
  readonly shouldResolve: boolean;
  readonly v1: ClassTally;
  readonly v2: ClassTally;
}

export interface PerClassGateThresholds {
  readonly perClassCorrectRateRatioMin: number;
}

export const DEFAULT_PER_CLASS_GATE: PerClassGateThresholds = {
  perClassCorrectRateRatioMin: 0.98,
};

export interface PerClassGateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function classCorrectRate(tally: ClassTally): number {
  return ratio(tally.correct, tally.total);
}

export function evaluatePerClassGate(
  entries: readonly PerClassEntry[],
  thresholds: PerClassGateThresholds = DEFAULT_PER_CLASS_GATE,
): PerClassGateResult {
  const reasons: string[] = [];
  const ordered = [...entries].sort((a, b) => (
    a.queryClass < b.queryClass ? -1 : a.queryClass > b.queryClass ? 1 : 0
  ));
  for (const entry of ordered) {
    if (!entry.shouldResolve && entry.v2.wrong > 0) {
      reasons.push(
        `class ${entry.queryClass} (should-NOT-resolve) has ${String(entry.v2.wrong)} V2 wrong-positive(s); must be exactly 0`,
      );
    }
    const v1Rate = classCorrectRate(entry.v1);
    const v2Rate = classCorrectRate(entry.v2);
    if (v2Rate < v1Rate * thresholds.perClassCorrectRateRatioMin) {
      reasons.push(
        `class ${entry.queryClass} V2 correct-rate ${pct(v2Rate)} below V1 ${pct(v1Rate)} × `
          + `${thresholds.perClassCorrectRateRatioMin.toFixed(2)} tolerance`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}
