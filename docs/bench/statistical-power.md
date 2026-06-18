# Agent benchmark — statistical power planning

> Historical/dormant note: this planning flow assumes a materialized live agent
> benchmark baseline report. The current repo-native runner is absent, so this
> doc is not a current executable lane by itself. See `docs/bench/STATUS.md`.

## Why this exists

Single-run agent benchmark deltas oscillated 5–6 pp across consecutive
sessions (69.8 → 63.6 → 72.7 → 69.5 → 73.9%) before SOTA++ B1/B2/B3 landed.
That noise dominates the kind of lift we ship per change — a real +2 pp lift
is statistically indistinguishable from "judge variance + LLM stochasticity"
under a single-sample design. Power analysis tells us, for the current
scenario set and observed σ, the **minimum Δ pp that the bench can actually
resolve** at α=0.05 and power 0.8.

## What the helper computes

`scripts/eval/bench-statistical-power.ts` reads a baseline benchmark report,
estimates the per-scenario score sd `σ`, scales it by √2 to bound the paired
delta sd (`σ_Δ ≤ √2 · σ`), and computes the required scenario count for
each requested Δ via the standard paired sample-size formula:

```
n = ((z_{α/2} + z_{β}) · σ_Δ / Δ)²
```

For two-sided α=0.05 and power 0.8: `z_{0.025}=1.96`, `z_{0.20}=0.8416`.

## Usage

```bash
# Text table — defaults to Δ ∈ {1, 2, 3, 5} pp at power 0.8.
pnpm exec tsx scripts/eval/bench-statistical-power.ts \
  --baseline test/benchmark/agent/results/baseline.json

# Custom Δ values (decimal fractions, not percent: 0.02 = 2pp).
pnpm exec tsx scripts/eval/bench-statistical-power.ts \
  --baseline test/benchmark/agent/results/baseline.json \
  --deltas 0.015,0.03

# Both power 0.8 and 0.9.
pnpm exec tsx scripts/eval/bench-statistical-power.ts \
  --baseline test/benchmark/agent/results/baseline.json \
  --powers 0.8,0.9

# Machine-readable JSON for nightly logging.
pnpm exec tsx scripts/eval/bench-statistical-power.ts \
  --baseline test/benchmark/agent/results/baseline.json \
  --json
```

## Interpreting the table

Each row reports, for one (Δ, power) cell:

- `n required` — minimum scenario count given the observed σ.
- `n available` — scenarios in the supplied baseline.
- `sufficient?` — whether the available set is large enough to resolve that Δ.

A row marked `no` does **not** mean the lift is undetectable in practice — it
means the bench cannot statistically guarantee detection at the requested
power. Mitigations:

- Increase scenario count (expand `AGENT_SCENARIOS` or use a larger profile).
- Increase `--runs N` (multi-sample) — this tightens σ_Δ by averaging out
  per-run stochasticity, often the largest single variance source.
- Accept a coarser Δ as the "smallest lift we ship".

## Wiring into CI

The nightly profile (`--profile nightly`) defaults to `--runs 3`, which
combines with this helper:

1. Nightly bench writes `test/benchmark/agent/results/<run>.json` (paired
   bootstrap headline + variance decomposition).
2. CI runs `bench-statistical-power.ts --json` against the latest baseline
   and logs the table — drift in `n required` over time is a leading
   indicator that scenario coverage has grown noisier.
3. When a Δ row flips from `YES` to `no`, that's a signal to either expand
   scenarios or revisit the variance decomposition for the dominant noise
   source.

## Math notes

- `σ_Δ ≤ √2 · σ` assumes baseline and current are independent. In reality
  they are positively correlated (same agent, same scenarios, just different
  noise draws), so the true `σ_Δ` is smaller — making the `n required`
  estimate conservative (we over-provision rather than under-).
- The formula assumes normality of per-scenario deltas. For long-tailed
  agent score distributions, the paired bootstrap in
  `test/benchmark/agent/statistical-compare.ts` is the right inference tool;
  this power helper is for **planning**, not significance testing.
- For non-standard power values, the helper falls back to z_{0.20}=0.8416
  and emits a warning to stderr.
