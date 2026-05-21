# Runbook — Wine Search Orchestrator Cutover

The `/v1/wine-search` Plan-then-Execute orchestrator runs behind the
`WINE_SEARCH_ENABLED` feature flag, in strangler-fig coexistence with the
legacy `/v1/agent` ReAct orchestrator. This runbook covers the staging
validation that MUST pass before the flag is flipped in production.

## Pre-flight checklist

| Requirement | Why | How to verify |
|-------------|-----|---------------|
| `WINE_SEARCH_ENABLED=true` | The container only builds the `wineSearch` slice when the flag is on. | `echo $WINE_SEARCH_ENABLED` |
| `ANTHROPIC_API_KEY` set | The structured-LLM adapter and the analyzer/synthesizer phases call Anthropic. Container build throws without it. | `test -n "$ANTHROPIC_API_KEY"` |
| `AGENT_ENABLED=true` + OpenAI credential | The shadow bench compares against the legacy orchestrator, which must be wired. | container builds `agentOrchestrator` |
| Vespa reachable | Real retrieval is exercised end-to-end (no mocks in composition-root mode). | health-check the configured Vespa endpoint |
| Anthropic quota headroom | A 50-scenario run issues 2–5 Claude calls per scenario per orchestrator. | check the Anthropic console rate/spend limits |

The shadow-mode driver (`src/application/wine-search/shadow-mode-driver.ts`)
enforces the first three gates and throws an operator-facing, single-line
error if any is unmet — it short-circuits BEFORE the heavyweight container
build so a misconfigured machine fails fast.

## Step 1 — Shadow-mode bench validation (staging)

Run the real composition-root against the benchmark scenarios with scoring on:

```bash
WINE_SEARCH_ENABLED=true \
ANTHROPIC_API_KEY=sk-ant-... \
AGENT_ENABLED=true \
pnpm exec tsx scripts/wine-search/run-shadow-mode-bench.ts \
  --composition-root \
  --score \
  --limit 50 \
  --summary-output ./artifacts/shadow-summary.json \
  --regressed-rate-ceiling 5 \
  --pass-threshold-percent 80 \
  --output ./artifacts/shadow-bench.jsonl
```

The CLI runs each scenario through BOTH orchestrators in parallel, scores both
with the real bench scorer (`test/benchmark/agent/scorer.ts`), and emits a
per-scenario `ShadowModeScoringReport`.

### Pass criteria

The run exits `0` only when BOTH hold:

- **Parity rate** ≥ `--pass-threshold-percent` (default 80%): the share of
  scenarios where the new orchestrator's answer is semantically equivalent
  (token-set Jaccard ≥ threshold), same tool set, same termination reason.
- **Regressed rate** ≤ `--regressed-rate-ceiling` (default 5%): the share of
  scenarios where any scorer dimension dropped past the regression threshold.

Inspect `./artifacts/shadow-summary.json` for the per-dimension delta means
(`executionEfficiency`, `answerQuality`, `terminationCorrectness`,
`costEfficiency`, `faithfulness`, `contextRelevance`, `contextRecall`, `judge`)
and the top regressions list.

A non-zero exit means **do not cut over** — triage the regressed scenarios
first.

## Step 2 — Flip the flag (production)

Only after Step 1 passes on staging:

```bash
export WINE_SEARCH_ENABLED=true   # exact lowercase "true"
# restart the process — the flag is read once at composition-root boot
```

`POST /v1/wine-search` goes live. `/v1/agent` continues serving unchanged
(strangler-fig coexistence).

## Rollback

Instant, zero residual cost on the legacy path:

```bash
unset WINE_SEARCH_ENABLED   # or set to anything other than "true"
# restart the process
```

The `wineSearch` container slice is no longer built; the route is no longer
registered. Existing `/v1/agent` traffic is unaffected.

## Notes

- `--dry-run` substitutes deterministic in-memory orchestrators (no live
  backends) for fast smoke testing of the harness itself. It is mutually
  exclusive with `--composition-root`.
- The driver shuts down PG / Redis / telemetry handles deterministically after
  the run via `driver.shutdown()`; the CLI calls it in a `finally`.
