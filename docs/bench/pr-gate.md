# PR-level micro-bench gate

The `bench-smoke` GitHub workflow runs on every PR and merge-queue entry.
It exits non-zero (failing the check) when:

1. `pnpm run bench:smoke` (the lightweight unit lane defined in
   `test/benchmark/agent/smoke.ts`) fails. This is the existing smoke set
   plus any new tests added to that file.
2. `scripts/eval/bench-pr-gate.ts` flags a critical-failure or, when a
   `--baseline` is supplied, a significant regression vs a frozen baseline.

## When the gate fires

| Trigger | Exit code | Resolution |
| --- | --- | --- |
| `bench:smoke` test failure | 1 | Fix the failing test |
| Current report has `criticalFailureCount > 0` | 2 | Fix the scenario(s) that hard-failed |
| Paired bootstrap: Δ < -threshold-pp AND CI upper < -threshold-pp | 3 | Investigate the per-scenario regressions; re-run with same seed before reverting |

The default threshold is **2.0pp**. Override per-run with
`--threshold-pp <n>` if calling the gate manually.

## Calling the gate manually

```bash
# Smoke only (no live bench run needed):
tsx scripts/eval/bench-pr-gate.ts

# Smoke + a completed report's critical-failure check:
tsx scripts/eval/bench-pr-gate.ts \
  --report data/bench-archive/<sha>-<utc>.json

# Smoke + critical-failure + regression-vs-baseline:
tsx scripts/eval/bench-pr-gate.ts \
  --report   data/bench-archive/<sha>-<utc>.json \
  --baseline data/bench-archive/<frozen-baseline>.json \
  --threshold-pp 2.0
```

## Override mechanism

Genuine exceptions (provider outage, frozen-baseline schema migration) get a
controlled escape hatch:

- In CI, set the repository variable `BENCH_SMOKE_OVERRIDE` to `YES`.
- Locally, `BENCH_SMOKE_OVERRIDE=YES tsx scripts/eval/bench-pr-gate.ts`.

The override SHORT-CIRCUITS the entire gate. Don't use it to ship work that
has a real regression; document the reason in the PR description.

## CI integration

The workflow is at `.github/workflows/bench-smoke.yml`. It uses the existing
`./.github/actions/setup-node-ci` composite action (same as the lint/typecheck
jobs) so it stays consistent with the rest of the matrix.

To extend the gate to also run the bootstrap, add a separate workflow job
that:

1. Downloads a frozen baseline archive (or reads from an existing artifact).
2. Runs a quick bench (`pnpm run benchmark:exploratory:quick --out=/tmp/report.json`).
3. Calls `tsx scripts/eval/bench-pr-gate.ts --report /tmp/report.json --baseline <baseline>`.

This is deliberately not enabled by default — quick-profile runs need live
OpenAI / Vespa credentials that aren't safe on PRs from forks.
