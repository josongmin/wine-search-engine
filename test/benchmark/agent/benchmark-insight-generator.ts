/**
 * RFC-020: Benchmark Insight Generator
 *
 * Runs after benchmark scoring. Takes the full report and generates
 * actionable insights via LLM analysis + deterministic rule checks.
 *
 * Two-tier architecture:
 *   Tier 1: Deterministic rules — threshold violations, regressions, patterns
 *   Tier 2: LLM analysis — contextual interpretation, root cause hypotheses
 *
 * Output: human-readable insight block appended to stderr summary.
 */

import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import {
  INSIGHT_OVERALL_GOOD,
  INSIGHT_OVERALL_WARN,
  INSIGHT_FAITHFULNESS_GOOD,
  INSIGHT_FAITHFULNESS_WARN,
  INSIGHT_CONTEXT_RELEVANCE_GOOD,
  INSIGHT_CONTEXT_RELEVANCE_WARN,
  INSIGHT_JUDGE_GOOD,
  INSIGHT_JUDGE_WARN,
  INSIGHT_ELA1_GOOD,
  INSIGHT_ELA1_WARN,
  INSIGHT_SCR_OVERALL_GOOD,
  INSIGHT_SCR_OVERALL_WARN,
  INSIGHT_SCR_INFERRED_LOWER_BOUND,
  INSIGHT_SLOT_F1_GOOD,
  INSIGHT_SLOT_F1_WARN,
  INSIGHT_TIER6_GOOD,
  INSIGHT_TIER6_WARN,
  INSIGHT_MEAN_HARD_CONSTRAINTS_GOOD,
  INSIGHT_MEAN_HARD_CONSTRAINTS_WARN,
  LATENCY_SLA_P50_MS,
  LATENCY_SLA_P95_MS,
  MIN_ANNOTATION_SAMPLES as K_MIN_ANNOTATION_SAMPLES,
  MIN_SCENARIOS_FOR_VARIANCE as K_MIN_SCENARIOS_FOR_VARIANCE,
  TRIMMED_VS_RAW_INSIGHT_DELTA,
} from './constants.js';

// ─────────────────────────────────────────────────────────────────────
// Tier 1: Deterministic insight rules
// ─────────────────────────────────────────────────────────────────────

interface InsightRule {
  readonly id: string;
  readonly severity: '🔴' | '🟡' | '🟢' | 'ℹ️';
  readonly check: (report: BenchmarkReportSlice) => string | null;
}

/** Minimal report slice needed for insight generation. */
export interface BenchmarkReportSlice {
  readonly overallScore: number;
  /**
   * Geo-mean alias for `overallScore`. SOTA++ reliability addition (A2): the
   * insight rule `trimmed_vs_raw_gap` compares this against
   * `overallScoreTrimmedGeoMean5` and warns when they diverge >3pp.
   */
  readonly overallScoreGeoMean: number;
  /** 5%-trimmed geo-mean of per-scenario overall. */
  readonly overallScoreTrimmedGeoMean5: number;
  readonly overallCi95Lower: number;
  readonly overallCi95Upper: number;
  readonly executionEfficiency: number;
  readonly answerQuality: number;
  readonly faithfulness: number | null;
  readonly contextRelevance: number | null;
  readonly contextRecall: number | null;
  readonly judge: number | null;
  /**
   * L1.A: latency p50 in ms, scored against AGENT WORK time (scenario wall
   * minus throttle/backoff sleep). This is what the SLA gate evaluates.
   */
  readonly latencyP50Ms: number;
  /** L1.A: latency p95 in ms (agent-work). SLA gate evaluates against this. */
  readonly latencyP95Ms: number;
  /**
   * L1.A: raw scenario wall p95 (NOT SLA-gated). Surfaced so the insight
   * generator can call out infra throttle without confusing it with agent
   * slowness. May be greater than `latencyP95Ms` when provider 429/503
   * backoff was absorbed during the run.
   */
  readonly latencyP95WallMs: number;
  readonly tier6SoleExtractionRate: number | null;
  /**
   * Mean hard-constraints per query — `null` when no scenarios had constraint
   * extraction. Was previously hardcoded `0`; now genuinely null-safe so
   * insight rules skip cleanly instead of misfiring on a stub value.
   */
  readonly meanHardConstraints: number | null;
  readonly scrOverall: number | null;
  readonly scrHard: number | null;
  readonly scrSoft: number | null;
  readonly scrInferred: number | null;
  readonly entityLinkingAccuracy: number | null;
  readonly slotF1Strict: number | null;
  readonly constraintEvaluatedCount: number;
  readonly scenarioCount: number;
  readonly criticalFailureCount: number;
  /** Worst scenario scores for pattern detection. */
  readonly worstScenarios: readonly { id: number; tier: string; score: number; judge: number | null }[];
}

/**
 * SLA and quality thresholds — sourced from `./constants.js` (SSoT). Local
 * `THRESHOLDS` object kept for backward-compatible expression and quick scan,
 * but every value is bound to the imported constant. Update the SSoT, not here.
 */
const THRESHOLDS = {
  overall: { good: INSIGHT_OVERALL_GOOD, warn: INSIGHT_OVERALL_WARN },
  faithful: { good: INSIGHT_FAITHFULNESS_GOOD, warn: INSIGHT_FAITHFULNESS_WARN },
  ctxRelevance: { good: INSIGHT_CONTEXT_RELEVANCE_GOOD, warn: INSIGHT_CONTEXT_RELEVANCE_WARN },
  judge: { good: INSIGHT_JUDGE_GOOD, warn: INSIGHT_JUDGE_WARN },
  ela1: { good: INSIGHT_ELA1_GOOD, warn: INSIGHT_ELA1_WARN },
  scrOverall: { good: INSIGHT_SCR_OVERALL_GOOD, warn: INSIGHT_SCR_OVERALL_WARN },
  slotF1: { good: INSIGHT_SLOT_F1_GOOD, warn: INSIGHT_SLOT_F1_WARN },
  latencyP50: LATENCY_SLA_P50_MS,
  latencyP95: LATENCY_SLA_P95_MS,
  tier6Rate: { good: INSIGHT_TIER6_GOOD, warn: INSIGHT_TIER6_WARN },
  meanHardConstraints: { good: INSIGHT_MEAN_HARD_CONSTRAINTS_GOOD, warn: INSIGHT_MEAN_HARD_CONSTRAINTS_WARN },
} as const;

const ELA_NEAR_TARGET_LOWER_BOUND = THRESHOLDS.ela1.warn;
const SCR_INFERRED_LOWER_BOUND = INSIGHT_SCR_INFERRED_LOWER_BOUND;
const MIN_ANNOTATION_SAMPLES = K_MIN_ANNOTATION_SAMPLES;
const MIN_SCENARIOS_FOR_VARIANCE = K_MIN_SCENARIOS_FOR_VARIANCE;

const DETERMINISTIC_RULES: readonly InsightRule[] = [
  // ── Overall health ──
  {
    id: 'overall_critical',
    severity: '🔴',
    check: (r) => r.overallScore < THRESHOLDS.overall.warn
      ? `Overall ${(r.overallScore * 100).toFixed(1)}% is below warning threshold (${THRESHOLDS.overall.warn * 100}%). CI range [${(r.overallCi95Lower * 100).toFixed(1)}–${(r.overallCi95Upper * 100).toFixed(1)}%] — wide CI suggests high variance across scenarios.`
      : null,
  },
  {
    id: 'overall_good',
    severity: '🟢',
    check: (r) => r.overallScore >= THRESHOLDS.overall.good
      ? `Overall ${(r.overallScore * 100).toFixed(1)}% meets quality bar (≥${THRESHOLDS.overall.good * 100}%).`
      : null,
  },
  // ── Critical failures ──
  {
    id: 'critical_failures',
    severity: '🔴',
    check: (r) => r.criticalFailureCount > 0
      ? `${r.criticalFailureCount} scenario(s) had critical failures (overall collapsed to 0). These dominate the geo-mean — fix these first.`
      : null,
  },
  // ── Faithfulness (hallucination) ──
  {
    id: 'faithful_low',
    severity: '🔴',
    check: (r) => r.faithfulness !== null && r.faithfulness < THRESHOLDS.faithful.warn
      ? `Faithful ${(r.faithfulness * 100).toFixed(1)}% — ${((1 - r.faithfulness) * 100).toFixed(0)}% of answer claims are not grounded in search results. Agent is hallucinating wine names/prices/regions.`
      : null,
  },
  {
    id: 'faithful_good',
    severity: '🟢',
    check: (r) => r.faithfulness !== null && r.faithfulness >= THRESHOLDS.faithful.good
      ? `Faithful ${(r.faithfulness * 100).toFixed(1)}% — answer grounding is strong.`
      : null,
  },
  // ── ELA ──
  {
    id: 'ela_near_target',
    severity: '🟡',
    check: (r) => r.entityLinkingAccuracy !== null && r.entityLinkingAccuracy >= ELA_NEAR_TARGET_LOWER_BOUND && r.entityLinkingAccuracy < THRESHOLDS.ela1.good
      ? `ELA@1 ${(r.entityLinkingAccuracy * 100).toFixed(1)}% — close to TAC KBP target (${THRESHOLDS.ela1.good * 100}%). Likely missing: Korean alias variants (붙여쓰기, 약어). Expand RESOLVER_INDEX with surface form variations.`
      : null,
  },
  {
    id: 'ela_achieved',
    severity: '🟢',
    check: (r) => r.entityLinkingAccuracy !== null && r.entityLinkingAccuracy >= THRESHOLDS.ela1.good
      ? `ELA@1 ${(r.entityLinkingAccuracy * 100).toFixed(1)}% — meets TAC KBP benchmark level (≥${THRESHOLDS.ela1.good * 100}%).`
      : null,
  },
  // ── SCR ──
  {
    id: 'scr_inferred_low',
    severity: '🔴',
    check: (r) => r.scrInferred !== null && r.scrInferred < SCR_INFERRED_LOWER_BOUND
      ? `SCR inferred ${(r.scrInferred * 100).toFixed(1)}% — compositional inference rules are not firing or expected constraints are in wrong bucket. Check: (1) compositional-inference.ts rules require BOTH region AND wine_type — comparison queries may only have region. (2) expectedConstraints.inferred vs .soft bucket mismatch.`
      : null,
  },
  {
    id: 'scr_annotation_sparse',
    severity: '🟡',
    check: (r) => r.constraintEvaluatedCount < MIN_ANNOTATION_SAMPLES
      ? `Only ${r.constraintEvaluatedCount}/${r.scenarioCount} scenarios have expectedConstraints annotations. SCR/ELA/Slot F1 are statistically unreliable below ${MIN_ANNOTATION_SAMPLES} samples. Add annotations to more scenarios for stable measurement.`
      : null,
  },
  // ── Tier 6 rate ──
  {
    id: 'tier6_high',
    severity: '🟡',
    check: (r) => r.tier6SoleExtractionRate !== null && r.tier6SoleExtractionRate > THRESHOLDS.tier6Rate.warn
      ? `Tier 6 sole-extraction rate ${(r.tier6SoleExtractionRate * 100).toFixed(0)}% — half of queries rely only on regex patterns. Note: mood/atmosphere queries ("비 오는 날 혼술") have NO extractable constraints → Tier 6 is the correct path for these. Filter to constraint-bearing queries for accurate measurement.`
      : null,
  },
  // ── Latency SLA — gated on AGENT WORK time (wall MINUS throttle backoff) ──
  // L1.A: switching the gate input from raw wall to agent-work eliminates the
  // false-positive SLA fail when the slow scenarios are at step=1 (pure
  // provider 429/503 backoff, not agent multi-step work). The wall p95 is
  // still surfaced so reviewers can see infra impact.
  {
    id: 'latency_p95_fail',
    severity: '🔴',
    check: (r) => {
      if (r.latencyP95Ms <= THRESHOLDS.latencyP95) return null;
      const wallDelta = Math.max(0, r.latencyP95WallMs - r.latencyP95Ms);
      const wallNote = wallDelta > 0
        ? ` (wall p95 ${r.latencyP95WallMs}ms; +${wallDelta}ms infra throttle backoff already excluded)`
        : '';
      return `Latency p95 ${r.latencyP95Ms}ms (agent-work) exceeds SLA (${THRESHOLDS.latencyP95}ms)${wallNote}. Check: Vespa query latency, agent step count, or planner LLM RTT (provider throttle already excluded — see L1.A).`;
    },
  },
  // L1.A: when only the WALL p95 is over budget but the agent-work p95 is
  // under, the run absorbed infra throttle backoff that the SLA correctly
  // ignored. Inform the operator so the run is not misread as a regression.
  {
    id: 'latency_p95_wall_high_agent_ok',
    severity: 'ℹ️',
    check: (r) => (r.latencyP95Ms <= THRESHOLDS.latencyP95 && r.latencyP95WallMs > THRESHOLDS.latencyP95)
      ? `Wall p95 ${r.latencyP95WallMs}ms > SLA (${THRESHOLDS.latencyP95}ms), but agent-work p95 ${r.latencyP95Ms}ms is WITHIN SLA. The gap (${r.latencyP95WallMs - r.latencyP95Ms}ms) is provider throttle backoff during retries — not an agent regression.`
      : null,
  },
  // ── Judge variance ──
  {
    id: 'judge_variance',
    severity: '🟡',
    check: (r) => {
      if (r.worstScenarios.length < MIN_SCENARIOS_FOR_VARIANCE) return null;
      const judgeZeros = r.worstScenarios.filter((s) => s.judge === 0).length;
      return judgeZeros >= 2
        ? `${judgeZeros} of worst-5 scenarios have judge=0.00. Even with N=3 median, LLM judge gives consistent 0 scores — these are real quality issues, not variance. Check judge reasoning for these scenarios.`
        : null;
    },
  },
  // ── Mean hard constraints ──
  // SOTA++ reliability fix: rule now requires meanHardConstraints !== null.
  // Previously the runner shipped a hardcoded `0`, which silently fired
  // `hard_constraints_low` on every run regardless of true retrieval filtering.
  {
    id: 'hard_constraints_low',
    severity: '🟡',
    check: (r) => r.meanHardConstraints !== null && r.meanHardConstraints < THRESHOLDS.meanHardConstraints.warn
      ? `Mean hard constraints ${r.meanHardConstraints.toFixed(2)} — below warning threshold (${THRESHOLDS.meanHardConstraints.warn}). Retrieval is under-filtered — many queries get broad, imprecise results.`
      : null,
  },
  {
    id: 'hard_constraints_good',
    severity: '🟢',
    check: (r) => r.meanHardConstraints !== null && r.meanHardConstraints >= THRESHOLDS.meanHardConstraints.good
      ? `Mean hard constraints ${r.meanHardConstraints.toFixed(2)} — retrieval is well-filtered.`
      : null,
  },
  // ── Raw vs trimmed geo-mean divergence (heavy-tail detector) ──
  //
  // SOTA++ reliability addition (A2): when |raw − trimmed| exceeds
  // TRIMMED_VS_RAW_INSIGHT_DELTA, the raw aggregate is being dragged by
  // left-tail critical failures. This rule surfaces the gap so operators
  // know the headline overall score is structurally fragile.
  //
  // Trimmed is the more honest "agent quality" signal; the bottom 5% likely
  // contain critical failures (counted separately via criticalFailureCount).
  {
    id: 'trimmed_vs_raw_gap',
    severity: '🟡',
    check: (r) => {
      const gap = r.overallScoreTrimmedGeoMean5 - r.overallScoreGeoMean;
      if (!Number.isFinite(gap) || gap < TRIMMED_VS_RAW_INSIGHT_DELTA) return null;
      return (
        `Trimmed geo-mean ${(r.overallScoreTrimmedGeoMean5 * 100).toFixed(1)}% exceeds raw ${(r.overallScoreGeoMean * 100).toFixed(1)}% by ${(gap * 100).toFixed(1)}pp — `
        + `raw aggregate is dragged by the bottom 5% (likely critical failures). `
        + `criticalFailureCount=${r.criticalFailureCount}. The trimmed value is the more honest agent-quality signal; `
        + `treat the gap as an indicator that fixing the left-tail scenarios will move the headline number.`
      );
    },
  },
];

/**
 * Run all deterministic insight rules and return formatted output lines.
 *
 * Exported for the bench self-test regression — synthetic reports feed in
 * here and assert which rule ids fire / don't fire. Keeps the rule contract
 * unit-testable without spinning up the real LLM analysis path.
 */
export function generateDeterministicInsights(report: BenchmarkReportSlice): readonly string[] {
  const lines: string[] = [];
  for (const rule of DETERMINISTIC_RULES) {
    const result = rule.check(report);
    if (result !== null) {
      lines.push(`  ${rule.severity} [${rule.id}] ${result}`);
    }
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// Tier 2: LLM-powered contextual insight
// ─────────────────────────────────────────────────────────────────────

const INSIGHT_SYSTEM_PROMPT = `You are a wine search engine benchmark analyst. Given benchmark metrics, produce actionable insights.

Rules:
1. Focus on the 3 most impactful improvements.
2. For each insight: state the problem, root cause hypothesis, and specific fix.
3. Reference specific metrics by name (e.g., "SCR inferred 12.5%").
4. Prioritize by user-visible impact, not engineering convenience.
5. Be concise — max 5 lines per insight.
6. Output in Korean (한국어) with technical terms in English.

Output format:
### 1. [제목]
[문제] → [원인 가설] → [구체적 수정 방안]

### 2. [제목]
...

### 3. [제목]
...`;

/**
 * Generate LLM-powered contextual insights from benchmark metrics.
 * Returns null if LLM is unavailable or call fails.
 */
async function generateLlmInsights(
  report: BenchmarkReportSlice,
  llm: ChatLlmPort,
): Promise<string | null> {
  const metricsPrompt = `## Benchmark Metrics (v6-SOTA++)

Overall: ${(report.overallScore * 100).toFixed(1)}% [CI ${(report.overallCi95Lower * 100).toFixed(1)}–${(report.overallCi95Upper * 100).toFixed(1)}%]
Execution Efficiency: ${(report.executionEfficiency * 100).toFixed(1)}%
Answer Quality: ${(report.answerQuality * 100).toFixed(1)}%
Faithful: ${report.faithfulness !== null ? (report.faithfulness * 100).toFixed(1) + '%' : 'n/a'}
Ctx Relevance: ${report.contextRelevance !== null ? (report.contextRelevance * 100).toFixed(1) + '%' : 'n/a'}
Ctx Recall: ${report.contextRecall !== null ? (report.contextRecall * 100).toFixed(1) + '%' : 'n/a'}
Judge: ${report.judge !== null ? (report.judge * 100).toFixed(1) + '%' : 'disabled'}

SCR overall: ${report.scrOverall !== null ? (report.scrOverall * 100).toFixed(1) + '%' : 'n/a'}
SCR hard: ${report.scrHard !== null ? (report.scrHard * 100).toFixed(1) + '%' : 'n/a'}
SCR soft: ${report.scrSoft !== null ? (report.scrSoft * 100).toFixed(1) + '%' : 'n/a'}
SCR inferred: ${report.scrInferred !== null ? (report.scrInferred * 100).toFixed(1) + '%' : 'n/a'}
ELA@1: ${report.entityLinkingAccuracy !== null ? (report.entityLinkingAccuracy * 100).toFixed(1) + '%' : 'n/a'}
Slot F1 strict: ${report.slotF1Strict !== null ? (report.slotF1Strict * 100).toFixed(1) + '%' : 'n/a'}
Constraint evaluated: ${report.constraintEvaluatedCount}/${report.scenarioCount} scenarios

Tier 6 sole-extraction rate: ${report.tier6SoleExtractionRate !== null ? (report.tier6SoleExtractionRate * 100).toFixed(0) + '%' : 'n/a'}
Mean hard constraints: ${report.meanHardConstraints !== null ? report.meanHardConstraints.toFixed(2) : 'n/a'}
Latency p50: ${report.latencyP50Ms}ms | p95: ${report.latencyP95Ms}ms
Critical failures: ${report.criticalFailureCount}

Worst 5 scenarios:
${report.worstScenarios.map((s) => `  #${s.id} (${s.tier}) ${(s.score * 100).toFixed(1)}% judge=${s.judge?.toFixed(2) ?? 'n/a'}`).join('\n')}

Produce 3 actionable insights.`;

  try {
    const result = await llm.complete({
      messages: [
        { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
        { role: 'user', content: metricsPrompt },
      ],
      temperature: 0.3,
      maxOutputTokens: 800,
    });
    return result.text;
  } catch (err) {
    console.error(`  [INSIGHT-LLM] Error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
    return null;
  }
}

/**
 * Print the full insight block to stderr.
 */
export async function printBenchmarkInsights(
  report: BenchmarkReportSlice,
  llm?: ChatLlmPort,
): Promise<void> {
  console.error('\n  ────── insights ──────');

  // Tier 1: Deterministic rules
  const deterministicInsights = generateDeterministicInsights(report);
  for (const line of deterministicInsights) {
    console.error(line);
  }

  // Tier 2: LLM analysis (optional)
  if (llm !== undefined) {
    console.error('\n  ────── LLM analysis ──────');
    const llmInsight = await generateLlmInsights(report, llm);
    if (llmInsight !== null) {
      for (const line of llmInsight.split('\n')) {
        console.error(`  ${line}`);
      }
    } else {
      console.error('  (LLM insight generation failed — skipped)');
    }
  }

  console.error('');
}
