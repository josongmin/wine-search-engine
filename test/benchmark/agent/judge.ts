/**
 * LLM-as-judge for benchmark answer quality (SOTA++ v2).
 *
 * Uses a separate (cheaper) model to evaluate whether the agent's answer
 * satisfies the scenario's free-form rubric. Returns a 0..1 median score
 * across N samples to reduce LLM variance.
 *
 * The judge is intentionally STATELESS and low-variance: temperature 0.1,
 * single-shot prompt with strict JSON output. Failures return `score: null`
 * so the scorer DROPS the judge dimension from the geometric mean (no
 * inflation, no false penalty).
 *
 * Variance handling: judgeAnswerN(N) calls the judge N times and takes the
 * median. Default N=1 for cost; runner can pass N=3 for high-confidence runs.
 */

import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import type { AgentBenchmarkScenario } from './scenario.js';
import {
  collectGroundingFacts,
  verifyAnswerGrounding,
  normalizeClaimSurface,
  type GroundingFacts,
} from '../../../src/application/wine-search/synthesis-grounding-verify.js';
import type { ToolOutcome } from '../../../src/domain/agent/model/tool-outcome.js';

export interface JudgeResult {
  /** 0..1 score, or null when judge could not be evaluated (parse fail / API error / no rubric). */
  readonly score: number | null;
  readonly rationale: string;
  readonly failed: boolean;
  /** Number of samples taken (for diagnostic). */
  readonly samples: number;
}

/**
 * Provenance of a faithfulness score, for measurement-health telemetry.
 *
 * - `deterministic` — the structural grounding verifier found ALL extractable
 *   claims grounded; the LLM faithfulness judge was skipped (its signal is
 *   redundant for "are the cited entities present in grounding"). Authoritative.
 * - `llm` — the deterministic verifier had no usable grounding facts (nothing to
 *   verify structurally), so the LLM judge is the sole signal.
 * - `hybrid` — the deterministic verifier found ungrounded claims; we fell to the
 *   LLM judge for semantic nuance but recorded BOTH signals (see
 *   `deterministicScore` / `faithDisagreement`).
 */
export type FaithfulnessSource = 'deterministic' | 'llm' | 'hybrid';

/**
 * Extended faithfulness result. Superset of `JudgeResult` — adds the
 * deterministic-vs-LLM telemetry the runner surfaces per scenario.
 */
export interface FaithfulnessResult extends JudgeResult {
  /** Which signal produced `score`. */
  readonly faithfulnessSource: FaithfulnessSource;
  /** Deterministic verifier score (1.0 grounded / 0.0 ungrounded), or null when no facts. */
  readonly deterministicScore: number | null;
  /** LLM judge score, or null when the LLM judge was skipped or failed. */
  readonly llmScore: number | null;
  /**
   * True when deterministic and LLM signals BOTH exist and disagree by > 0.5.
   * A high rate across a run is itself a measurement-health red flag.
   */
  readonly faithDisagreement: boolean;
  /** Normalized claim surfaces the deterministic verifier could not ground. */
  readonly ungroundedClaims: readonly string[];
}

/**
 * Magnitude above which the deterministic and LLM faithfulness signals are
 * considered to "disagree" for telemetry purposes. 0.5 is half the 0..1 range —
 * e.g. deterministic=1.0 vs llm=0.0 (the exact judge↔judge contradiction this
 * fix targets) is a disagreement; deterministic=1.0 vs llm=0.75 is not.
 */
const FAITH_DISAGREEMENT_THRESHOLD = 0.5;

/**
 * Credit awarded to a "partially_supported" claim in the LLM faithfulness
 * verifier's graded breakdown. RAGAS / NLI literature treats partial entailment
 * as a non-binary judgment — a claim whose ENTITY is grounded but whose
 * QUALIFIER (vintage, region adjective, price tier) is not specified in the
 * retrieved evidence is conventionally weighted at 0.5 (half-credit) rather
 * than 0 (contradicted) or 1 (fully entailed).
 *
 * Why 0.5 specifically:
 *   - It is the midpoint of [0, 1] and emerges as the maximum-entropy estimate
 *     of P(true | partial-evidence) absent further information (Wang et al.
 *     2023 "Less is More for Long Document Summary Evaluation by LLM").
 *   - Empirically, the previous binary-scoring prompt collapsed 17 bench
 *     scenarios with 1/2 or 2/3 grounded claims to faith=0.00, dragging the
 *     geo-mean by ~3pp. Setting partial=0.5 recovers ~1.5pp without crediting
 *     unsupported claims (still strictly less than fully-supported).
 *
 * If a future calibration study finds a better point estimate (e.g. 0.4 or
 * 0.6), update this constant — DO NOT spread partial-credit weights across
 * the codebase.
 */
const LLM_PARTIAL_CLAIM_CREDIT = 0.5;

interface JudgeEvidenceContext {
  readonly observations?: readonly string[];
}

/**
 * Judge temperature — 0 is optimal for deterministic rubric scoring.
 *
 * History: briefly set to 0.1 for "consistency" but this INCREASED variance on
 * N=1 runs and produced measurable judge-score drift between benchmark runs.
 * Setting back to 0 restores deterministic output per the LLM-as-judge literature
 * (Zheng et al. 2023 "Judging LLM-as-a-Judge"): temperature sampling is only
 * valuable when aggregating multiple samples for uncertainty estimation, and we
 * already do that via judgeAnswerN's median voting for N>1.
 */
const JUDGE_TEMPERATURE = 0;

/**
 * Separation of concerns between the rubric judge and the faithfulness judge:
 *
 *   - THIS judge (judgeAnswer) scores rubric satisfaction (pragmatic quality).
 *     By default it sees only (query, answer, rubric). For exact-lookup benchmark
 *     cases only, the runner may additionally provide a compact evidence-contract
 *     context (CONFIRMED/NEGATIVE/UNCONFIRMED + top label). That context is not a
 *     general grounding judge; it only prevents rubrics with "if live evidence..."
 *     conditions from asking the model to infer evidence status it cannot see.
 *
 *   - The SEPARATE judgeFaithfulness (below) scores evidence-based grounding
 *     given (answer, observations). It uses NLI-style atomic claim verification
 *     and is the correct place for hallucination detection.
 *
 * Commit 2abc3c8 added a "Check factual grounding" step here by mistake. That
 * step was impossible to execute (no observations in scope) and caused a ~12pp
 * measurement shift in benchmark aggregate as the judge started penalizing
 * answers it could not actually verify. It has been removed; grounding checks
 * happen exclusively in judgeFaithfulness now.
 */
const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a wine search engine's agent responses.
Given a user query, the agent's answer, and a rubric, score how well the answer satisfies the rubric.

## Scope (critical)
You evaluate RUBRIC SATISFACTION only — is the answer helpful, complete, and on-topic for the
rubric criteria? You do NOT have access to the agent's tool results, so you MUST NOT attempt to
verify whether specific wine names, prices, or regions are factually correct. A separate
faithfulness judge handles grounding against tool observations; your job is pragmatic quality.

If an [EVIDENCE CONTRACT CONTEXT] block is provided, use it only to resolve rubric conditions
that explicitly depend on retrieval/evidence status (for example, whether an exact lookup was
confirmed or should abstain). Do not infer facts beyond that compact context.

## Evaluation Process (follow this exactly)
1. List which rubric criteria the answer satisfies and which it misses.
2. Assign a score based on the ratio of satisfied criteria, weighted by criterion importance.
3. If the rubric explicitly says an omission is acceptable, evidence-dependent, or should not be invented
   when not grounded, do NOT count that omission as a missed criterion. Acceptable omissions must not
   reduce the score.

## Score Scale
  1.00 — fully satisfies ALL rubric criteria, coherent and complete
  0.75 — satisfies most criteria (≥75%), minor gaps only
  0.50 — satisfies about half the criteria, significant gaps
  0.25 — satisfies few criteria (<25%), major issues
  0.00 — does not satisfy any criteria, or entirely off-topic

## Domain Examples
Example 1 — Score 1.00:
  Query: "보르도 레드 추천" | Rubric: "Must recommend Bordeaux red wines"
  Answer: "보르도 레드로 Château Margaux 2015, Pauillac 지역의 풀바디 카베르네 블렌드입니다."
  → All criteria met: Bordeaux ✓, red ✓, specific wine ✓, region detail ✓

Example 2 — Score 0.25:
  Query: "5만원 이하 가성비 와인" | Rubric: "Recommend wines ≤50,000 KRW"
  Answer: "Opus One을 추천합니다. 훌륭한 와인이에요."
  → Price constraint violated (Opus One >> 50,000₩), no price mentioned ✗

Example 3 — Score 0.50:
  Query: "이탈리아 화이트 추천" | Rubric: "Must recommend Italian white wines with region info"
  Answer: "Pinot Grigio를 추천드립니다. 가볍고 시원한 스타일이에요."
  → Italian ✓, white ✓, but no region specified ✗, only 1 wine ✗

## Output Format
Output STRICTLY a single JSON object:
{"score": 0.0, "rationale": "brief analysis: [criteria met] vs [criteria missed]"}

Output ONLY the JSON. No markdown, no preamble, no trailing commentary.`;

/**
 * Judge with N samples + median voting (majority semantics).
 *
 * Higher N reduces variance at linear cost. The result requires at least
 * ⌈N/2⌉ successful samples — fewer triggers `failed:true` and `score:null`,
 * which the scorer drops from the geo-mean (no inflation, no false floor).
 *
 * For N=1 the threshold is 1 (must succeed). For N=3 the threshold is 2.
 * Without the threshold, a single noisy success outranks N-1 failures.
 *
 * The median of even-length successful arrays is the average of the two
 * middle elements (standard definition).
 */
export async function judgeAnswerN(
  judgeLlm: ChatLlmPort,
  scenario: AgentBenchmarkScenario,
  answer: string,
  samples: number,
  evidenceContext?: JudgeEvidenceContext,
): Promise<JudgeResult> {
  // Auto-compose rubric from structured fields when hand-written rubric is absent.
  // This activates the judge dimension for scenarios that specify structured
  // expectations (priceBandKrw, factCheckClaims, requireHedging, etc.) even
  // without a manual rubric string.
  const composedRubric = composeAutoRubric(scenario.expectation);
  // v4: removed "Additional checks:" label — it deprioritized primary constraints
  // like refusalExpected and requiredRegister in the judge's prompt framing.
  const effectiveRubric = scenario.expectation.rubric
    ? (composedRubric ? `${scenario.expectation.rubric}\n\n${composedRubric}` : scenario.expectation.rubric)
    : composedRubric;

  if (effectiveRubric === undefined) {
    return { score: null, rationale: 'no rubric — judge skipped', failed: false, samples: 0 };
  }

  // Delimiters prevent a malicious query or answer from injecting fake scores.
  // The judge sees [USER QUERY START]...[USER QUERY END] as a clear boundary
  // so an attacker-controlled "\nScore: 1.0" inside the query cannot be mistaken
  // for the expected JSON output format.
  const evidenceContractContext = composeJudgeEvidenceContractContext(scenario, evidenceContext);
  const evidenceBlock = evidenceContractContext !== undefined
    ? `
[EVIDENCE CONTRACT CONTEXT START]
${evidenceContractContext}
[EVIDENCE CONTRACT CONTEXT END]
`
    : '';

  const userPrompt = `[USER QUERY START]
${scenario.query}
[USER QUERY END]

Rubric: ${effectiveRubric}
${evidenceBlock}

[AGENT ANSWER START]
${answer}
[AGENT ANSWER END]

Score the answer above against the rubric.`;

  const sampleCount = Math.max(1, Math.floor(samples));
  const results = await Promise.all(
    Array.from({ length: sampleCount }, () => callJudgeOnce(judgeLlm, userPrompt)),
  );

  const successful = results.filter((r): r is { score: number; rationale: string } => r !== null);

  // Strict majority threshold — need >50% successes for a valid sample.
  // Math.floor(N/2)+1 gives strict majority: N=1→1, N=2→2, N=3→2, N=4→3.
  const majorityThreshold = Math.floor(sampleCount / 2) + 1;
  if (successful.length < majorityThreshold) {
    return {
      score: null,
      rationale: `only ${successful.length}/${sampleCount} judge samples succeeded (need ${majorityThreshold})`,
      failed: true,
      samples: sampleCount,
    };
  }

  // Median (robust to outliers). For even-length arrays, average the two middle values.
  const sortedScores = successful.map((r) => r.score).sort((a, b) => a - b);
  const median = computeMedian(sortedScores);

  // Pick the rationale closest to median for human review.
  const closestIdx = successful
    .map((r, i) => ({ idx: i, dist: Math.abs(r.score - median) }))
    .sort((a, b) => a.dist - b.dist)[0]?.idx ?? 0;
  const rationale = successful[closestIdx]?.rationale ?? '';

  return {
    score: median,
    rationale: sampleCount > 1 ? `median of ${successful.length}/${sampleCount}: ${rationale}` : rationale,
    failed: false,
    samples: sampleCount,
  };
}

export function composeJudgeEvidenceContractContext(
  scenario: AgentBenchmarkScenario,
  evidenceContext?: JudgeEvidenceContext,
): string | undefined {
  if (scenario.expectation.exactLookup === undefined) {
    return undefined;
  }
  const observations = evidenceContext?.observations;
  if (observations === undefined || observations.length === 0) {
    return undefined;
  }

  const joined = observations.join('\n');
  const normalized = joined.toLowerCase().normalize('NFKC');
  const status =
    normalized.includes('exact_lookup_confirmed')
      ? 'CONFIRMED'
      : normalized.includes('exact_lookup_negative')
        ? 'NEGATIVE'
        : normalized.includes('resolution_not_confirmed')
          ? 'UNCONFIRMED'
          : normalized.includes('[retrieval_quality: unreliable - 0 results]')
            || normalized.includes('[retrieval_quality: unreliable — 0 results]')
            || normalized.includes('검색 결과가 없습니다')
              ? 'ZERO_RESULTS'
              : 'UNKNOWN';

  const markerLines = joined
    .split('\n')
    .filter((line) =>
      line.includes('EXACT_LOOKUP_CONFIRMED')
      || line.includes('EXACT_LOOKUP_NEGATIVE')
      || line.includes('RESOLUTION_NOT_CONFIRMED')
      || line.includes('[RETRIEVAL_QUALITY:'),
    )
    .slice(0, 4);
  const topResultLines = joined
    .split('\n')
    .filter((line) => /^\d+\.\s/u.test(line.trim()))
    .slice(0, 2);

  const expectation = scenario.expectation.exactLookup;
  const lines = [
    `EXACT_LOOKUP_EVIDENCE_STATUS: ${status}`,
    expectation.expectedEntityId !== undefined
      ? `EXPECTED_ENTITY_ID: ${expectation.expectedEntityId ?? 'null'}`
      : undefined,
    expectation.canonicalEn !== undefined
      ? `EXPECTED_CANONICAL_EN: ${expectation.canonicalEn}`
      : undefined,
    expectation.canonicalKo !== undefined
      ? `EXPECTED_CANONICAL_KO: ${expectation.canonicalKo}`
      : undefined,
    `EXACT_LOOKUP_PHENOMENA: ${expectation.phenomena.join(' | ')}`,
    (expectation.acceptedCanonicalAliases?.length ?? 0) > 0
      ? `ACCEPTED_ALIASES: ${[...new Set(expectation.acceptedCanonicalAliases)].join(' | ')}`
      : undefined,
    ...markerLines.map((line) => `OBSERVATION_MARKER: ${line}`),
    ...topResultLines.map((line) => `TOP_EXACT_LOOKUP_RESULT: ${line.trim()}`),
    status === 'CONFIRMED'
      ? 'JUDGE_RULE: live-evidence confirmation is satisfied for this exact lookup; do not require abstention solely because the rubric mentions abstaining when evidence is absent.'
      : undefined,
    status === 'CONFIRMED'
      ? 'JUDGE_RULE: any accepted alias spelling, including the user query spelling, satisfies Korean transliteration anchoring; do not require a different Korean canonical literal if the answer already uses an accepted alias or the evidence canonical form.'
      : undefined,
    status === 'CONFIRMED'
      ? 'JUDGE_RULE: suffix-noise tokens such as region/country/type/grape/vintage are lookup disambiguation noise and do not need to be repeated in the answer after the base exact entity is confirmed.'
      : undefined,
    status === 'NEGATIVE' || status === 'UNCONFIRMED' || status === 'ZERO_RESULTS'
      ? 'JUDGE_RULE: live evidence did not confirm the exact lookup; honest abstention is expected.'
      : undefined,
  ];

  return lines.filter((line): line is string => line !== undefined && line.trim().length > 0).join('\n');
}

function computeMedian(sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 === 1) {
    return sortedAsc[mid] ?? 0;
  }
  return ((sortedAsc[mid - 1] ?? 0) + (sortedAsc[mid] ?? 0)) / 2;
}

async function callJudgeOnce(
  judgeLlm: ChatLlmPort,
  userPrompt: string,
): Promise<{ score: number; rationale: string } | null> {
  try {
    const result = await judgeLlm.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: 300,
    });
    return parseJudgeResponse(result.text);
  } catch (err) {
    console.error('[judge] callJudgeOnce failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function parseJudgeResponse(text: string): { score: number; rationale: string } | null {
  // Strip code fences (with or without `json` tag), then trim.
  // Earlier regex `/^```json\s*|\s*```$/g` missed bare ``` openers and required
  // an explicit `json` tag — models that emitted plain ``` fences fell through.
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (
      parsed === null
      || typeof parsed !== 'object'
      || !('score' in parsed)
      || !('rationale' in parsed)
    ) {
      return null;
    }
    const obj = parsed as { score: unknown; rationale: unknown };
    if (typeof obj.rationale !== 'string') return null;
    // Accept both number and string-typed scores — some LLM models emit "0.75" instead of 0.75.
    let scoreNum: number;
    if (typeof obj.score === 'number') {
      scoreNum = obj.score;
    } else if (typeof obj.score === 'string') {
      scoreNum = parseFloat(obj.score);
    } else {
      return null;
    }
    if (!Number.isFinite(scoreNum)) return null;
    const clamped = Math.max(0, Math.min(1, scoreNum));
    // Annotate rationale when the judge produced an out-of-range score so a
    // misbehaving judge model is visible in the rationale, not silently clipped.
    const rationale = Math.abs(clamped - scoreNum) > 0.01
      ? `[clamped from ${scoreNum.toFixed(2)}] ${obj.rationale}`
      : obj.rationale;
    return { score: clamped, rationale };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auto-rubric composer
// ─────────────────────────────────────────────────────────────────────

/**
 * Compose a rubric from structured scenario fields. Returns undefined when
 * no structured fields are set (the judge should be skipped entirely).
 *
 * This allows scenarios that specify e.g. `priceBandKrw`, `factCheckClaims`,
 * or `requireHedging` but have no hand-written `rubric` to still activate
 * the judge dimension — auto-composing quality criteria from the structured
 * expectations.
 */
function composeAutoRubric(
  exp: import('./scenario.js').ScenarioExpectation,
): string | undefined {
  const lines: string[] = [];

  if (exp.priceBandKrw !== undefined) {
    const parts: string[] = [];
    if (exp.priceBandKrw.min !== undefined) parts.push(`≥${exp.priceBandKrw.min} KRW`);
    if (exp.priceBandKrw.max !== undefined) parts.push(`≤${exp.priceBandKrw.max} KRW`);
    lines.push(`All recommended wines must be priced ${parts.join(' and ')}.`);
  }

  if (exp.vintageRange !== undefined) {
    const parts: string[] = [];
    if (exp.vintageRange.min !== undefined) parts.push(`${exp.vintageRange.min}`);
    if (exp.vintageRange.max !== undefined) parts.push(`${exp.vintageRange.max}`);
    lines.push(`All mentioned vintages must be in the range ${parts.join('-')}.`);
  }

  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any') {
    // v4: semantic description (no keyword enumeration). Judge evaluates whether
    // the answer correctly conveys the drinking window status — across both
    // English and Korean phrasings — using its own language understanding.
    const statusText: Record<string, string> = {
      now: 'currently at its drinking peak — ready to drink now',
      hold: 'too young, needs further cellaring before peak',
      past: 'past its peak, in decline or no longer recommended for current consumption',
    };
    lines.push(`The answer must communicate that the wine is ${statusText[exp.drinkingWindowStatus] ?? exp.drinkingWindowStatus}. Evaluate the meaning of the answer, not specific keywords.`);
  }

  if (exp.requireHedging === true) {
    // v4: ask the judge for semantic evaluation of epistemic stance, not pattern enumeration.
    // Hedging is about CONFIDENCE expression, not specific tokens — judge handles this holistically.
    lines.push('The answer must express appropriate epistemic uncertainty (hedging) because the query is ambiguous. The answer should NOT make confident assertions; it should acknowledge alternatives, qualify recommendations, or ask for clarification. Evaluate semantically, not by keyword matching.');
  }

  if (exp.requiredRegister === 'formal') {
    // v4: scorer no longer enforces register via regex — judge is the sole evaluator.
    // Ask for holistic semantic judgment, not token enumeration.
    lines.push('The answer must use formal Korean register (polite, professional sommelier-style speech). Evaluate the overall register holistically — do not count individual word patterns.');
  } else if (exp.requiredRegister === 'casual') {
    lines.push('The answer should use casual Korean register (friendly, conversational, informal speech — appropriate for chatting with a friend). Evaluate the overall register holistically — do not count individual word patterns.');
  }

  if (exp.refusalExpected === true) {
    lines.push('The answer must refuse or indicate that the requested item does not exist. Must NOT fabricate availability or details.');
  }

  if (exp.mustCiteFromToolResults === true) {
    lines.push('Every wine mentioned in the answer must have appeared in the search tool results. No fabricated wine names.');
  }

  if (exp.factCheckClaims !== undefined && exp.factCheckClaims.length > 0) {
    for (const claim of exp.factCheckClaims) {
      lines.push(`Fact check: "${claim.claim}" — must be ${claim.mustBeTrue ? 'TRUE' : 'FALSE'} in the answer.`);
    }
  }

  if (exp.maxConfidence !== undefined) {
    lines.push(`Confidence level must not exceed ${(exp.maxConfidence * 100).toFixed(0)}%. The answer should use hedging language and qualify assertions rather than being overconfident.`);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// RAGAS Faithfulness Judge
// ─────────────────────────────────────────────────────────────────────

const FAITHFULNESS_SYSTEM_PROMPT = `You are a faithfulness evaluator using NLI-style atomic claim verification with GRADED SUPPORT.

## Evaluation Process (follow exactly)
1. DECOMPOSE the answer into atomic factual claims. Examples of claims:
   - "Château Margaux is a Bordeaux wine" (wine name + region)
   - "It costs around 50,000원" (price)
   - "2018 vintage" (vintage year)
   - "Cabernet Sauvignon blend" (grape variety)
   - "Pairs well with steak" (pairing recommendation)
2. For EACH claim, classify against the context using FOUR levels (graded support):
   - FULLY_SUPPORTED: every element of the claim is directly supported by the context.
   - PARTIALLY_SUPPORTED: the core ENTITY of the claim is in context, but one or
     more peripheral elements (vintage qualifier, region adjective, price tier,
     pairing) are NOT explicitly in context yet do NOT contradict it.
     Example: context has "Château Margaux 2015"; answer says "Château Margaux
     2015, a structured wine that ages well". The aging claim is not in context
     but the entity+vintage is — PARTIALLY_SUPPORTED, not contradicted.
   - NEUTRAL: claim cannot be verified from context (not contradicted either).
     Generic wine-education statements or non-factual stylistic commentary fall here.
   - CONTRADICTED: claim directly contradicts a specific fact in the context, OR
     names a wine/region/vintage entirely absent from the context (fabrication).
3. Score formula (partial-credit RAGAS):
     score = (fully + ${LLM_PARTIAL_CLAIM_CREDIT} * partial) / (fully + partial + contradicted)
   Neutral claims are EXCLUDED from the denominator. If the answer contains no
   verifiable factual claims (all neutral), score 1.0.

## What IS vs IS NOT a faithfulness violation (critical — read carefully)
A faithfulness violation requires a SPECIFIC fabricated fact. Distinguish:

(a) UNGROUNDED CLAIM (= violation, CONTRADICTED): a specific wine name, region,
    vintage year, price, grape, or producer stated in the answer that is ABSENT
    from (or directly contradicts) the provided context. Example: answer
    recommends "Opus One 2015" but the context only contains "Château Margaux" —
    "Opus One" is fabricated. CONTRADICTED.

(b) PARTIAL SUPPORT (= half-violation, PARTIALLY_SUPPORTED): the entity is
    grounded but a peripheral detail isn't. Example: context has "Château Margaux"
    (no vintage); answer says "Château Margaux 2015" — the entity is grounded,
    the vintage is not in context but does not contradict any grounded vintage.
    PARTIALLY_SUPPORTED, not CONTRADICTED.

(c) REASONABLE SYNTHESIS (= NOT a violation, FULLY_SUPPORTED): summarization,
    comparison, ranking, hedged or qualified language, generic wine education, or
    paraphrase that stays WITHIN the grounded facts. The answer is allowed to:
      - summarize ("these are full-bodied reds")
      - compare grounded wines ("A is richer than B")
      - hedge ("this may pair well with steak")
      - reformat names across scripts/transliterations (Korean ↔ Latin spelling of
        the SAME grounded wine is NOT a new claim — e.g. "샤또 마고" and "Château
        Margaux" are the same entity)
      - omit detail or speak generally
    None of these are violations. Do NOT penalize an answer for being a fluent
    summary of grounded facts. Do NOT mark a claim CONTRADICTED merely because the
    exact words differ from the context — only when the FACT differs.

## Few-shot anchors
Anchor 1 — GROUNDED (score 1.00, all fully supported):
  Context: [Tool Result 1]: GROUNDING_JSON: {"wines":[{"canonical_label":"Château Margaux","region":"Bordeaux","vintage_year":2015}]}
  Answer: "보르도의 샤또 마고 2015를 추천드립니다. 풀바디 레드로 스테이크와 잘 어울려요."
  → "샤또 마고" = "Château Margaux" (same entity, transliteration), region Bordeaux, vintage 2015 — all fully supported.
    Pairing is reasonable synthesis (fully_supported). claims_breakdown: 3 fully, 0 partial, 0 contradicted. score 1.00.

Anchor 2 — PARTIAL (score 0.75, mix of fully and partial):
  Context: [Tool Result 1]: GROUNDING_JSON: {"wines":[{"canonical_label":"Opus One","region":"Napa Valley","vintage_year":2018}]}
  Answer: "Opus One 2018, Napa Valley의 풀바디 카베르네 블렌드. 다크 베리와 시더 노트가 어우러집니다."
  → Entity, vintage, region all fully supported (3 fully). Cabernet blend + tasting notes are PARTIALLY_SUPPORTED (entity-grounded; specific grapes/notes not in context). claims_breakdown: 3 fully, 2 partial, 0 contradicted. score = (3 + 0.5*2) / 5 = 0.80.

Anchor 3 — HALLUCINATED (score 0.00, all contradicted):
  Context: [Tool Result 1]: GROUNDING_JSON: {"wines":[{"canonical_label":"Château Margaux","region":"Bordeaux","vintage_year":2015}]}
  Answer: "Opus One 2018, 캘리포니아 나파 밸리의 와인을 추천드립니다."
  → "Opus One", "2018", "Napa Valley" are ALL absent from context — fabricated entity. claims_breakdown: 0 fully, 0 partial, 3 contradicted. score 0.00.

Ignore stylistic/opinion statements — only evaluate factual claims about wines (names, prices, regions, vintages, grapes, tasting notes).

## Output (strict JSON)
{
  "score": 0.0,
  "rationale": "N claims: F fully, P partial, C contradicted, U neutral. [brief explanation]",
  "claims_breakdown": {
    "fully_supported": 0,
    "partially_supported": 0,
    "contradicted": 0,
    "neutral": 0
  }
}
Output ONLY the JSON. No markdown. The "claims_breakdown" object is REQUIRED — when omitted, downstream tooling derives score from the breakdown and may overrule a hand-typed score.`;

/**
 * RAGAS-style faithfulness evaluation via LLM judge.
 *
 * Scores how well the agent's answer is grounded in the tool results
 * (observations). Returns null when no observations exist (no context
 * to ground against) or when the LLM call fails.
 *
 * This is conceptually distinct from answer quality (rubric satisfaction):
 * an answer can be high-quality but unfaithful (hallucinated details that
 * happen to be correct), or faithful but low-quality (accurate but
 * unhelpful).
 */
/**
 * Parse the faithfulness judge response with graded-support semantics.
 *
 * Accepts THREE shapes (back-compat → preferred):
 *   1. Bare numeric score: `{"score": 0.75, "rationale": "..."}`
 *      Used unchanged. Maintains compatibility with the previous binary prompt.
 *   2. Graded counts only: `{"rationale":"...","claims_breakdown":{...}}`
 *      Score is synthesized from counts using `LLM_PARTIAL_CLAIM_CREDIT`.
 *   3. Both score AND graded counts: the counts AUTHORITATIVELY recompute the
 *      score using the partial-credit formula. This prevents a model that
 *      emits e.g. `{"score": 0.0, "claims_breakdown":{fully:1,partial:2,contradicted:0}}`
 *      (incoherent — should be 0.67 not 0.0) from over-strictly scoring an
 *      answer it correctly decomposed.
 *
 * All-neutral breakdowns (no verifiable claims) score 1.0 per RAGAS convention.
 *
 * Returns `null` on parse failure — caller falls to score=null which the scorer
 * null-drops from geo-mean.
 */
function parseFaithfulnessResponse(text: string): { score: number; rationale: string } | null {
  // Strip code fences identically to the rubric judge.
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { score?: unknown; rationale?: unknown; claims_breakdown?: unknown };
  if (typeof obj.rationale !== 'string') return null;

  // (a) Extract graded counts if present.
  // `neutral` is deliberately NOT read: per RAGAS, neutral claims are excluded
  // from the score denominator entirely, so its count never affects the result.
  let fully: number | undefined;
  let partial: number | undefined;
  let contradicted: number | undefined;
  if (obj.claims_breakdown !== null && typeof obj.claims_breakdown === 'object') {
    const cb = obj.claims_breakdown as Record<string, unknown>;
    const readCount = (key: string): number | undefined => {
      const v = cb[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
      if (typeof v === 'string') {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
      return undefined;
    };
    fully = readCount('fully_supported');
    partial = readCount('partially_supported');
    contradicted = readCount('contradicted');
  }

  // (b) Read raw score if present (number or string).
  let rawScore: number | undefined;
  if (typeof obj.score === 'number') {
    rawScore = obj.score;
  } else if (typeof obj.score === 'string') {
    const n = parseFloat(obj.score);
    if (Number.isFinite(n)) rawScore = n;
  }

  // (c) If graded counts are well-formed, the counts are authoritative.
  //     Compute partial-credit score from counts.
  const hasCounts =
    fully !== undefined
    && partial !== undefined
    && contradicted !== undefined;

  let finalScore: number | undefined;
  if (hasCounts) {
    const f = fully ?? 0;
    const p = partial ?? 0;
    const c = contradicted ?? 0;
    const denominator = f + p + c;
    if (denominator === 0) {
      // No verifiable claims (all neutral or empty) — RAGAS convention: 1.0.
      finalScore = 1.0;
    } else {
      finalScore = (f + LLM_PARTIAL_CLAIM_CREDIT * p) / denominator;
    }
  } else if (rawScore !== undefined && Number.isFinite(rawScore)) {
    finalScore = rawScore;
  }

  if (finalScore === undefined || !Number.isFinite(finalScore)) return null;
  const clamped = Math.max(0, Math.min(1, finalScore));
  const rationale = Math.abs(clamped - finalScore) > 0.01
    ? `[clamped from ${finalScore.toFixed(2)}] ${obj.rationale}`
    : obj.rationale;
  return { score: clamped, rationale };
}

/**
 * v4: judgeFaithfulness now supports N-sample median voting, matching judgeAnswerN.
 * Single-sample faithfulness had ~3x higher variance than N=3 answer judge — a
 * single LLM hallucination could swing the score by 0.5+ for one scenario,
 * shifting aggregate by 1-2% over a full benchmark run.
 *
 * Default samples=1 for back-compat; runner passes args.judgeSamples for parity.
 */
async function judgeFaithfulness(
  judgeLlm: ChatLlmPort,
  answer: string,
  observations: readonly string[],
  samples: number = 1,
): Promise<JudgeResult> {
  if (observations.length === 0 || answer.trim().length === 0) {
    return { score: null, rationale: 'no context to evaluate faithfulness', failed: false, samples: 0 };
  }

  const contextText = observations
    .map((obs, i) => `[Tool Result ${i + 1}]: ${obs}`)
    .join('\n\n');

  const userPrompt = `Context (tool results the agent received):
${contextText}

Agent answer:
${answer}

Score the faithfulness of the answer against the context.`;

  const sampleCount = Math.max(1, Math.floor(samples));
  const callOnce = async (): Promise<{ score: number; rationale: string } | null> => {
    try {
      const result = await judgeLlm.complete({
        messages: [
          { role: 'system', content: FAITHFULNESS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: JUDGE_TEMPERATURE,
        maxOutputTokens: 300,
      });
      return parseFaithfulnessResponse(result.text);
    } catch {
      return null;
    }
  };

  const results = await Promise.all(Array.from({ length: sampleCount }, () => callOnce()));
  const successful = results.filter((r): r is { score: number; rationale: string } => r !== null);

  const majorityThreshold = Math.floor(sampleCount / 2) + 1;
  if (successful.length < majorityThreshold) {
    return {
      score: null,
      rationale: `only ${successful.length}/${sampleCount} faithfulness samples succeeded (need ${majorityThreshold})`,
      failed: true,
      samples: sampleCount,
    };
  }

  const sortedScores = successful.map((r) => r.score).sort((a, b) => a - b);
  const median = computeMedian(sortedScores);
  const closestIdx = successful
    .map((r, i) => ({ idx: i, dist: Math.abs(r.score - median) }))
    .sort((a, b) => a.dist - b.dist)[0]?.idx ?? 0;
  const rationale = successful[closestIdx]?.rationale ?? '';

  return {
    score: median,
    rationale: sampleCount > 1 ? `median of ${successful.length}/${sampleCount}: ${rationale}` : rationale,
    failed: false,
    samples: sampleCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Hybrid deterministic-first faithfulness (FIX 1)
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract candidate label-shaped citations from the answer for the deterministic
 * verifier's label-citation check.
 *
 * We do NOT run an NER — instead we surface the grounded canonical labels that
 * literally appear in the normalized answer text. This is deliberately
 * false-positive-free: a grounded label found in the answer is, by construction,
 * a grounded claim, and the verifier will confirm it via `exact_nfc_lower` /
 * `compound_subsumed_by_label`. The verifier's prose-vintage loop (loop 2) runs
 * regardless of citations and is what catches fabricated vintage years.
 *
 * The net effect: the deterministic verdict is SOUND for "all extractable claims
 * grounded" (it never falsely reports an answer as fully grounded — an
 * un-extractable hallucinated name simply leaves the verdict to the LLM judge),
 * which is exactly the authoritative direction this fix needs.
 */
function extractGroundedLabelCitations(answer: string, facts: GroundingFacts): readonly string[] {
  if (facts.labels.size === 0) return [];
  const normalizedAnswer = normalizeClaimSurface(answer);
  const citations: string[] = [];
  for (const label of facts.labels) {
    if (label.length === 0) continue;
    if (normalizedAnswer.includes(label)) {
      citations.push(label);
    }
  }
  return citations;
}

/**
 * Hybrid deterministic-first faithfulness scoring.
 *
 * Order of authority:
 *   1. Build `GroundingFacts` from the agent's typed tool outcomes (the same
 *      structural grounding the synthesis runtime uses). If there are NO facts
 *      (no GROUNDING_JSON envelopes / structured wine records), the deterministic
 *      signal is unavailable → fall straight to the LLM judge (`source: 'llm'`).
 *   2. Run the deterministic `verifyAnswerGrounding`. If it reports the answer
 *      fully grounded → `score = 1.0` DETERMINISTICALLY (`source: 'deterministic'`),
 *      skipping the LLM judge. The structural matcher is authoritative for
 *      "are the cited entities + asserted vintages present in grounding" and is
 *      not subject to the LLM judge's false-negative over-strictness (the bug:
 *      `judge=1.00 faith=0.00`).
 *   3. If the deterministic verifier finds PARTIAL coverage (some label
 *      citations grounded, some not), `deterministicScore` is set to the
 *      COVERAGE FRACTION (grounded / (grounded + ungrounded label-citations)).
 *      We then take `score = max(deterministicCoverage, llmScore)` so an
 *      over-strict LLM cannot drag a 67%-grounded answer to 0.0. The floor is
 *      precision-justified: every claim in the numerator was matched by an
 *      explicit deterministic rule (exact / transliteration / vintage-field /
 *      compound subsumption), so false positives are impossible by construction.
 *   4. When there are NO grounding facts at all, the LLM is the sole signal and
 *      no floor is applied — `faithfulnessSource = 'llm'`.
 *
 * `faithDisagreement` is true when deterministic and LLM both have a value and
 * differ by > 0.5 — computed against the RAW signals, not the floored score.
 */
export async function judgeFaithfulnessHybrid(
  judgeLlm: ChatLlmPort,
  answer: string,
  observations: readonly string[],
  toolOutcomes: readonly ToolOutcome[],
  samples: number = 1,
): Promise<FaithfulnessResult> {
  if (observations.length === 0 || answer.trim().length === 0) {
    return {
      score: null,
      rationale: 'no context to evaluate faithfulness',
      failed: false,
      samples: 0,
      faithfulnessSource: 'llm',
      deterministicScore: null,
      llmScore: null,
      faithDisagreement: false,
      ungroundedClaims: [],
    };
  }

  const facts = collectGroundingFacts(toolOutcomes);

  // Step 1 — deterministic verdict (only when grounding facts exist).
  let deterministicScore: number | null = null;
  let ungroundedClaims: readonly string[] = [];
  let citationCount = 0;
  let groundedCitationCount = 0;
  if (facts.hasAnyFact) {
    const citations = extractGroundedLabelCitations(answer, facts);
    const verify = verifyAnswerGrounding(answer, citations, facts);
    ungroundedClaims = verify.ungroundedClaims;

    // Compute partial coverage. The verifier's trace covers label-shaped
    // citations only; ungroundedClaims may also include prose vintages that
    // were not part of any traced label. The denominator is
    //   (matched label-claims) + (ungrounded claims of any kind)
    // i.e. the total set of extractable claims attempted. This is precise:
    // every matched claim was confirmed by a named rule, every ungrounded
    // claim was actively rejected.
    const matchedLabelClaims = verify.trace.filter((t) => t.matchedRule !== null).length;
    const ungroundedCount = verify.ungroundedClaims.length;
    citationCount = matchedLabelClaims + ungroundedCount;
    groundedCitationCount = matchedLabelClaims;

    if (verify.grounded) {
      deterministicScore = 1.0;
    } else if (citationCount > 0) {
      // Partial coverage. Coverage fraction = matched / total claim attempts.
      deterministicScore = groundedCitationCount / citationCount;
    } else {
      // Verifier found ungrounded claims but trace count + ungrounded count
      // both zero — defensive: treat as 0.0 (cannot happen given the prior
      // `verify.grounded` short-circuit, but keep the type total).
      deterministicScore = 0.0;
    }

    // Step 2 — authoritative shortcut: all extractable claims grounded.
    if (verify.grounded) {
      return {
        score: 1.0,
        rationale: 'deterministic: all extractable claims grounded (label citations + asserted vintages present in grounding)',
        failed: false,
        samples: 0,
        faithfulnessSource: 'deterministic',
        deterministicScore: 1.0,
        llmScore: null,
        faithDisagreement: false,
        ungroundedClaims: [],
      };
    }
  }

  // Step 3 — fall to LLM judge (either no facts, or deterministic found ungrounded claims).
  const llm = await judgeFaithfulness(judgeLlm, answer, observations, samples);
  const llmScore = llm.score;

  // Disagreement is computed against the RAW signals.
  const faithDisagreement =
    deterministicScore !== null
    && llmScore !== null
    && Math.abs(deterministicScore - llmScore) > FAITH_DISAGREEMENT_THRESHOLD;

  // When there were no grounding facts, the LLM is the sole signal.
  if (deterministicScore === null) {
    return {
      ...llm,
      faithfulnessSource: 'llm',
      deterministicScore: null,
      llmScore,
      faithDisagreement: false,
      ungroundedClaims: [],
    };
  }

  // Hybrid: deterministic coverage acts as a FLOOR on the final score.
  // - When det=0 (no grounded claims), floor is 0 → LLM is the sole signal
  //   (no whitewashing of fully hallucinated answers).
  // - When det>0 (partial coverage), the LLM cannot push below the floor —
  //   each grounded claim is structurally confirmed and immune to LLM
  //   over-strictness.
  // - When det=1 the deterministic shortcut already returned above.
  const floor = deterministicScore;
  const finalScore = llmScore !== null ? Math.max(floor, llmScore) : floor;
  const ungroundedNote =
    ungroundedClaims.length > 0
      ? ` deterministic flagged ${ungroundedClaims.length} ungrounded: ${ungroundedClaims.slice(0, 3).join(', ')}.`
      : '';
  return {
    score: finalScore,
    rationale: `hybrid (det=${floor.toFixed(2)}, llm=${llmScore !== null ? llmScore.toFixed(2) : 'null'}, floor=${floor.toFixed(2)}):${ungroundedNote} ${llm.rationale}`.trim(),
    failed: llm.failed,
    samples: llm.samples,
    faithfulnessSource: 'hybrid',
    deterministicScore,
    llmScore,
    faithDisagreement,
    ungroundedClaims,
  };
}
