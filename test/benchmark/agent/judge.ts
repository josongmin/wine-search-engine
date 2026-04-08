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
 * Judge with N samples + median voting. Higher N reduces variance at linear
 * cost. Failures within the sample group are filtered out — if all N fail,
 * the result is `{score: null, failed: true}`.
 */
export async function judgeAnswerN(
  judgeLlm: ChatLlmPort,
  scenario: AgentBenchmarkScenario,
  answer: string,
  samples: number,
): Promise<JudgeResult> {
  if (scenario.expectation.rubric === undefined) {
    return { score: null, rationale: 'no rubric — judge skipped', failed: false, samples: 0 };
  }

  const userPrompt = `Query: ${scenario.query}

Rubric: ${scenario.expectation.rubric}

Agent answer:
${answer}

Score this answer.`;

  // Run N samples in parallel.
  const sampleCount = Math.max(1, Math.floor(samples));
  const results = await Promise.all(
    Array.from({ length: sampleCount }, () => callJudgeOnce(judgeLlm, userPrompt)),
  );

  const successful = results.filter((r): r is { score: number; rationale: string } => r !== null);
  if (successful.length === 0) {
    return {
      score: null,
      rationale: 'all judge samples failed',
      failed: true,
      samples: sampleCount,
    };
  }

  // Median across successful samples (more robust than mean to outliers).
  const sortedScores = successful.map((r) => r.score).sort((a, b) => a - b);
  const median = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;
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
  // Strip code fences if present.
  const cleaned = text.trim().replace(/^```json\s*|\s*```$/g, '').trim();
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
    return {
      score: Math.max(0, Math.min(1, obj.score)),
      rationale: obj.rationale,
    };
  } catch {
    return null;
  }
}
