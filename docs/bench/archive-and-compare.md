# Bench Archive + Compare (SOTA++)

> Historical/dormant note: this flow assumes a live agent benchmark runner that
> writes benchmark report archives. The current repo checkout does not ship
> `test/benchmark/agent/runner.ts`, so treat this document as design/reference
> only until that runner is restored. See `docs/bench/STATUS.md`.

## Where archives live

`data/bench-archive/<sha8>-<utc>.json` and a sibling
`<sha8>-<utc>.manifest.json` for cheap indexing.

The directory is `.gitignored`. Don't commit archives — they grow fast.

Every standard-profile run writes an archive automatically. Disable per-run
with `--no-archive` (e.g. throwaway debug runs).

## Manifest fields

`bench-archive.ts` writes a minimal manifest with:

- `capturedAt` — report timestamp (ISO 8601 UTC)
- `gitSha`, `profile`, `model`, `judgeModel`
- `scenarioCount`, `overallScore`, `criticalFailureCount`
- `environmentHash` — sliced SHA-256 of `EnvManifest` config fields
- `environment` — full `EnvManifest` (see `env-manifest.ts`)
- `reportFile` — relative path to the full report under the same dir

Use `listArchiveManifests()` (programmatic) or `ls data/bench-archive/*.manifest.json`
(shell) to browse.

## Comparing two runs

```bash
tsx scripts/eval/bench-compare.ts <left-ref> <right-ref>
```

`<ref>` resolves in order:

1. Direct file path (relative or absolute)
2. Archive base name (e.g. `df80cc20-2026-05-22T13-45-00`)
3. Git-sha prefix — picks the LATEST archive whose `gitSha` starts with the
   prefix (handy for "compare HEAD to last main")

The CLI runs a paired bootstrap (`scripts/eval/significance.ts`) on the
per-scenario `overall` scores, then prints:

- aggregate left/right/Δpp and the 95% bootstrap CI on Δ
- a per-scenario sorted table (regressions first)
- exit `2` when:
  - `Δpp < -threshold-pp` (default 2.0pp)
  - AND the bootstrap CI upper bound is also below `-threshold-pp`

Flags:

- `--threshold-pp 2.0` — regression bar (default 2.0)
- `--json out.json` — also write structured JSON output
- `--max-rows 30` — limit per-scenario table width

## Cleaning up

Archives are append-only on the runner side. Nuke the directory between
infrastructure rewrites (e.g. when a model swap invalidates older runs):

```bash
rm -rf data/bench-archive/
```

Or selectively, oldest first:

```bash
ls -t data/bench-archive/*.json | tail -n +51 | xargs rm
```

## Interpreting a comparison

- **Aggregate Δ +1pp / p=0.34 / no overall regression** — usually noise.
  Check per-scenario table for big swings; small overall masking individual
  regressions is the common foot-gun.
- **Aggregate Δ -2.5pp / CI upper -0.8pp / regression** — real. Re-run with
  the same seed before reverting, but treat as a real signal.
- **Aggregate Δ -3pp / CI upper +0.5pp / no regression** — high variance.
  Investigate the per-scenario rows; a single critical-failure can swing
  geo-mean dramatically.
- **n < 30 paired scenarios** — bootstrap p-values are unreliable. Stick to
  the per-scenario diff and treat overall delta with caution.
