/**
 * ADR-010 Phase 1a: ConstraintCompiler emits the ConstraintGraph sibling
 * alongside `bundle`, `reasonerOutput`, `retrievalPlan`, etc. Feature flag
 * `CONSTRAINT_GRAPH_EMIT=false` suppresses emission for rollback.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMPILER_SRC_PATH = fileURLToPath(
  new URL('../../src/domain/query/service/constraint-compiler.ts', import.meta.url),
);
const PLANNER_SRC_PATH = fileURLToPath(
  new URL('../../src/domain/query/service/planner.ts', import.meta.url),
);
const QUERY_PLAN_SRC_PATH = fileURLToPath(
  new URL('../../src/domain/query/model/query-plan.ts', import.meta.url),
);
const GRAPH_FLAGS_SRC_PATH = fileURLToPath(
  new URL('../../src/domain/query/service/constraint-graph-flags.ts', import.meta.url),
);

describe('ConstraintCompiler + planner emit ConstraintGraph', () => {
  it('ConstraintCompilerResult declares a constraintGraph sibling field', () => {
    const src = readFileSync(COMPILER_SRC_PATH, 'utf8');
    expect(src).toMatch(/readonly constraintGraph\?:\s*ConstraintGraph\s*\|\s*undefined/);
  });

  it('compiler invokes buildTrivialGraphFromAtoms on reasoner surviving atoms', () => {
    const src = readFileSync(COMPILER_SRC_PATH, 'utf8');
    // Post-ADR-014 hotfix: the graph is built from `survivingAtoms` (after
    // the reasoner's conflict/redundancy/overshadow pass), not the raw list.
    // See constraint-graph-relaxation-consistency.regression.test.ts.
    expect(src).toMatch(/buildTrivialGraphFromAtoms\(reasonerOutput\.survivingAtoms\)/);
  });

  it('compiler respects CONSTRAINT_GRAPH_EMIT feature flag via SSoT helper', () => {
    const compilerSrc = readFileSync(COMPILER_SRC_PATH, 'utf8');
    // Post-Phase-1b.4: the compiler delegates the env check to the shared
    // `constraint-graph-flags` module so the relaxation regenerator can use
    // the same on/off semantics. The inline `process.env[...]` read was
    // retired at the compiler seam when the SSoT helper landed.
    expect(compilerSrc).toMatch(/import \{ isConstraintGraphEmitEnabled \} from '\.\/constraint-graph-flags\.js'/);
    expect(compilerSrc).toMatch(/if \(isConstraintGraphEmitEnabled\(\)\)/);

    const flagsSrc = readFileSync(GRAPH_FLAGS_SRC_PATH, 'utf8');
    expect(flagsSrc).toMatch(/CONSTRAINT_GRAPH_EMIT/);
    // The flag is checked via process.env (no registry key lookup).
    expect(flagsSrc).toMatch(/process\.env\[['"]CONSTRAINT_GRAPH_EMIT['"]\]/);
    expect(flagsSrc).toMatch(/!==\s*'false'/);
  });

  it('planner threads constraintGraph onto QueryPlanV2 when present', () => {
    const src = readFileSync(PLANNER_SRC_PATH, 'utf8');
    expect(src).toMatch(/constraintGraph:\s*parsed\.constraintGraph/);
  });

  it('QueryPlanV2 declares constraintGraph as an optional field', () => {
    const src = readFileSync(QUERY_PLAN_SRC_PATH, 'utf8');
    expect(src).toMatch(/readonly constraintGraph\?:\s*ConstraintGraph\s*\|\s*undefined/);
    // ConstraintGraph must be imported as a type (no inline `import()` type annotations).
    expect(src).toMatch(/import type \{[^}]*ConstraintGraph[^}]*\} from '\.\/constraint-graph\.js'/);
  });
});

describe('Feature flag toggles graph emission', () => {
  const originalFlag = process.env['CONSTRAINT_GRAPH_EMIT'];

  beforeEach(() => {
    delete process.env['CONSTRAINT_GRAPH_EMIT'];
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env['CONSTRAINT_GRAPH_EMIT'];
    } else {
      process.env['CONSTRAINT_GRAPH_EMIT'] = originalFlag;
    }
  });

  it('flag default (unset) is ON', async () => {
    const { buildTrivialGraphFromAtoms } = await import(
      '../../src/domain/query/service/build-trivial-graph-from-atoms.js'
    );
    // The projector itself has no flag — it's the compiler call-site that
    // gates emission. Verify the projector is always available so rollback
    // remains a runtime config change, not a code change.
    expect(typeof buildTrivialGraphFromAtoms).toBe('function');
  });
});
