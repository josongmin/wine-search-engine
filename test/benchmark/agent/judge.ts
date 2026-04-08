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
  const effectiveRubric = scenario.expectation.rubric
    ? (composedRubric ? `${scenario.expectation.rubric}\n\nAdditional checks:\n${composedRubric}` : scenario.expectation.rubric)
    : composedRubric;

  if (effectiveRubric === undefined) {
    return { score: null, rationale: 'no rubric — judge skipped', failed: false, samples: 0 };
  }

  const userPrompt = `Query: ${scenario.query}

Rubric: ${effectiveRubric}

Agent answer:
${answer}

Score this answer.`;

  const sampleCount = Math.max(1, Math.floor(samples));
  const results = await Promise.all(
    Array.from({ length: sampleCount }, () => callJudgeOnce(judgeLlm, userPrompt)),
  );

  const successful = results.filter((r): r is { score: number; rationale: string } => r !== null);

  // Majority threshold — need at least ⌈N/2⌉ successes for a valid sample.
  const majorityThreshold = Math.ceil(sampleCount / 2);
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
    if (typeof obj.score !== 'number' || typeof obj.rationale !== 'string') {
      return null;
    }
    if (!Number.isFinite(obj.score)) return null;
    const clamped = Math.max(0, Math.min(1, obj.score));
    // Annotate rationale when the judge produced an out-of-range score so a
    // misbehaving judge model is visible in the rationale, not silently clipped.
    const rationale = Math.abs(clamped - obj.score) > 0.01
      ? `[clamped from ${obj.score.toFixed(2)}] ${obj.rationale}`
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
    if (exp.priceBandKrw.min !== undefined) parts.push(`≥${exp.priceBandKrw.min.toLocaleString()} KRW`);
    if (exp.priceBandKrw.max !== undefined) parts.push(`≤${exp.priceBandKrw.max.toLocaleString()} KRW`);
    lines.push(`All recommended wines must be priced ${parts.join(' and ')}.`);
  }

  if (exp.vintageRange !== undefined) {
    const parts: string[] = [];
    if (exp.vintageRange.min !== undefined) parts.push(`${exp.vintageRange.min}`);
    if (exp.vintageRange.max !== undefined) parts.push(`${exp.vintageRange.max}`);
    lines.push(`All mentioned vintages must be in the range ${parts.join('-')}.`);
  }

  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any') {
    const statusText: Record<string, string> = {
      now: 'currently drinkable / at peak',
      hold: 'needs further aging / too young',
      past: 'past peak / over the hill',
    };
    lines.push(`The answer must indicate that the wine is ${statusText[exp.drinkingWindowStatus] ?? exp.drinkingWindowStatus}.`);
  }

  if (exp.requireHedging === true) {
    lines.push('The answer must use hedging language (maybe, perhaps, several candidates) because the query is ambiguous.');
  }

  if (exp.requiredRegister === 'formal') {
    lines.push('The answer must use formal Korean register (합니다/습니다 endings).');
  } else if (exp.requiredRegister === 'casual') {
    lines.push('The answer may use casual Korean register (해/야/거 endings).');
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

  if (exp.maxConfidence !== undefined && exp.maxConfidence < 0.5) {
    lines.push('The answer must NOT be overconfident. Hedging or listing multiple options is preferred.');
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}
