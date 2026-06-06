/**
 * Entity Lookup V2 — hot-entity coverage report core (T-ELV2-03 / T-ELV2-07).
 *
 * Pure, infra-free classification of how the V2 lookup performs over a labeled
 * hot-entity set. Its job is to surface COVERAGE HOLES — hot entities that the
 * gold says should resolve but the engine could not — so they enter the
 * curation flow as alias/registry proposals (RFC DoD §2 — `dom perignon` /
 * `돔페리뇽`류 hole이 coverage report와 curation flow에서 다뤄진다).
 *
 * This is the SSoT for coverage classification. Its sole production consumer is
 * the live coverage runner `scripts/eval/run-lookup-v2-coverage-report.ts`
 * (`pnpm run eval:lookup-v2:coverage`), which runs `/v2/entity-lookup` over the
 * hotset corpus (`test/fixtures/lookup-v2-hotset.jsonl`), feeds the observed
 * statuses in here, and pipes the resulting holes into `buildCurationTasks` for
 * the T-07 operator write-plane queue. Keeping the classification pure makes the
 * report deterministic and testable.
 *
 * Domain leaf: this module imports nothing outside the domain (pure).
 */

export type CoverageStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';
export type CoverageHoleOperatorBucket =
  | 'strict_collision_ambiguous'
  | 'localized_surface_gap'
  | 'scope_target_missing'
  | 'catalog_support_needed';

export interface CoverageInputRow {
  readonly qid: string;
  readonly query: string;
  /** Gold expectation for this query. */
  readonly expectedStatus: CoverageStatus;
  /**
   * Optional exact set of statuses that count as correct for this row. This is
   * for precision-first "must not resolve" rows where multiple abstentions are
   * acceptable (`failed` OR `ambiguous`, but never `resolved`).
   */
  readonly acceptedStatuses?: readonly CoverageStatus[] | undefined;
  /** Optional benchmark gold hint for the expected entity. */
  readonly expectedEntityHint?: string | undefined;
  /** Optional exact benchmark gold entity id when the corpus carries it. */
  readonly expectedEntityId?: string | undefined;
  /** Hotset class tag (e.g. hot_entity_coverage, concept_grape). */
  readonly class: string;
  /** What the engine actually returned. */
  readonly observedStatus: CoverageStatus;
  /** Optional canonical decision reason code returned by the runtime. */
  readonly observedReasonCode?: string | undefined;
  /** Reviewed support-plane status for the intended family, if one exists. */
  readonly supportStatus?: 'active_catalog_absent' | 'vintage_anchor_absent' | 'secondary_line_only' | undefined;
  /** Whether this exact localized query surface is already reviewed. */
  readonly localizedSurfaceReviewed?: boolean | undefined;
}

/** A hot entity the gold says should resolve, but the engine did not. */
export interface CoverageHole {
  readonly qid: string;
  readonly query: string;
  readonly class: string;
  readonly observedStatus: CoverageStatus;
  readonly operatorBucket: CoverageHoleOperatorBucket;
  readonly observedReasonCode?: string | undefined;
  readonly expectedEntityHint?: string | undefined;
  readonly expectedEntityId?: string | undefined;
}

export interface CoverageReport {
  /** Rows whose gold expectation is a resolve (hot entities). */
  readonly hotEntityCount: number;
  /** Hot-entity rows whose observed status stayed inside the accepted set. */
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
  /** Holes grouped by strict operator bucket, for owner routing. */
  readonly holesByOperatorBucket: Readonly<Record<CoverageHoleOperatorBucket, number>>;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function acceptedStatuses(row: CoverageInputRow): readonly CoverageStatus[] {
  return row.acceptedStatuses ?? [row.expectedStatus];
}

function classifyHole(row: CoverageInputRow): CoverageHoleOperatorBucket {
  if (row.supportStatus !== undefined) {
    return 'catalog_support_needed';
  }
  if (row.observedReasonCode === 'reviewed_family_collision_requires_clarification') {
    return 'strict_collision_ambiguous';
  }
  if (row.localizedSurfaceReviewed === false) {
    return 'localized_surface_gap';
  }
  return 'scope_target_missing';
}

export function buildCoverageReport(rows: readonly CoverageInputRow[]): CoverageReport {
  const hotRows = rows.filter((r) => acceptedStatuses(r).includes('resolved'));
  const nonEntityRows = rows.filter((r) => !acceptedStatuses(r).includes('resolved'));

  const holes: CoverageHole[] = [];
  let coveredCount = 0;
  for (const row of hotRows) {
    if (acceptedStatuses(row).includes(row.observedStatus)) {
      coveredCount += 1;
    } else {
      holes.push({
        qid: row.qid,
        query: row.query,
        class: row.class,
        observedStatus: row.observedStatus,
        operatorBucket: classifyHole(row),
        ...(row.observedReasonCode !== undefined ? { observedReasonCode: row.observedReasonCode } : {}),
        ...(row.expectedEntityHint !== undefined ? { expectedEntityHint: row.expectedEntityHint } : {}),
        ...(row.expectedEntityId !== undefined ? { expectedEntityId: row.expectedEntityId } : {}),
      });
    }
  }

  let nonEntityCorrect = 0;
  for (const row of nonEntityRows) {
    if (acceptedStatuses(row).includes(row.observedStatus)) {
      nonEntityCorrect += 1;
    }
  }

  const holesByClass: Record<string, number> = {};
  const holesByOperatorBucket: Record<CoverageHoleOperatorBucket, number> = {
    strict_collision_ambiguous: 0,
    localized_surface_gap: 0,
    scope_target_missing: 0,
    catalog_support_needed: 0,
  };
  for (const hole of holes) {
    holesByClass[hole.class] = (holesByClass[hole.class] ?? 0) + 1;
    holesByOperatorBucket[hole.operatorBucket] += 1;
  }

  return {
    hotEntityCount: hotRows.length,
    coveredCount,
    holes,
    coverageRate: ratio(coveredCount, hotRows.length),
    nonEntityCorrect,
    nonEntityTotal: nonEntityRows.length,
    holesByClass,
    holesByOperatorBucket,
  };
}

/** Render a concise operator-facing summary (newline-delimited). */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`hot entities: ${report.coveredCount}/${report.hotEntityCount} covered (${(report.coverageRate * 100).toFixed(1)}%)`);
  lines.push(`non-entity handling: ${report.nonEntityCorrect}/${report.nonEntityTotal} correct`);
  if (report.holes.length > 0) {
    lines.push(`coverage holes (need curation):`);
    lines.push(`hole buckets: strict_collision_ambiguous=${report.holesByOperatorBucket.strict_collision_ambiguous}, localized_surface_gap=${report.holesByOperatorBucket.localized_surface_gap}, scope_target_missing=${report.holesByOperatorBucket.scope_target_missing}, catalog_support_needed=${report.holesByOperatorBucket.catalog_support_needed}`);
    for (const hole of report.holes) {
      lines.push(`  - [${hole.class}/${hole.operatorBucket}] "${hole.query}" → ${hole.observedStatus} (qid ${hole.qid})`);
    }
  } else {
    lines.push('no coverage holes');
  }
  return lines.join('\n');
}
