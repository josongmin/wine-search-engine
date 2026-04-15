/**
 * ADR-010 Phase 1a: Downstream readers MUST remain on `constraints` /
 * `constraintAtoms` in Phase 1a. No reader is allowed to consume
 * `plan.constraintGraph` yet — Phase 1b migrates the first reader
 * (`provenance-closure`) explicitly.
 *
 * Guards against accidental Phase-1b leaks into Phase-1a code.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
);

/**
 * Files explicitly allowed to reference `constraintGraph` in Phase 1a.
 * - The type itself
 * - The projector
 * - The compiler seam that calls the projector
 * - Planner surface that threads the field onto V2
 * - QueryPlanV2 type where the field is declared
 * - ADR-010 / plan doc references
 * - Regression tests that lock the contract
 */
const PHASE_1A_ALLOWLIST: readonly RegExp[] = [
  /src\/domain\/query\/model\/constraint-graph\.ts$/,
  /src\/domain\/query\/model\/query-plan\.ts$/,
  /src\/domain\/query\/service\/build-trivial-graph-from-atoms\.ts$/,
  /src\/domain\/query\/service\/constraint-compiler\.ts$/,
  /src\/domain\/query\/service\/planner\.ts$/,
  /docs\//,
  /test\/regression\//,
  /test\/benchmark\//,
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      listTsFiles(abs, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('Phase 1a — no unauthorised constraintGraph readers', () => {
  it('no src/ file outside the allow-list references plan.constraintGraph', () => {
    const srcRoot = join(REPO_ROOT, 'src');
    const files = listTsFiles(srcRoot);
    const offenders: string[] = [];

    for (const abs of files) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      if (PHASE_1A_ALLOWLIST.some((re) => re.test(rel))) continue;
      const src = readFileSync(abs, 'utf8');
      // Phase 1a ban: reading `.constraintGraph` off a plan / compiled query /
      // compiler result. Allow `constraintGraphEmissionRate` in bench etc.
      if (/\.constraintGraph\b(?!Emission)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
