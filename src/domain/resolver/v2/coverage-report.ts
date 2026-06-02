/**
 * Entity Lookup V2 — hot-entity coverage report core (T-ELV2-03 / T-ELV2-07).
 *
 * Pure, infra-free classification of how the V2 lookup performs over a labeled
 * hot-entity set. Its job is to surface COVERAGE HOLES — hot entities that the
 * gold says should resolve but the engine could not — so they enter the
 * curation flow as alias/registry proposals (RFC DoD §2 — `dom perignon` /
 * `돔페리뇽`류 hole이 coverage report와 curation flow에서 다뤄진다).
 *
 * This is the SSoT for coverage classification. The ETL script
 * (`scripts/etl/lookup-v2-coverage-report.ts`) and the operator coverage/health
 * use-case (T-ELV2-07) both import from here — no duplicated logic. The script's
 * live wrapper runs `/v2/entity-lookup` over the hotset corpus
 * (`test/fixtures/lookup-v2-hotset.jsonl`) and feeds the observed statuses in;
 * keeping the classification pure makes the report deterministic and testable.
 *
 * Domain leaf: this module imports nothing outside the domain (pure).
 */

export type CoverageStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

export interface CoverageInputRow {
  readonly qid: string;
  readonly query: string;
  /** Gold expectation for this query. */
  readonly expectedStatus: CoverageStatus;
  /** Hotset class tag (e.g. hot_entity_coverage, concept_grape). */
  readonly class: string;
  /** What the engine actually returned. */
  readonly observedStatus: CoverageStatus;
}

/** A hot entity the gold says should resolve, but the engine did not. */
export interface CoverageHole {
  readonly qid: string;
  readonly query: string;
  readonly class: string;
  readonly observedStatus: CoverageStatus;
}

export interface CoverageReport {
  /** Rows whose gold expectation is a resolve (hot entities). */
  readonly hotEntityCount: number;
  /** Hot entities that resolved correctly. */
  readonly coveredCount: number;
  /** Hot entities that failed to resolve — these need curation. */
  readonly holes: readonly CoverageHole[];
  /** coveredCount / hotEntityCount. */
  readonly coverageRate: number;
  /** Non-resolve expectations (concept/under-spec) handled correctly. */
  readonly nonEntityCorrect: number;
  readonly nonEntityTotal: number;
  /** Holes grouped by hotset class, for prioritising curation. */
  readonly holesByClass: Readonly<Record<string, number>>;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

export function buildCoverageReport(rows: readonly CoverageInputRow[]): CoverageReport {
  const hotRows = rows.filter((r) => r.expectedStatus === 'resolved');
  const nonEntityRows = rows.filter((r) => r.expectedStatus !== 'resolved');

  const holes: CoverageHole[] = [];
  let coveredCount = 0;
  for (const row of hotRows) {
    if (row.observedStatus === 'resolved') {
      coveredCount += 1;
    } else {
      holes.push({ qid: row.qid, query: row.query, class: row.class, observedStatus: row.observedStatus });
    }
  }

  let nonEntityCorrect = 0;
  for (const row of nonEntityRows) {
    if (row.observedStatus === row.expectedStatus) {
      nonEntityCorrect += 1;
    }
  }

  const holesByClass: Record<string, number> = {};
  for (const hole of holes) {
    holesByClass[hole.class] = (holesByClass[hole.class] ?? 0) + 1;
  }

  return {
    hotEntityCount: hotRows.length,
    coveredCount,
    holes,
    coverageRate: ratio(coveredCount, hotRows.length),
    nonEntityCorrect,
    nonEntityTotal: nonEntityRows.length,
    holesByClass,
  };
}

/** Render a concise operator-facing summary (newline-delimited). */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`hot entities: ${report.coveredCount}/${report.hotEntityCount} covered (${(report.coverageRate * 100).toFixed(1)}%)`);
  lines.push(`non-entity handling: ${report.nonEntityCorrect}/${report.nonEntityTotal} correct`);
  if (report.holes.length > 0) {
    lines.push(`coverage holes (need curation):`);
    for (const hole of report.holes) {
      lines.push(`  - [${hole.class}] "${hole.query}" → ${hole.observedStatus} (qid ${hole.qid})`);
    }
  } else {
    lines.push('no coverage holes');
  }
  return lines.join('\n');
}
