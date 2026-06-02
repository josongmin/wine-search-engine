# PR-level micro-bench gate

> Current status: `bench:smoke` is the only repo-native executable PR bench
> lane. The repo does not currently ship `test/benchmark/agent/runner.ts`, so
> report/baseline regression mode is for externally materialized or historical
> report artifacts only. See `docs/bench/STATUS.md`.

The `bench-smoke` GitHub workflow runs on every PR and merge-queue entry.
It exits non-zero (failing the check) when:

1. `pnpm run bench:smoke` (the deterministic benchmark unit/regression lane)
   fails.
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
pnpm exec tsx scripts/eval/bench-pr-gate.ts

# Smoke + a completed report's critical-failure check:
pnpm exec tsx scripts/eval/bench-pr-gate.ts \
  --report data/bench-archive/<sha>-<utc>.json

# Smoke + critical-failure + regression-vs-baseline:
pnpm exec tsx scripts/eval/bench-pr-gate.ts \
  --report   data/bench-archive/<sha>-<utc>.json \
  --baseline data/bench-archive/<frozen-baseline>.json \
  --threshold-pp 2.0
```

## Override mechanism

Genuine exceptions (provider outage, frozen-baseline schema migration) get a
controlled escape hatch:

- In CI, set the repository variable `BENCH_SMOKE_OVERRIDE` to `YES`.
- Locally, `BENCH_SMOKE_OVERRIDE=YES pnpm exec tsx scripts/eval/bench-pr-gate.ts`.

The override SHORT-CIRCUITS the entire gate. Don't use it to ship work that
has a real regression; document the reason in the PR description.

## CI integration

The workflow is at `.github/workflows/bench-smoke.yml`. It uses the existing
`./.github/actions/setup-node-ci` composite action (same as the lint/typecheck
jobs) so it stays consistent with the rest of the matrix.

To extend the gate to also run the bootstrap, add a separate workflow job
that:

1. Downloads a frozen baseline archive (or reads from an existing artifact).
2. Restores a real agent runner / report producer first.
3. Calls `pnpm exec tsx scripts/eval/bench-pr-gate.ts --report /tmp/report.json --baseline <baseline>`.

This is deliberately not enabled by default. The current repo does not ship the
runner that would materialize `/tmp/report.json`, and any future live lane will
also need runtime credentials that are unsafe on PRs from forks.
