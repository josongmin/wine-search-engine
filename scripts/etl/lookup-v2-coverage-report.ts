/**
 * Entity Lookup V2 — hot-entity coverage report (T-ELV2-03).
 *
 * The coverage classification core moved to the domain SSoT at
 * `src/domain/resolver/v2/coverage-report.ts` so that application/interface code
 * (the T-ELV2-07 operator coverage/health use-case) can import it without
 * crossing the layer boundary into `scripts/`. This module re-exports the core
 * for existing ETL callers — no duplicated logic (CLAUDE.md SSoT rule 30).
 */

export {
  buildCoverageReport,
  formatCoverageReport,
  type CoverageInputRow,
  type CoverageHole,
  type CoverageReport,
  type CoverageStatus,
} from '../../src/domain/resolver/v2/coverage-report.js';
