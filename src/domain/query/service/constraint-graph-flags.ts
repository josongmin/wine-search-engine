/**
 * SSoT for ConstraintGraph feature flag checks.
 *
 * Extracted per Rule 30 (cross-module constants): the
 * `CONSTRAINT_GRAPH_EMIT` env flag was originally read inline inside
 * `ConstraintCompiler`, but Phase 1b.4 (graph regeneration on
 * constraint relaxation) adds a second production reader inside
 * `buildRelaxedCompiledQuery`. Two independent inline reads would drift
 * silently — centralising here guarantees the compiler and the
 * relaxation regenerator honour identical on/off semantics.
 *
 * Default: ON (undefined env → emit). Only the literal string `'false'`
 * disables emission, mirroring the historical compiler contract used by
 * the Phase 1a / Phase 1b rollback runbooks.
 */
export function isConstraintGraphEmitEnabled(): boolean {
  return process.env['CONSTRAINT_GRAPH_EMIT'] !== 'false';
}
