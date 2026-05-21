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
  readonly meanHardConstraints: number;
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

/** SLA and quality thresholds. */
const THRESHOLDS = {
  overall: { good: 0.85, warn: 0.75 },
  faithful: { good: 0.85, warn: 0.70 },
  ctxRelevance: { good: 0.80, warn: 0.65 },
  judge: { good: 0.70, warn: 0.50 },
  ela1: { good: 0.92, warn: 0.85 },
  scrOverall: { good: 0.85, warn: 0.60 },
  slotF1: { good: 0.85, warn: 0.60 },
  latencyP50: 10_000,
  latencyP95: 20_000,
  tier6Rate: { good: 0.25, warn: 0.50 },
  meanHardConstraints: { good: 2.5, warn: 1.5 },
} as const;

/** ELA near-target band lower bound: warn-level floor up to the TAC-KBP good target. */
const ELA_NEAR_TARGET_LOWER_BOUND = THRESHOLDS.ela1.warn;
/** SCR inferred must not collapse below this floor, otherwise compositional rules likely not firing. */
const SCR_INFERRED_LOWER_BOUND = 0.20;
/** Minimum annotated scenarios required for stable SCR/ELA/Slot-F1 interpretation. */
const MIN_ANNOTATION_SAMPLES = 10;
/** Need enough worst-scenario samples before claiming judge variance patterns. */
const MIN_SCENARIOS_FOR_VARIANCE = 5;

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
  {
    id: 'hard_constraints_low',
    severity: '🟡',
    check: (r) => r.meanHardConstraints < THRESHOLDS.meanHardConstraints.warn
      ? `Mean hard constraints ${r.meanHardConstraints.toFixed(2)} — below warning threshold (${THRESHOLDS.meanHardConstraints.warn}). Retrieval is under-filtered — many queries get broad, imprecise results.`
      : null,
  },
  {
    id: 'hard_constraints_good',
    severity: '🟢',
    check: (r) => r.meanHardConstraints >= THRESHOLDS.meanHardConstraints.good
      ? `Mean hard constraints ${r.meanHardConstraints.toFixed(2)} — retrieval is well-filtered.`
      : null,
  },
];

/**
 * Run all deterministic insight rules and return formatted output lines.
 */
function generateDeterministicInsights(report: BenchmarkReportSlice): readonly string[] {
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
Mean hard constraints: ${report.meanHardConstraints.toFixed(2)}
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
