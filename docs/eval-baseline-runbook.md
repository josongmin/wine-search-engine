# Eval Baseline Runbook

This runbook defines how we refresh and validate the lightweight regression baselines that protect PR and nightly quality lanes.

## Baselines

- Offline smoke baseline: [`/Users/songmin/wine-search-engine/data/eval-baselines/offline-smoke-v1.json`](/Users/songmin/wine-search-engine/data/eval-baselines/offline-smoke-v1.json)
- Noisy entity smoke baseline: [`/Users/songmin/wine-search-engine/data/eval-baselines/noisy-entity-smoke-v1.json`](/Users/songmin/wine-search-engine/data/eval-baselines/noisy-entity-smoke-v1.json)
- Baseline manifest: [`/Users/songmin/wine-search-engine/data/eval-baselines/manifest.json`](/Users/songmin/wine-search-engine/data/eval-baselines/manifest.json)

## When To Refresh

- Refresh only after a stable green run that reflects an intentional quality improvement.
- Do not refresh to hide a regression or flaky behavior.
- Refresh in the same PR that changes retrieval, ranking, resolver, or query-planning behavior.

## Offline Smoke Workflow

1. Run `npm run eval:offline:smoke:assert-baseline`.
2. Review the output in `/tmp/offline-eval-smoke-results.json`.
3. If the new metrics are intentionally better and stable, run `npm run eval:offline:smoke:refresh-baseline`.
4. Re-run `npm run eval:offline:smoke:assert-baseline` and confirm it passes.

The smoke dataset lives at [`/Users/songmin/wine-search-engine/data/eval-smoke-queries.jsonl`](/Users/songmin/wine-search-engine/data/eval-smoke-queries.jsonl). It should stay small, deterministic, and fixture-backed.

## Noisy Benchmark Workflow

1. Run `npm run eval:noisy:assert-baseline`.
2. If the improvement is intentional and stable, run `npm run eval:noisy:refresh-baseline`.
3. Re-run `npm run eval:noisy:assert-baseline` and confirm it passes.

## Review Checklist

- `wrong_top1_rate` does not increase.
- `ndcg_at_10`, `mrr_at_10`, and `recall_at_3` do not regress past thresholds.
- Slice regressions are checked for `by_scenario`, `by_language`, and `by_mode`.
- The baseline update is mentioned in the PR summary.
