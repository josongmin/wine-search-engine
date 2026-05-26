/**
 * Regression — SSoT discipline for `ExecutionPlanKind` / `EXECUTION_PLAN_KINDS`
 * (CLAUDE.md rule 30 — Single Source of Truth).
 *
 * Background
 * ----------
 * The plan-kind string literals (`'single-search'`, `'comparison'`,
 * `'food-pairing-then-search'`, `'search-then-drinkability'`,
 * `'parallel-search'`, `'multi-step'`, `'reject'`) used to live in 4+
 * files: `deterministic-router.ts` (returns), `execution-plan-schemas.ts`
 * (Zod union literals), `wine-search-orchestrator.ts` (dispatch + finalize
 * args), and `execution-runner.ts` (switch cases). Renaming a kind in one
 * place but not another would type-check fine and ship a silent bug.
 *
 * Fix: `EXECUTION_PLAN_KINDS as const` tuple + derived `ExecutionPlanKind`
 * type in `execution-plan-schemas.ts`. The router imports named locals
 * sourced from the tuple, the orchestrator dispatches via an exhaustive
 * `switch` with a `never` default, and a compile-time parity guard
 * (`_AssertEqual`) inside `execution-plan-schemas.ts` ensures the tuple
 * and the Zod-inferred union stay in lockstep.
 *
 * These runtime tests pin the SSoT properties that survive even when the
 * compile-time guard is bypassed (e.g. via `as` casts in third-party code).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_PLAN_KINDS,
  ExecutionPlanSchema,
  type ExecutionPlan,
  type ExecutionPlanKind,
} from '../execution-plan-schemas.js';

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Membership & arity
// ---------------------------------------------------------------------------

describe('EXECUTION_PLAN_KINDS — SSoT tuple shape', () => {
  it('contains all 4 known plan kinds, in canonical order', () => {
    // Order matters: the router rules table in `deterministic-router.ts`
    // and the dispatch switch in the orchestrator both rely on the
    // `'single-search'`-first convention (happy path = 80%).
    expect([...EXECUTION_PLAN_KINDS]).toEqual([
      'single-search',
      'parallel-search',
      'multi-step',
      'reject',
    ]);
  });

  it('has exactly 4 members (catches accidental additions/removals)', () => {
    expect(EXECUTION_PLAN_KINDS.length).toBe(4);
  });

  it('every tuple member is non-empty and lower-kebab-case', () => {
    for (const kind of EXECUTION_PLAN_KINDS) {
      expect(typeof kind).toBe('string');
      expect(kind.length).toBeGreaterThan(0);
      // SSoT discipline: machine-parseable kind names must be ASCII
      // kebab-case (CLAUDE.md rule 21 — locale-stable identifiers).
      expect(kind).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(EXECUTION_PLAN_KINDS).size).toBe(EXECUTION_PLAN_KINDS.length);
  });
});

// ---------------------------------------------------------------------------
// Zod parity — `ExecutionPlanSchema` accepts every SSoT kind and rejects any
// kind outside the tuple.
// ---------------------------------------------------------------------------

describe('EXECUTION_PLAN_KINDS — Zod schema parity', () => {
  /**
   * Build a syntactically valid `ExecutionPlan` for each tuple member so
   * we can confirm `ExecutionPlanSchema.parse(...)` accepts every kind.
   * Each branch needs the minimal required fields to satisfy the Zod
   * discriminated union without piggy-backing on heavy fixtures.
   */
  function minimalPlanFor(kind: ExecutionPlanKind): ExecutionPlan {
    switch (kind) {
      case 'single-search':
        return { kind, searchInput: { query: 'wine' } };
      case 'parallel-search':
        return {
          kind,
          searches: [{ query: 'wine A' }, { query: 'wine B' }],
        };
      case 'multi-step':
        return {
          kind,
          handoff: {
            initialAction: 'search',
            budget: { maxSteps: 4, perToolCap: 3 },
            contract: {
              requiresDrinkabilityCheck: false,
              requiresGroundedWineSearch: true,
              hasEntityMetadataSignal: false,
            },
            seedSearchInput: { query: 'seed' },
          },
        };
      case 'reject':
        return { kind, reason: 'unsupported_intent' };
    }
  }

  // `it.each` requires a mutable array — `EXECUTION_PLAN_KINDS` is `readonly`.
  it.each([...EXECUTION_PLAN_KINDS])(
    'ExecutionPlanSchema accepts plan kind=%s',
    (kind) => {
      const plan = minimalPlanFor(kind);
      const parsed = ExecutionPlanSchema.parse(plan);
      expect(parsed.kind).toBe(kind);
    },
  );

  it('rejects an unknown plan kind that is NOT in the SSoT tuple', () => {
    const malformed = { kind: 'not-a-real-kind', searchInput: { query: 'x' } };
    const result = ExecutionPlanSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-text guard — router & orchestrator may not contain plan-kind
// literals that drift from the SSoT tuple. Specifically we forbid the
// `kind: '<literal>'` pattern (i.e. literal-typed object-property
// assignments) in `deterministic-router.ts` — every router `return`
// must funnel through one of the `PLAN_KIND_*` named locals so a kind
// rename in `EXECUTION_PLAN_KINDS` propagates through `tsc`.
//
// This is a defense-in-depth net against a future PR that re-introduces
// `return { kind: 'single-search', ... }` style literals.
// ---------------------------------------------------------------------------

describe('EXECUTION_PLAN_KINDS — source-text discipline', () => {
  function readSource(rel: string): string {
    return readFileSync(path.join(PACKAGE_DIR, rel), 'utf8');
  }

  it('deterministic-router.ts has no bare `kind: <plan-kind-literal>` returns in object literals', () => {
    // Scope: forbid VALUE-position literals like
    //   `return { kind: 'comparison', ... }`
    // i.e. `kind: '<literal>',` followed by a comma or close-brace.
    // TYPE-position usages such as
    //   `decomposition is Extract<Decomposition, { kind: 'comparison' }>`
    // are legitimate generic type-narrowing and are NOT flagged.
    //
    // The trailing `[,}]` lookahead is what disambiguates: in a type
    // generic the literal is followed by a closing `}` of the type-arg
    // (typically `} >`); in an object literal it is followed by a comma
    // (or the closing brace of the inline-property object). The latter
    // is what we forbid.
    const src = readSource('deterministic-router.ts');
    for (const kind of EXECUTION_PLAN_KINDS) {
      // Match `kind: '<kind>',` (with trailing comma — value-position
      // pattern in router return objects). The router's returns always
      // have additional properties after `kind`, so the comma is reliable.
      const literalPattern = new RegExp(`kind\\s*:\\s*['"]${kind}['"]\\s*,`);
      expect(
        literalPattern.test(src),
        `deterministic-router.ts contains a value-position plan-kind literal "${kind}" — use a PLAN_KIND_* named local from EXECUTION_PLAN_KINDS instead.`,
      ).toBe(false);
    }
  });

  it('orchestrator dispatch switch contains a `never` exhaustiveness assertion', () => {
    // The dispatch switch in `dispatchPlan` must have a `default: never`
    // assertion so adding a new ExecutionPlanKind fails at `tsc`.
    const src = readSource('wine-search-orchestrator.ts');
    // The dispatch sentinel: a `_exhaustive: never = plan` line inside
    // the dispatch switch's default branch.
    expect(
      /_exhaustive\s*:\s*never\s*=\s*plan/.test(src),
      'wine-search-orchestrator.ts dispatch switch is missing the `_exhaustive: never = plan` guard',
    ).toBe(true);
  });

  it('execution-runner.ts switch on plan.kind contains a `never` exhaustiveness assertion', () => {
    const src = readSource('execution-runner.ts');
    expect(
      /_exhaustive\s*:\s*never\s*=\s*plan/.test(src),
      'execution-runner.ts plan-dispatch switch is missing the `_exhaustive: never = plan` guard',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantees — these are compile-time invariants, surfaced here
// for documentation. The file does NOT need to construct values; if the
// type aliases below ever fail to compile, the SSoT has drifted.
// ---------------------------------------------------------------------------

// `ExecutionPlanKind` must equal `typeof EXECUTION_PLAN_KINDS[number]`.
type _T1Check = ExecutionPlanKind extends typeof EXECUTION_PLAN_KINDS[number]
  ? typeof EXECUTION_PLAN_KINDS[number] extends ExecutionPlanKind ? true : never
  : never;
// `ExecutionPlan['kind']` (Zod-inferred) must equal `ExecutionPlanKind`.
type _T2Check = ExecutionPlan['kind'] extends ExecutionPlanKind
  ? ExecutionPlanKind extends ExecutionPlan['kind'] ? true : never
  : never;

// Mark them as referenced so the file emits no unused-type lint warnings.
const _typeChecks: readonly [_T1Check, _T2Check] = [true, true];
void _typeChecks;
