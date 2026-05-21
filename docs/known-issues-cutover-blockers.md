# Known Issues — In-Memory E2E Failures (Cutover Triage)

Snapshot of the `config/vitest/e2e.config.ts` lane: **14 failed / 514 passed (528)**.

**Headline finding:** none of the 14 failures are in the `/v1/wine-search`
Plan-then-Execute cutover path. Every failure is in the legacy `/v1/agent`,
`/v1/search`, or `/v1/search/interpret` surface — areas governed by the
parallel `feat(calibration)` (AURC-derived per-class refusal thresholds),
`feat(alias)` (double-metaphone phonetic encoder), and planner/interpret-shape
commits, NOT by the wine-search orchestrator work. The wine-search lane is
green: 321 hell e2e + 333 core tests pass.

## Triage table

| # | Test | Surface | Category | Root-cause hypothesis | Severity | Owner |
|---|------|---------|----------|-----------------------|----------|-------|
| 1 | V1 routes — `/v1/search/interpret` still returns V1 interpret shape | interpret | (c) pre-existing/parallel | Interpret response shape changed (planner/v2-routes commit). Not wine-search. | med | search team |
| 2 | `/v1/agent` Tier 1 — direct answer (out of domain) | legacy agent | (c) calibration | AURC threshold shift changed out-of-domain decision. Legacy path. | low | calibration |
| 3 | `/v1/agent` Tier 3 — max steps enforcement → terminates at limit | legacy agent | (c) test-design | `tool_call_count` > 5: ScriptedChatLlm supplies 6 tool-call responses and **no synthesis response** → post-loop synthesis fails → answer-recovery fallback search runs → count = 5 (loop) + 1 (recovery) = 6. StepBudget itself caps correctly (verified by direct probe: near-dup rejects call 2). Not a wine-search regression; our Fix 1/2/3 do not touch step counting or fallback recovery. | low | legacy agent |
| 4 | `/v1/search/interpret` returns QueryPlanV1 shape | interpret | (c) parallel | Same shape change as #1. | med | search team |
| 5 | `/v1/search/interpret` accepts snake_case aliases | interpret | (c) parallel | Same. | med | search team |
| 6 | Realistic — alias 'romanee conti' keeps romanee-conti-2019 in top-5 | resolver/alias | (c) alias commit | `feat(alias): double-metaphone` re-ranking dropped romanee-conti below top-5 / scored ambiguous (C=0.05 < T_resolve). Confidence threshold interaction. | med | alias/calibration |
| 7 | Benchmark #88 — concrete recommendation without clarification | decision | (c) calibration | AURC threshold now classifies #88 as `ambiguous` (clarify) instead of `resolved`. Gate trace: C below T_resolve. | med | calibration |
| 8 | Interpret edge — Korean mixed query rawQuery preserved | interpret | (c) parallel | Interpret-layer Korean preservation. Not wine-search. | low | search team |
| 9 | Interpret edge — plannerVersion semver-like | interpret | (c) parallel | Planner version string format. | low | search team |
| 10 | Korean entity resolution — '오푸스원' normalizedQuery preserves Korean | interpret/alias | (c) alias commit | Alias normalization for Korean. | low | alias |
| 11 | Mixed search E2E — "마고 비슷한 레드" returns results | search | (c) parallel | Mixed similarity search path. | low | search team |
| 12 | Unicode — latin prefix 'opu' resolves through `/v1/search` | resolver | (c) alias/calibration | Prefix resolution confidence. | low | alias |
| 13 | Envelope — unknown query zzz_…_9999 still 200 | search | (c) parallel | Unknown-query envelope shape. | low | search team |
| 14 | Envelope — unknown query zzz_no_match still 200 | search | (c) parallel | Same. | low | search team |

## Category legend

- **(a) our-change** — caused by this session's wine-search work. **Count: 0.**
- **(b) user-WIP** — uncommitted working-tree changes. **Count: 0** (working tree clean except 3 unrelated infra files).
- **(c) pre-existing / parallel-commit** — attributable to the `feat(calibration)`,
  `feat(alias)`, and planner/interpret commits that landed alongside the
  wine-search work. **Count: 14.**

## Evidence basis

- `git log` shows `feat(calibration): AURC-derived per-class refusal threshold`,
  `feat(calibration): nightly auto-pipeline`, and `feat(alias): double-metaphone
  phonetic encoder` as recent commits — none are wine-search.
- Decision-engine gate-trace logs in the failing runs show calibration-driven
  refusals: `C=0.05 < T_resolve=0.45` / `T_resolve=0.65`, rules
  `NUMERIC_GATE_LOW_CONFIDENCE`, `FALLBACK_HYBRID_SEARCH`, `CLARIFICATION_BIAS`.
- None of the 4 failing test files (`agent-api`, `realistic-scenarios`,
  `v2-routes.contract`, `search-api.secondary`) reference `wine-search` /
  `wineSearch` (grep confirmed empty).
- StepBudget near-duplicate capping verified correct by direct probe.

## Cutover gating recommendation

These 14 failures **do not block the `/v1/wine-search` cutover** — the new path
is isolated behind `WINE_SEARCH_ENABLED` and its full test surface is green.
They DO indicate the calibration/alias re-ranking changes shifted decision
boundaries on the legacy `/v1/search` + `/v1/agent` surfaces; the search /
calibration owners should review whether the new thresholds are intended (the
benchmark expectations may simply need re-baselining against the AURC change).
