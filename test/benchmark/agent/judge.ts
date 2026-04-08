/**
 * LLM-as-judge for benchmark answer quality (SOTA++ v2).
 *
 * Uses a separate (cheaper) model to evaluate whether the agent's answer
 * satisfies the scenario's free-form rubric. Returns a 0..1 median score
 * across N samples to reduce LLM variance.
 *
 * The judge is intentionally STATELESS and DETERMINISTIC: temperature 0,
 * single-shot prompt with strict JSON output. Failures return `score: null`
 * so the scorer DROPS the judge dimension from the geometric mean (no
 * inflation, no false penalty).
 *
 * Variance handling: judgeAnswerN(N) calls the judge N times and takes the
 * median. Default N=1 for cost; runner can pass N=3 for high-confidence runs.
 */

import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import type { AgentBenchmarkScenario } from './scenario.js';

export interface JudgeResult {
  /** 0..1 score, or null when judge could not be evaluated (parse fail / API error / no rubric). */
  readonly score: number | null;
  readonly rationale: string;
  readonly failed: boolean;
  /** Number of samples taken (for diagnostic). */
  readonly samples: number;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a wine search engine's agent responses. \
Given a user query, the agent's answer, and a rubric, score how well the answer satisfies the rubric.

Output STRICTLY a single JSON object on one line:
{"score": 0.0, "rationale": "one-sentence reason"}

Score scale:
  1.00 — fully satisfies the rubric, factually correct, complete
  0.75 — mostly satisfies, minor gaps
  0.50 — partially satisfies, significant gaps
  0.25 — barely satisfies, major issues
  0.00 — does not satisfy or hallucinates

Output ONLY the JSON. No markdown, no preamble, no trailing commentary.`;

export async function judgeAnswer(
  judgeLlm: ChatLlmPort,
  scenario: AgentBenchmarkScenario,
  answer: string,
): Promise<JudgeResult> {
  return judgeAnswerN(judgeLlm, scenario, answer, 1);
}

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
  const userPrompt = `[USER QUERY START]
${scenario.query}
[USER QUERY END]

Rubric: ${effectiveRubric}

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
      temperature: 0,
      maxOutputTokens: 200,
    });
    return parseJudgeResponse(result.text);
  } catch {
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
    // v4: bilingual status descriptions matching scorer.ts keyword patterns
    const statusText: Record<string, string> = {
      now: 'currently drinkable / at peak (Korean: 마시기 좋, 음용 적기, 최적, 피크, 지금)',
      hold: 'needs further aging / too young (Korean: 숙성, 보관, 셀러, 더 기다, 음용 전, 아직, 이르)',
      past: 'past peak / over the hill (Korean: 지남, 지났, 과거)',
    };
    lines.push(`The answer must indicate that the wine is ${statusText[exp.drinkingWindowStatus] ?? exp.drinkingWindowStatus}.`);
  }

  if (exp.requireHedging === true) {
    // v4: bilingual hedging markers matching scorer.ts v4 regex
    lines.push(
      'The answer must use hedging language because the query is ambiguous. ' +
      'Korean hedging markers: 아마도, 어쩌면, 혹시, ~수도 있, ~을 수 있, ~일 수 있, 여러 후보. ' +
      'English: maybe, perhaps, might, could be, it seems, several candidates.',
    );
  }

  if (exp.requiredRegister === 'formal') {
    lines.push('The answer must use formal Korean register (합니다/습니다/드립니다/하세요/겠습니다 endings).');
  } else if (exp.requiredRegister === 'casual') {
    // v4: synced with scorer.ts v4 casual markers (multi-char patterns, not 1-char 해/야/거)
    lines.push(
      'The answer may use casual Korean register. ' +
      'Casual markers: 줄게, 건데, 잖아, 거든, 할게, 할래, 해줘, 해봐, 먹자, 가자, 하자, 인데, 거야, 잖아요. ' +
      'Formal markers (합니다, 습니다, 드립니다, 하세요, 겠습니다) should be absent or rare.',
    );
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

const FAITHFULNESS_SYSTEM_PROMPT = `You are a faithfulness evaluator. Given an agent's answer and the tool results (context) it received, score how well the answer's factual claims are grounded in the context.

Output STRICTLY a single JSON object:
{"score": 0.0, "rationale": "one-sentence reason"}

Score = (number of answer claims supported by context) / (total factual claims in answer).
- 1.00: every factual claim in the answer is supported by the context
- 0.75: most claims supported, minor unsupported details
- 0.50: about half the claims are unsupported or fabricated
- 0.25: mostly fabricated, few claims match context
- 0.00: completely fabricated, no grounding in context

Ignore stylistic/opinion statements — only evaluate factual claims (wine names, prices, regions, vintages, scores, tasting notes).
Output ONLY the JSON.`;

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
 * v4: judgeFaithfulness now supports N-sample median voting, matching judgeAnswerN.
 * Single-sample faithfulness had ~3x higher variance than N=3 answer judge — a
 * single LLM hallucination could swing the score by 0.5+ for one scenario,
 * shifting aggregate by 1-2% over a full benchmark run.
 *
 * Default samples=1 for back-compat; runner passes args.judgeSamples for parity.
 */
export async function judgeFaithfulness(
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
        temperature: 0,
        maxOutputTokens: 200,
      });
      return parseJudgeResponse(result.text);
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
