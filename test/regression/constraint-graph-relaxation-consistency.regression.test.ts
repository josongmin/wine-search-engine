/**
 * Post-Wave1 hotfix: constraint relaxation and graph consistency.
 *
 * Two guarantees locked here:
 *
 * 1. `ConstraintReasonerOutput` exposes `survivingAtoms` (the atoms that
 *    survived conflict / redundancy / overshadow resolution). The
 *    compiler MUST build the trivial graph from `survivingAtoms`, NOT
 *    the raw `atoms` list — otherwise dropped atoms leak into the graph
 *    as ghost hard-tier slots and the ranker's graph hard-gate fails
 *    legitimate candidates.
 *
 * 2. `buildRelaxedCompiledQuery` on the no-result-recovery path strips
 *    `constraintGraph` from the relaxed compiled query. The graph is
 *    produced once at compile time; relaxation mutates
 *    `compiled.query.constraints` but cannot mutate the graph in place.
 *    Stripping forces every graph-aware reader onto the flat fallback
 *    path (byte-identical to pre-Phase-1b.1 behaviour) for relaxed
 *    queries, which is the only consistent contract until a later phase
 *    introduces graph regeneration on relaxation.
 *
 * Regression trigger: golden-set `'Masi Amarone'` and `'Barolo Monfortino'`
 * returned zero results between PR5 landing and this hotfix because the
 * relaxed query's stale graph still carried a `region` hard slot that the
 * relaxed bundle had already dropped.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConstraintReasoner } from '../../src/domain/query/service/constraint-reasoner.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';

const COMPILER_SRC = fileURLToPath(
  new URL('../../src/domain/query/service/constraint-compiler.ts', import.meta.url),
);
const RANKING_PIPELINE_SRC = fileURLToPath(
  new URL(
    '../../src/application/search/search-usecase-hybrid-ranking-pipeline.ts',
    import.meta.url,
  ),
);

describe('ConstraintReasoner survivingAtoms exposure', () => {
  it('exposes survivingAtoms alongside the raw atoms list', () => {
    const bundle: ConstraintBundle = {
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const out = new ConstraintReasoner().reason(bundle);
    expect(Array.isArray(out.atoms)).toBe(true);
    expect(Array.isArray(out.survivingAtoms)).toBe(true);
    expect(out.survivingAtoms.length).toBeLessThanOrEqual(out.atoms.length);
  });

  it('survivingAtoms drops contradicted atoms that the raw list keeps', () => {
    const bundle: ConstraintBundle = {
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'white',
          source_phrase: 'white',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const out = new ConstraintReasoner().reason(bundle);
    expect(out.atoms.length).toBe(2);
    // Contradiction resolver drops one of the two — surviving list must be strictly smaller.
    expect(out.survivingAtoms.length).toBeLessThan(out.atoms.length);
    // `resolvedBundle` and `survivingAtoms` are produced from the same pruning pass,
    // so their atom-counts must match.
    const resolvedAtomCount =
      out.resolvedBundle.hard.length +
      out.resolvedBundle.soft.length +
      out.resolvedBundle.inferred.length;
    expect(out.survivingAtoms.length).toBe(resolvedAtomCount);
  });
});

describe('ConstraintCompiler uses survivingAtoms for the graph path', () => {
  const src = readFileSync(COMPILER_SRC, 'utf8');

  it('buildTrivialGraphFromAtoms is called with survivingAtoms, not raw atoms', () => {
    expect(src).toMatch(/buildTrivialGraphFromAtoms\(reasonerOutput\.survivingAtoms\)/);
    // And MUST NOT call it with the raw list.
    expect(src).not.toMatch(/buildTrivialGraphFromAtoms\(reasonerOutput\.atoms\)/);
  });

  it('topology planner is invoked with survivingAtoms, not raw atoms', () => {
    expect(src).toMatch(/atoms:\s*reasonerOutput\.survivingAtoms/);
    expect(src).not.toMatch(/atoms:\s*reasonerOutput\.atoms,\s*\n\s*normalizedQuery/);
  });
});

describe('buildRelaxedCompiledQuery strips the stale constraintGraph', () => {
  const src = readFileSync(RANKING_PIPELINE_SRC, 'utf8');

  it('the relaxed compiled query does NOT inherit compiled.constraintGraph', () => {
    // The old bug spread ...compiled without stripping constraintGraph. The
    // hotfix extracts constraintGraph via destructuring and spreads the rest.
    expect(src).toMatch(/const \{ constraintGraph: _droppedStaleGraph, \.\.\.compiledSansGraph \} = compiled/);
    expect(src).toMatch(/function buildRelaxedCompiledQuery[\s\S]*\.\.\.compiledSansGraph/);
  });
});
