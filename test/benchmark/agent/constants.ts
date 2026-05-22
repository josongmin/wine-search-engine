/**
 * Agent benchmark — named constants (SSoT for thresholds, penalties, SLA gates).
 *
 * SOTA++ reliability foundation. Every numeric value used as a threshold, penalty,
 * partial-credit factor, or SLA gate by the bench layer (scorer.ts,
 * benchmark-insight-generator.ts, runner.ts) MUST be defined here with an inline
 * justification comment. Magic numbers in scoring code are unauditable
 * (CLAUDE.md rule 15) and have been the proximate cause of multiple latent bugs
 * (see metric-spec.md §"Provenance audit").
 *
 * Why this module exists (post-meta-evaluation):
 *  - `meanHardConstraints` hardcoded `0` with a TODO went undetected for sessions.
 *  - `latency_p95_fail` SLA gate confused wall-clock with agent quality.
 *  - terminationReason mapping silently bypassed `'answer'` → term=0.25 partial credit.
 * Centralising values + assigning each a docstring + provenance lets the contract
 * test (test/regression/benchmark-metric-contract.regression.test.ts) catch any
 * future drift.
 *
 * RULES for adding to this file:
 *  1. Every export carries an `@domainJustification` JSDoc tag explaining WHY the
 *     value was chosen (RFC, real-world measurement, user-perceived threshold).
 *  2. Test fixtures referring to these constants import the symbol — do NOT inline
 *     duplicate the value in tests (rule 30: shared constants must not drift).
 *  3. If a constant is later moved into scorer.ts as a private helper, leave a
 *     re-export here so the contract test still asserts against a single value.
 */

// ─────────────────────────────────────────────────────────────────────
// SLA / latency gates — runner.ts + benchmark-insight-generator.ts
// ─────────────────────────────────────────────────────────────────────

/**
 * Latency p50 SLA threshold (ms).
 * @domainJustification "User starts wondering if it's broken" UX threshold for
 *   conversational agents is ~10s p50. Empirical p50 on a healthy real-mode run
 *   sits ~6-8s on gpt-5.4-mini; 10s gives ~25% headroom for transient latency
 *   noise without masking regressions.
 */
export const LATENCY_SLA_P50_MS = 10_000;

/**
 * Latency p95 SLA threshold (ms).
 * @domainJustification p95 of healthy real-mode runs is ~16-18s for complex
 *   nested-comparison scenarios. 20s catches genuine pipeline stalls (Vespa
 *   timeout, retrieval lane backoff) while accommodating the long-tail
 *   comparison_nested + extreme tiers.
 */
export const LATENCY_SLA_P95_MS = 20_000;

/**
 * Individual scenario hard timeout (ms) — SLA violation count threshold.
 * @domainJustification Above 30s, even patient users abandon the request.
 *   Used to count `latencySla.timeoutCount`, NOT to abort the scenario
 *   (the orchestrator has its own agentTimeoutMs=120s).
 */
const LATENCY_SLA_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────
// Termination partial-credit factors — scorer.scoreTermination
// ─────────────────────────────────────────────────────────────────────

/**
 * Partial credit for fallback termination (max-steps exhausted OR LLM unavailable).
 * @domainJustification A fallback IS a degradation signal but not a hard failure —
 *   the agent at least produced SOMETHING. 0.25 corresponds to a 75% dock — strong
 *   enough that fallback scenarios cannot pass quality gates but soft enough that
 *   transient infra failures (provider 429 storms) don't collapse the aggregate.
 *   Previously the scorer also routed bypass-triggered `'answer'` terminations
 *   through this code path (a runtime bug), undervaluing some healthy answers.
 */
export const TERMINATION_FALLBACK_PARTIAL_CREDIT = 0.25;

// ─────────────────────────────────────────────────────────────────────
// Geo-mean trimming — scorer.weightedTrimmedGeoMean
// ─────────────────────────────────────────────────────────────────────

/**
 * Trimmed-mean trim proportion (fraction of values dropped on EACH tail).
 * @domainJustification 5% trim on each tail (10% total) follows standard
 *   robust-statistics practice for skewed distributions. The bench scoring
 *   distribution has a heavy LEFT tail (critical failures = 0) that dominates
 *   the raw geo-mean by ~20-50pp on bad runs. Trimming the bottom 5% reveals
 *   the underlying agent quality without squelching the critical-failure
 *   signal — critical failure counts are still surfaced separately as a discrete
 *   metric in the report.
 *
 *   The 5pp insight threshold below is the point at which the disagreement
 *   between raw and trimmed exceeds plausible noise — see metric-spec.md §A2.
 */
export const TRIMMED_GEOMEAN_PROPORTION = 0.05;

/**
 * Insight-rule threshold: |raw geo-mean − trimmed geo-mean| > 3pp means the
 * raw aggregate is being dragged by heavy-tailed critical failures.
 * @domainJustification 3pp is ~1 standard error of overall-score CI on a
 *   200-scenario run (typical SE ~1.5pp). Above this gap the trimmed value is
 *   measurably different, not just noise — operators should investigate the
 *   bottom 5% to confirm whether they are real quality issues or measurement
 *   artefacts.
 */
export const TRIMMED_VS_RAW_INSIGHT_DELTA = 0.03;

// ─────────────────────────────────────────────────────────────────────
// Overall-score quality bands — insight rule thresholds
// ─────────────────────────────────────────────────────────────────────

/**
 * Overall-score "good / ship-it" threshold (geo-mean).
 * @domainJustification 0.85 is the SOTA++ release gate for the agent benchmark
 *   — a run below 0.85 should not be promoted to baseline.
 */
export const INSIGHT_OVERALL_GOOD = 0.85;

/**
 * Overall-score warning threshold (geo-mean).
 * @domainJustification 0.75 leaves a 10pp margin between warning and the
 *   ship-it bar — values in [0.75, 0.85] are acceptable for exploratory
 *   ablation runs but should not be promoted unmodified.
 */
export const INSIGHT_OVERALL_WARN = 0.75;

/**
 * Faithfulness "good / strong grounding" threshold.
 * @domainJustification RAGAS faithfulness ≥0.85 means ≥85% of claims are
 *   grounded in evidence — matches the published RAGAS "production grade"
 *   benchmark expectations.
 */
export const INSIGHT_FAITHFULNESS_GOOD = 0.85;

/**
 * Faithfulness warning threshold — below this, hallucination is a real problem.
 * @domainJustification ≥70% grounding is the lower bound for a deployable
 *   agent in this domain; ≤70% means more than 1 in 3 claims is ungrounded.
 */
export const INSIGHT_FAITHFULNESS_WARN = 0.70;

/**
 * Context-relevance good / warn thresholds.
 * @domainJustification Rule-based context relevance (price band, vintage,
 *   wine_type/country/region keywords) should clear 80% on healthy runs.
 *   Below 65% the retrieval pipeline is returning largely off-topic results.
 */
export const INSIGHT_CONTEXT_RELEVANCE_GOOD = 0.80;
export const INSIGHT_CONTEXT_RELEVANCE_WARN = 0.65;

/**
 * Judge mean good / warn thresholds.
 * @domainJustification With N=3 LLM judge samples + median aggregation, the
 *   noise floor is ~0.10. A judge mean ≥0.70 is "solidly above noise";
 *   ≤0.50 is "approaching coin-flip" and indicates rubric criteria are
 *   not being satisfied.
 */
export const INSIGHT_JUDGE_GOOD = 0.70;
export const INSIGHT_JUDGE_WARN = 0.50;

/**
 * Entity Linking Accuracy @1 thresholds.
 * @domainJustification TAC-KBP benchmark publishes ≥0.92 as production-grade
 *   ELA@1; 0.85 is the near-target band where Korean alias variants are
 *   typically the gap.
 */
export const INSIGHT_ELA1_GOOD = 0.92;
export const INSIGHT_ELA1_WARN = 0.85;

/**
 * SCR overall thresholds.
 * @domainJustification ≥0.85 means the NL→constraint pipeline correctly
 *   identifies ≥85% of expected constraints across hard+soft+inferred buckets.
 *   Below 0.60 the constraint extraction is broken (most often: ontology
 *   coverage gaps).
 */
export const INSIGHT_SCR_OVERALL_GOOD = 0.85;
export const INSIGHT_SCR_OVERALL_WARN = 0.60;

/**
 * SCR inferred lower bound — below this, compositional inference rules
 * (region+wine_type → grape_family, etc.) are likely silent.
 * @domainJustification On a healthy bench run with compositional rules firing,
 *   inferred SCR is ≥0.35. Below 0.20 means either (a) the rules don't trigger
 *   or (b) authored expectations are in the wrong bucket (.soft vs .inferred).
 */
export const INSIGHT_SCR_INFERRED_LOWER_BOUND = 0.20;

/**
 * Slot-F1 thresholds (entity-level strict/relaxed match).
 * @domainJustification Slot-F1 ≥0.85 strict matches NER benchmark conventions
 *   for wine-domain entity extraction.
 */
export const INSIGHT_SLOT_F1_GOOD = 0.85;
export const INSIGHT_SLOT_F1_WARN = 0.60;

/**
 * Tier 6 (regex-only) sole-extraction rate warning thresholds.
 * @domainJustification ≥50% means most queries skipped the structured
 *   extractor → regex-only is brittle. ≤25% is the healthy band.
 */
export const INSIGHT_TIER6_GOOD = 0.25;
export const INSIGHT_TIER6_WARN = 0.50;

/**
 * Mean hard-constraints-per-query — retrieval "filtering depth" gauge.
 * @domainJustification ≥2.5 hard constraints/query means the NL Mapper is
 *   precise (wine_type + price + region + vintage = 4). ≤1.5 means
 *   retrieval is under-filtered — broad, imprecise candidate sets.
 *
 *   NOTE: this is the SAME metric where the bench previously hardcoded `0`
 *   for `meanHardConstraints` (TODO comment). The contract test in
 *   test/regression/benchmark-metric-contract.regression.test.ts asserts the
 *   value is aggregated from real per-scenario extraction, not stubbed.
 */
export const INSIGHT_MEAN_HARD_CONSTRAINTS_GOOD = 2.5;
export const INSIGHT_MEAN_HARD_CONSTRAINTS_WARN = 1.5;

// ─────────────────────────────────────────────────────────────────────
// Sample-size gates — interpretation reliability
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimum annotated scenarios for SCR/ELA/Slot-F1 to be statistically stable.
 * @domainJustification Below 10 samples, the mean has CI half-width ≥10pp,
 *   making cross-run comparison meaningless. Same threshold across all
 *   constraint-extraction metrics for consistency.
 */
export const MIN_ANNOTATION_SAMPLES = 10;

/**
 * Minimum worst-scenario samples before claiming a "judge variance" pattern.
 * @domainJustification Need at least 5 worst-scoring scenarios so that
 *   "2 of worst-5 have judge=0" is meaningful (≥40% concentration).
 */
export const MIN_SCENARIOS_FOR_VARIANCE = 5;

// ─────────────────────────────────────────────────────────────────────
// Judge sampling — runner.ts default & judge.ts
// ─────────────────────────────────────────────────────────────────────

/**
 * Default LLM-judge sample count for the median aggregation.
 * @domainJustification N=3 balances cost (3× judge calls per scenario) against
 *   noise reduction (median of 3 samples drops noise ~40% vs single sample).
 *   N=5 (JUDGE_REQUIRED_SAMPLES below) reserved for judgeRequired scenarios
 *   where the judge is the PRIMARY signal.
 */
const JUDGE_DEFAULT_SAMPLES = 3;

/**
 * Required LLM-judge sample count for scenarios with `judgeRequired: true`.
 * @domainJustification On judge-as-primary scenarios (negation, refusal,
 *   register), the noise floor must be lower. N=5 gives ~55% noise reduction
 *   vs single sample.
 */
const JUDGE_REQUIRED_SAMPLES = 5;

// ─────────────────────────────────────────────────────────────────────
// Faithfulness / context-recall warning thresholds — scorer.ts
// ─────────────────────────────────────────────────────────────────────

/**
 * Faithfulness threshold below which a per-scenario warning diagnostic fires.
 * @domainJustification 0.5 = half the claims are ungrounded. Used by
 *   scorer.scoreScenario to emit the FAITHFULNESS_LOW diagnostic; distinct
 *   from the run-level insight thresholds above.
 */
export const FAITHFULNESS_PER_SCENARIO_WARN = 0.5;

// ─────────────────────────────────────────────────────────────────────
// Penalty multipliers — scorer.ts (re-exported as named refs)
// ─────────────────────────────────────────────────────────────────────
// These constants currently live as private `const` in scorer.ts. We expose
// thin re-exports here so the contract test can assert them against fixtures
// without re-reading scorer.ts internals. Update scorer.ts → re-export here.

/**
 * Tool accuracy: per-call penalty for unexpected tool invocations.
 * @domainJustification Each unexpected tool call docks 10% of tool accuracy
 *   (multiplicative), capped at 50% (PENALTY_EXTRA_TOOL_CAP). Calibrated so
 *   a single drift call is recoverable; multiple drifts compound to the cap.
 */
export const PENALTY_EXTRA_TOOL_PER_CALL = 0.1;

/**
 * Tool accuracy: maximum cumulative penalty from extra tool calls.
 * @domainJustification Cap at 50% so a noisy run can still earn partial credit
 *   if it eventually called the expected tools.
 */
export const PENALTY_EXTRA_TOOL_CAP = 0.5;

/**
 * Tool accuracy: multiplier per over-duplicated expected tool.
 * @domainJustification 0.7 means 30% dock per duplication burst. Smooth-graded
 *   in scorer via `Math.max(ratio, PENALTY_TOOL_DUPLICATE)` so mild
 *   over-calling (5 expected, 6 actual = 0.83) is gentler than full cap.
 */
export const PENALTY_TOOL_DUPLICATE = 0.7;

/**
 * Tool accuracy: multiplier when expected tool order violated.
 * @domainJustification 0.5 (50% dock) for an out-of-order sequence — order
 *   matters less than tool selection itself, hence not 0.3.
 */
export const PENALTY_TOOL_ORDER_VIOLATION = 0.5;

/**
 * Execution efficiency weight split: tool accuracy vs step efficiency.
 * @domainJustification Tool accuracy is the harder, more diagnostic signal —
 *   60/40 favour tool over step. Sum to 1.0 by construction.
 */
export const EXEC_TOOL_WEIGHT = 0.6;
export const EXEC_STEP_WEIGHT = 0.4;

/**
 * Default DimensionWeights total — sanity check + tier-weight invariants.
 * @domainJustification All tier weight overrides MUST sum to 1.0 (within float
 *   epsilon); enforced by the weightInvariants test in scorer.test.ts.
 */
const DIMENSION_WEIGHTS_TOTAL = 1.0;
