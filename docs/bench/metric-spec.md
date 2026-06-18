# Agent benchmark metric specification

> Historical/dormant note: this document preserves the metric contract for the
> scorer and any future live agent-runner restoration. The current repo-native
> executable lane is `pnpm run bench:smoke`; `test/benchmark/agent/runner.ts`
> is absent in this checkout. See `docs/bench/STATUS.md`.

SOTA++ reliability foundation for the agent benchmark. Every numeric aggregate published in `BenchmarkReport.summary` is enumerated below: definition, formula, input domain, edge cases, and rationale. The companion contract test at
`test/regression/benchmark-metric-contract.regression.test.ts` asserts each entry against hand-crafted fixtures so any future refactor that silently drops a metric (e.g. the `meanHardConstraints = 0 // TODO` regression that lived for sessions) is caught at PR time.

This document is **append-only** for aggregates. Removing one requires removing the corresponding fixture entry AND updating the contract test.

## Scope

Bench layer files this spec governs:
- `test/benchmark/agent/scorer.ts` — per-scenario scoring + `weightedGeometricMean`, `aggregateGeoMean`, `aggregateTrimmedGeoMean`.
- `test/benchmark/agent/scorer-aggregation.ts` — run-level numeric aggregation helpers.
- `test/benchmark/agent/benchmark-insight-generator.ts` — threshold-driven insight rules.
- `test/benchmark/agent/constants.ts` — single source of truth for named thresholds (see §"Constants").

The provenance map (`summary.provenance: Record<string, MetricProvenance>`) is the runtime mirror of this document.

---

## A1 — Per-scenario score dimensions

Each scenario produces a `ScenarioScores` object. Dimensions are independent except where noted; null dimensions are excluded from the geo-mean via "null-drop" (no imputation).

### overall
- **Definition** Weighted geometric mean of the present (non-null) dimensions, after applying `DIMENSION_FLOOR=0.05` to noisy secondary dims (faithfulness/contextRelevance/contextRecall/judge) but NOT to primary dims (executionEfficiency/terminationCorrectness/answerQuality/costEfficiency).
- **Formula** `exp( Σᵢ wᵢ · log(xᵢ + ε) / Σᵢ wᵢ )` where ε=1e-6 prevents `log(0) = -∞`. Critical-failure short-circuit: any diagnostic with `severity='critical'` collapses overall to `0`.
- **Input domain** All present `xᵢ ∈ [0, 1]`; weights sum to 1.0 after `renormaliseWeights`.
- **Edge cases** (a) All dims null → 0 (degenerate). (b) `critical=true` → 0 regardless. (c) Float rounding artefact `>1.0` → clamped by `clamp01`.
- **Rationale** Geo-mean punishes worst dimension heavier than arithmetic mean — a "good on everything except faithfulness" agent should not pass.

### executionEfficiency
- **Definition** `toolAccuracy × EXEC_TOOL_WEIGHT + stepEfficiency × EXEC_STEP_WEIGHT` (= 0.6/0.4 split).
- **Edge cases** Step-0 fallback (LLM unavailable) → toolAccuracy=1 (infra failure, not agent failure).

### answerQuality
- **Definition** Multiplicative product of substring-contract matches, regex-must-match hits, structured-check multipliers, exact-lookup multiplier. Final value clamped to [0,1].
- **Critical-fail triggers** (force overall→0): `answerExcludes` violated; empty answer.
- **Soft-penalty triggers** (multiplied in): `answerMustMatch` miss → `PENALTY_REGEX_MISS=0.5`; `answerMustNotMatch` hit → `PENALTY_MUST_NOT_MATCH=0.50`.

### terminationCorrectness
- **Values** 1 (expected reason matched), 0 (hard fail / unexpected blocked), `TERMINATION_FALLBACK_PARTIAL_CREDIT=0.25` (fallback termination — graceful degradation partial credit).
- **Rationale for 0.25** A fallback is a real degradation signal but not a hard failure — the agent produced *something*. 75% dock proportional to the loss of intent.

### costEfficiency
- **Definition** `max(0, 1 − max(durOvershoot, tokOvershoot))` where each overshoot = `(actual − budget) / budget`.
- **Defaults** `DEFAULT_MAX_DURATION_MS=25_000`, `DEFAULT_MAX_TOTAL_TOKENS=12_000`.
- **Rationale** Max-overshoot (not sum/product) so a 2× latency overshoot with perfect tokens scores 0, not `sqrt(0×1)=0` — fairer to single-axis failures.

### faithfulness, contextRelevance, contextRecall (RAGAS triad)
- **Definitions** Standard RAGAS metrics adapted for tool-call observations. See `scorer.ts` `scoreContextRelevance` / `scoreContextRecall` for the structured-evidence path.
- **Null semantics** Null when no observations or no scenario ground truth — excluded from geo-mean.

### judge
- **Definition** LLM-as-judge score 0..1; null when disabled (`--no-judge` mode).
- **Sample count** `JUDGE_DEFAULT_SAMPLES=3` median; `JUDGE_REQUIRED_SAMPLES=5` for `judgeRequired=true` scenarios.

### scrHard, scrSoft, scrInferred, semanticConstraintRecall
- **Definition** Per-bucket recall of expected constraints from `runConstraintExtraction(query).bundle`. See `constraint-metrics.ts`.

### csrHard, csrSoft, csrInferred, csrOverall
- **Definition** Constraint Satisfaction Rate — fraction of extracted constraints satisfied by tool-result observations.

### entityLinkingAccuracy
- **Definition** ELA@1 against `scenario.expectation.expectedEntities`.

### slotF1Strict, slotF1Relaxed
- **Definition** Entity-level F1 against expected constraints.

### exactLookupHit, failClosedAccuracy
- **Definition** Transliteration / fail-closed exact-lookup contract checks. Excluded from overall.

### extractedHardConstraintCount
- **Definition** `runConstraintExtraction(query).bundle.hard.length` for this scenario.
- **Aggregation** Run-level `summary.meanHardConstraints` averages these (null-safe).
- **Reliability history** Was previously **not threaded through**; the run-level aggregate was hardcoded `0` with a TODO comment, corrupting every `hard_constraints_low` insight that fired. The contract test fixtures include a scenario with a known non-zero count to ensure this never regresses again.

---

## A2 — Run-level aggregates

### overallScore (= overallScoreGeoMean)
- **Definition** Arithmetic mean of per-scenario `scores.overall` over `executedForAggregate` (excludes judgeRequired scenarios in `--no-judge` mode).
- **Formula** `(Σᵢ overallᵢ) / N`.
- **Stability note** The legacy name `overallScore` is preserved for baseline JSON compat — never drop it. The explicit alias `overallScoreGeoMean` exists so the contract test can assert provenance against a stable key.

### overallScoreGeoMean
- **Definition** Geometric mean of per-scenario `scores.overall` over `executedForAggregate`.
- **Formula** `exp( Σᵢ log(max(overallᵢ, ε)) / N )` with ε=1e-6.
- **Why publish a geo-mean alongside the arithmetic** Critical failures (overall=0) collapse the geo-mean — a discrete pass/fail signal for "is anything totally broken?" Arithmetic mean smooths these.

### overallScoreTrimmedGeoMean5
- **Definition** 5%-trimmed geometric mean. Sort ascending, drop `⌊0.05 × N⌋` values from each tail, geo-mean the survivors.
- **Edge cases** (a) `N < ⌈1/0.05⌉ = 20` → trim window = 0 → falls back to raw geo-mean. (b) Symmetric trim that empties the survivor set → falls back to raw.
- **Rationale** Heavy-left-tail distributions (critical failures dominate) over-report agent regression severity in the raw geo-mean. The trimmed value is the more honest "underlying agent quality" signal. **Critical failures STAY counted** via the discrete `criticalFailureCount` field — trimming does NOT squelch the security signal, it merely separates the two.
- **Insight rule** `trimmed_vs_raw_gap` fires when `trimmed − raw > TRIMMED_VS_RAW_INSIGHT_DELTA (=0.03)`. The bottom 5% are dragging the headline number; fixing them moves the metric.
- **Provenance** `aggregateName='overallScoreTrimmedGeoMean5'`, `sourceField='scores.overall'`, `derivationSummary='5%-trimmed geometric mean...'`.

### overallCi95, overallBootstrapCi95
- **Definition** 95% confidence interval for the mean. Student-t for `overallCi95`, bootstrap (B=2000 resamples) for `overallBootstrapCi95`.
- **Bootstrap geo-mean** Inside each resample, compute the geo-mean (not the arithmetic mean) — this matches `overallScoreGeoMean`.

### dimension means (executionEfficiency, toolAccuracy, ..., judge)
- **Definition** Arithmetic mean over `executedForAggregate`. RAGAS triad + judge use null-drop: only non-null per-scenario values contribute.
- **Why arithmetic, not geo** Per-dim agg is the diagnostic surface; the geo-mean penalty already lives inside per-scenario overall. Compounding it at the run level would obscure root-cause.

### claim-level aggregates (claimFaithfulness, …, claimHardFailCount)
- **Definition** Null-safe arithmetic means over the subset of scenarios that received RFC-020 claim-level evaluation.

### latencyMs (mean, p50, p95, p99, max)
- **Definition** Standard summary statistics over per-scenario `totalDurationMs`.
- **Reliability history** The `latency_p95_fail` SLA gate was previously using `totalDurationMs` which conflates LLM-provider throttle with agent quality — the L1.A fix switched it to `agentWorkMs` upstream. This bench layer continues to publish `totalDurationMs` as the user-visible latency; the SLA gate consumes the upstream-cleaned signal.

### latencySla
- **Definition** `{ p50Pass: latencyMs.p50 < LATENCY_SLA_P50_MS, p95Pass: latencyMs.p95 < LATENCY_SLA_P95_MS, timeoutCount: count(totalDurationMs > LATENCY_SLA_TIMEOUT_MS) }`.

### tokens (inputMean, outputMean, totalP95)
- **Definition** `inputMean`/`outputMean` arithmetic means over executed; `totalP95` = p95 of `(input+output)`.

### byTier
- **Definition** Per-tier `{ count, avgScore }` where `avgScore` = arithmetic mean of `scores.overall` within tier.

### evidenceFrameCoverage, evidenceFrameCounts
- **Definition** `framedToolCalls / totalToolCalls` over executed scenarios; null when no tool calls.
- **Cutover gate** ADR-009 Phase 0 requires ≥0.99 on two consecutive nightly runs.

### meanHardConstraints
- **Definition** Arithmetic mean over `executedForAggregate` of non-null `scores.extractedHardConstraintCount`.
- **Domain** ≥0; typical healthy bench run produces 2–4 per query.
- **Reliability history** Was hardcoded `0` with a TODO for sessions, silently triggering every `hard_constraints_low` warning regardless of real retrieval filtering depth. The fix threads `runConstraintExtraction(query).bundle.hard.length` through `ConstraintExtractionMetricsInput` → `ScenarioScores.extractedHardConstraintCount` → run-level aggregate. Contract test fixture includes a scenario with known `extractedHardConstraintCount=3` to prevent regression.
- **Null semantics** Null when no scenarios had constraint extraction (no `expectedConstraints` / `expectedEntities` on any scenario in the run). Insight rules `hard_constraints_low` / `hard_constraints_good` now require non-null before firing.

### provenance
- **Definition** `Record<aggregateName, MetricProvenance>` — every numeric aggregate above has an entry tracing it back to a `ScenarioScores` / `ScenarioExecution` field plus a one-line derivation formula.
- **Contract** `test/regression/scorer-no-hardcoded-aggregate.regression.test.ts` walks the `BenchmarkReport.summary` shape and asserts:
  1. Every numeric summary field has a `provenance[<name>]` entry.
  2. `derivationSummary` MUST NOT contain the substring `'TODO'` — the silent-hardcode trap.
  3. `sourceField` either references a real `ScenarioScores` / `ScenarioExecution` field via dot notation OR equals a documented magic string (`'__scenario_count__'` for cardinality counters, `'totalDurationMs'` for latency aggregates, `'totalTokens'` for token aggregates).

---

## A3 — Constants (named thresholds)

All thresholds live in `test/benchmark/agent/constants.ts` (SSoT). Each export carries a `@domainJustification` comment explaining its value. The contract test imports the same symbols, ensuring tests and runtime cannot drift.

Categories:
- **Latency SLA**: `LATENCY_SLA_P50_MS`, `LATENCY_SLA_P95_MS`, `LATENCY_SLA_TIMEOUT_MS`.
- **Termination partial credit**: `TERMINATION_FALLBACK_PARTIAL_CREDIT` (0.25).
- **Trimmed geo-mean**: `TRIMMED_GEOMEAN_PROPORTION` (0.05), `TRIMMED_VS_RAW_INSIGHT_DELTA` (0.03).
- **Quality bands** (insight rules): `INSIGHT_OVERALL_GOOD/WARN`, `INSIGHT_FAITHFULNESS_GOOD/WARN`, `INSIGHT_CONTEXT_RELEVANCE_GOOD/WARN`, `INSIGHT_JUDGE_GOOD/WARN`, `INSIGHT_ELA1_GOOD/WARN`, `INSIGHT_SCR_OVERALL_GOOD/WARN`, `INSIGHT_SCR_INFERRED_LOWER_BOUND`, `INSIGHT_SLOT_F1_GOOD/WARN`, `INSIGHT_TIER6_GOOD/WARN`, `INSIGHT_MEAN_HARD_CONSTRAINTS_GOOD/WARN`.
- **Sample-size gates**: `MIN_ANNOTATION_SAMPLES` (10), `MIN_SCENARIOS_FOR_VARIANCE` (5).
- **Judge sampling**: `JUDGE_DEFAULT_SAMPLES` (3), `JUDGE_REQUIRED_SAMPLES` (5).
- **Per-scenario warnings**: `FAITHFULNESS_PER_SCENARIO_WARN` (0.5).
- **Penalty multipliers**: `PENALTY_EXTRA_TOOL_PER_CALL` (0.1), `PENALTY_EXTRA_TOOL_CAP` (0.5), `PENALTY_TOOL_DUPLICATE` (0.7), `PENALTY_TOOL_ORDER_VIOLATION` (0.5), `EXEC_TOOL_WEIGHT` (0.6), `EXEC_STEP_WEIGHT` (0.4).

To add a new threshold:
1. Add the `export const` to `constants.ts` with a `@domainJustification` JSDoc tag.
2. Reference it from the consumer (`scorer.ts` / `runner.ts` / `benchmark-insight-generator.ts`) — no inline literal.
3. If it affects a published aggregate, add a fixture row in `__tests__/metric-contract-fixtures.ndjson` and document the metric here.

---

## A4 — Fixture matrix (boundary cases)

The contract test fixture file `test/benchmark/agent/__tests__/metric-contract-fixtures.ndjson` defines 10 hand-crafted scenarios that exercise every dimension at known boundary values:

| ID | Scenario name | Key assertions |
| -: | :--- | :--- |
| 1 | `perfect_happy_path` | `overall=1.0`, all dims = 1.0, no diagnostics |
| 2 | `critical_failure_excludes` | `answerExcludes` violated → `criticalFailure=true`, `overall=0` |
| 3 | `fallback_termination_partial_credit` | term reason `fallback` → `terminationCorrectness=TERMINATION_FALLBACK_PARTIAL_CREDIT` |
| 4 | `extra_tool_penalty_uncapped` | 2 extra tools → tool accuracy ≈ 0.8 (capped at 50% off) |
| 5 | `extra_tool_penalty_capped` | 8 extra tools → tool accuracy hits `PENALTY_EXTRA_TOOL_CAP` floor |
| 6 | `null_drop_no_judge` | `judge=null` → dropped from geo-mean (not imputed at 0.5) |
| 7 | `hard_constraint_count_threaded` | `extractedHardConstraintCount=3` survives end-to-end (catches the `meanHardConstraints=0 // TODO` regression) |
| 8 | `single_outlier_critical_fail` | 1 critical-fail among 9 healthy → trimmed-geo-mean ≠ raw-geo-mean by ≥3pp |
| 9 | `all_zero_scores` | All scenarios 0 → both raw and trimmed = 0, no NaN |
| 10 | `mixed_boundary_check` | Mixed 0/0.5/1 → asserts trimmed-vs-raw insight rule fires |

Each fixture row in NDJSON encodes:
- A minimal `AgentBenchmarkScenario` (id, tier, query, expectation).
- A minimal `ScenarioExecution` (answer, stepCount, toolsUsed, observations, terminationReason, durations, tokens).
- Optional `judgeScore`, `faithfulnessScore`, `constraintMetrics`.
- The **expected** per-dimension values + the expected aggregate values when this fixture is the only scenario in a synthetic run.

---

## A5 — Insight rules (`benchmark-insight-generator.ts`)

Threshold-driven rules that flag run-level patterns. All thresholds bound to `constants.ts`. Severity emojis: 🔴 critical, 🟡 warn, 🟢 good, ℹ️ info.

| Rule ID | Severity | Trigger |
| :--- | :--- | :--- |
| `overall_critical` | 🔴 | `overallScore < INSIGHT_OVERALL_WARN` |
| `overall_good` | 🟢 | `overallScore >= INSIGHT_OVERALL_GOOD` |
| `critical_failures` | 🔴 | `criticalFailureCount > 0` |
| `faithful_low` | 🔴 | `faithfulness !== null && faithfulness < INSIGHT_FAITHFULNESS_WARN` |
| `faithful_good` | 🟢 | `faithfulness !== null && faithfulness >= INSIGHT_FAITHFULNESS_GOOD` |
| `ela_near_target` | 🟡 | `entityLinkingAccuracy ∈ [INSIGHT_ELA1_WARN, INSIGHT_ELA1_GOOD)` |
| `ela_achieved` | 🟢 | `entityLinkingAccuracy >= INSIGHT_ELA1_GOOD` |
| `scr_inferred_low` | 🔴 | `scrInferred < INSIGHT_SCR_INFERRED_LOWER_BOUND` |
| `scr_annotation_sparse` | 🟡 | `constraintEvaluatedCount < MIN_ANNOTATION_SAMPLES` |
| `tier6_high` | 🟡 | `tier6SoleExtractionRate > INSIGHT_TIER6_WARN` |
| `latency_p95_fail` | 🔴 | `latencyP95Ms > LATENCY_SLA_P95_MS` |
| `judge_variance` | 🟡 | `worstScenarios.length >= MIN_SCENARIOS_FOR_VARIANCE && judgeZeros >= 2` |
| `hard_constraints_low` | 🟡 | `meanHardConstraints !== null && meanHardConstraints < INSIGHT_MEAN_HARD_CONSTRAINTS_WARN` |
| `hard_constraints_good` | 🟢 | `meanHardConstraints !== null && meanHardConstraints >= INSIGHT_MEAN_HARD_CONSTRAINTS_GOOD` |
| `trimmed_vs_raw_gap` | 🟡 | `overallScoreTrimmedGeoMean5 − overallScoreGeoMean > TRIMMED_VS_RAW_INSIGHT_DELTA` |

---

## A6 — Provenance audit checklist

Before merging any PR that touches the live report builder (`runner.ts` when restored):

1. **New aggregate?** Add (a) the field to `BenchmarkReport.summary`, (b) a `MetricProvenance` entry in `buildSummaryProvenance()`, (c) a row in §A2 above, (d) a fixture column if the value is testable without an LLM.
2. **Hardcoded `0`, `null`, or TODO?** STOP. The contract test will fail on `'TODO'` in the derivation summary. If you genuinely need a placeholder, gate the field as `number | null` and return `null` — never a stubbed `0`.
3. **Refactored a per-scenario field?** Update `sourceField` in the corresponding provenance entry. The contract test asserts dot-path validity.
