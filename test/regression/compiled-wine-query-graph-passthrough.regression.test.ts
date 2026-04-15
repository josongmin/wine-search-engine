/**
 * ADR-011 Phase 1b.1: `ExecutionCompiler` copies `QueryPlanV2.constraintGraph`
 * onto `CompiledWineQuery.constraintGraph` when present, and leaves the
 * field `undefined` when absent (feature-flag-off parity).
 *
 * Grep-level contract: `CompiledWineQuery` declares the field, and the
 * compiler includes the conditional spread.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMPILED_WINE_QUERY_SRC = fileURLToPath(
  new URL('../../src/domain/query/model/compiled-wine-query.ts', import.meta.url),
);
const EXECUTION_COMPILER_SRC = fileURLToPath(
  new URL('../../src/domain/query/service/execution-compiler.ts', import.meta.url),
);

describe('CompiledWineQuery graph passthrough (source contract)', () => {
  it('CompiledWineQuery declares constraintGraph as an optional passthrough', () => {
    const src = readFileSync(COMPILED_WINE_QUERY_SRC, 'utf8');
    expect(src).toMatch(/readonly constraintGraph\?:\s*ConstraintGraph\s*\|\s*undefined/);
    expect(src).toMatch(/import type \{[^}]*ConstraintGraph[^}]*\} from '\.\/constraint-graph\.js'/);
  });

  it('ExecutionCompiler copies plan.constraintGraph conditionally', () => {
    const src = readFileSync(EXECUTION_COMPILER_SRC, 'utf8');
    expect(src).toMatch(/plan\.constraintGraph\s*!==\s*undefined/);
    expect(src).toMatch(/constraintGraph:\s*plan\.constraintGraph/);
  });
});
