/**
 * L3 — Hybrid faithfulness CALIBRATION regression (append-only).
 *
 * Pins the calibrated `judgeFaithfulnessHybrid` behavior introduced to reduce
 * LLM-judge over-strictness false negatives (`faith=0.00[l]` and `faith=0.00[h]`
 * cases that pull bench geo-mean down across many otherwise-passing scenarios).
 *
 * Three structural calibration paths are pinned here:
 *
 *   1. PARTIAL-CREDIT LLM parser (Option B): when the LLM emits a graded
 *      atomic-claim breakdown (`fully_supported`, `partially_supported`,
 *      `contradicted`, `neutral`), the parser computes a weighted score using a
 *      named constant `LLM_PARTIAL_CLAIM_CREDIT`. A claim that is partially
 *      supported (e.g. label entailed but vintage not specified in evidence) no
 *      longer gets zero credit.
 *
 *   2. DETERMINISTIC PARTIAL-COVERAGE FLOOR (Option C): when the deterministic
 *      verifier finds SOME but not all extractable claims grounded, the
 *      deterministicScore is set to the COVERAGE FRACTION (grounded /
 *      grounded+ungrounded) — not binary 0.0. The hybrid path then uses
 *      `max(deterministicCoverage, llmScore)` as the floor so an over-strict
 *      LLM cannot drop a 67%-grounded answer to 0.0.
 *
 *   3. NEGATIVE GUARD: a fully ungrounded answer (no claims grounded) still
 *      yields a 0.0 floor (so adding the floor does not whitewash hallucinations).
 *
 * These tests use a deterministic fake LLM so they assert MEASUREMENT logic, not
 * a real model's behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  judgeFaithfulnessHybrid,
  type FaithfulnessResult,
} from '../benchmark/agent/judge.js';
import type {
  ChatLlmPort,
  ChatCompletionRequest,
  ChatCompletionResult,
} from '../../src/domain/ai/port/chat-llm.port.js';
import type { ToolOutcome } from '../../src/domain/agent/model/tool-outcome.js';

/** Build a fake LLM that returns a fixed JSON payload (string). */
function makeFakeWithRawText(text: string): ChatLlmPort {
  return {
    complete(_req: ChatCompletionRequest): Promise<ChatCompletionResult> {
      return Promise.resolve({ text, model: 'fake', finishReason: 'stop' });
    },
  };
}

/** Build a fake LLM that returns a fixed numeric score. */
function makeFakeScoring(score: number, rationale = 'fake'): ChatLlmPort {
  return makeFakeWithRawText(JSON.stringify({ score, rationale }));
}

function groundingOutcome(wines: ReadonlyArray<Record<string, unknown>>): ToolOutcome {
  const envelope = `검색 결과입니다.\nGROUNDING_JSON: ${JSON.stringify({ queryType: 'search', wines })}`;
  return {
    stepId: 'step-0:0',
    tool: 'search_wines',
    kind: 'success',
    result: envelope,
    durationMs: 10,
  };
}

function observationFor(outcome: ToolOutcome): string {
  return typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result);
}

const MARGAUX = {
  canonical_label: 'Château Margaux',
  region: 'Bordeaux',
  grapes: ['Cabernet Sauvignon'],
  vintage_year: 2015,
  price: '1,200,000원',
};

const OPUS_ONE = {
  canonical_label: 'Opus One',
  region: 'Napa Valley',
  grapes: ['Cabernet Sauvignon'],
  vintage_year: 2018,
  price: '650,000원',
};

const ALMAVIVA = {
  canonical_label: 'Almaviva',
  region: 'Puente Alto',
  grapes: ['Cabernet Sauvignon'],
  vintage_year: 2019,
  price: '350,000원',
};

// ─────────────────────────────────────────────────────────────────────
// Option B — partial-credit LLM parser
// ─────────────────────────────────────────────────────────────────────

describe('LLM partial-credit parser (graded support)', () => {
  it('graded breakdown with partially_supported claims yields > 0 score (not collapsed to 0)', async () => {
    // No grounding facts → source='llm', LLM is the sole signal.
    // LLM returns a graded breakdown: 1 fully supported, 2 partially supported,
    // 0 contradicted. Under binary entailed/contradicted scoring the answer
    // would have collapsed to 0 (the bug). Under partial credit (0.5 per
    // partial claim), score = (1*1 + 0.5*2) / (1+2+0) = 2/3 ≈ 0.67.
    const outcome: ToolOutcome = {
      stepId: 'step-0:0',
      tool: 'search_wines',
      kind: 'success',
      result: '검색 수행됨. (no GROUNDING_JSON envelope here.)',
      durationMs: 5,
    };
    const judge = makeFakeWithRawText(
      JSON.stringify({
        score: 0.67,
        rationale: '1 fully, 2 partial, 0 contradicted',
        claims_breakdown: {
          fully_supported: 1,
          partially_supported: 2,
          contradicted: 0,
          neutral: 0,
        },
      }),
    );
    const r = await judgeFaithfulnessHybrid(
      judge,
      'Opus One 2018, Almaviva 2019 두 와인 모두 추천드립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.faithfulnessSource).toBe('llm');
    // Score is the raw LLM-emitted score (judge model already calibrated).
    // What we pin is that we ACCEPT graded counts without rejection.
    expect(r.score).not.toBeNull();
    expect((r.score ?? 0)).toBeGreaterThanOrEqual(0.5);
  });

  it('when LLM omits score field but emits graded counts, parser computes score from counts', async () => {
    // The graded prompt asks the LLM to return BOTH `score` and a breakdown,
    // but a budget-limited model may emit only the breakdown. The parser must
    // synthesize a score from counts using LLM_PARTIAL_CLAIM_CREDIT = 0.5.
    // 2 fully + 2 partial + 0 contradicted → (2 + 0.5*2) / 4 = 0.75
    const outcome: ToolOutcome = {
      stepId: 'step-0:0',
      tool: 'search_wines',
      kind: 'success',
      result: '검색 수행됨. (no GROUNDING_JSON envelope here.)',
      durationMs: 5,
    };
    const judge = makeFakeWithRawText(
      JSON.stringify({
        rationale: '2 fully, 2 partial, 0 contradicted',
        claims_breakdown: {
          fully_supported: 2,
          partially_supported: 2,
          contradicted: 0,
          neutral: 0,
        },
      }),
    );
    const r = await judgeFaithfulnessHybrid(
      judge,
      'Opus One 2018, Almaviva 2019, 두 와인 모두 보르도풍 풀바디 레드입니다.',
      [observationFor(outcome)],
      [outcome],
    );
    // (2 + 0.5*2) / (2+2+0) = 0.75
    expect(r.score).not.toBeNull();
    expect(r.score ?? -1).toBeCloseTo(0.75, 5);
  });

  it('all-contradicted graded breakdown stays at 0 (no whitewashing)', async () => {
    const outcome: ToolOutcome = {
      stepId: 'step-0:0',
      tool: 'search_wines',
      kind: 'success',
      result: '검색 수행됨. (no GROUNDING_JSON envelope here.)',
      durationMs: 5,
    };
    const judge = makeFakeWithRawText(
      JSON.stringify({
        rationale: '0 fully, 0 partial, 3 contradicted',
        claims_breakdown: {
          fully_supported: 0,
          partially_supported: 0,
          contradicted: 3,
          neutral: 0,
        },
      }),
    );
    const r = await judgeFaithfulnessHybrid(
      judge,
      '완전히 허위 사실입니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.score).toBe(0);
  });

  it('all-neutral breakdown (no verifiable claims) scores 1.0 — RAGAS convention', async () => {
    // RAGAS: if no verifiable factual claims exist (only stylistic prose), score 1.0.
    const outcome: ToolOutcome = {
      stepId: 'step-0:0',
      tool: 'search_wines',
      kind: 'success',
      result: '검색 수행됨.',
      durationMs: 5,
    };
    const judge = makeFakeWithRawText(
      JSON.stringify({
        rationale: '0 fully, 0 partial, 0 contradicted, 4 neutral',
        claims_breakdown: {
          fully_supported: 0,
          partially_supported: 0,
          contradicted: 0,
          neutral: 4,
        },
      }),
    );
    const r = await judgeFaithfulnessHybrid(
      judge,
      '와인은 식사와 잘 어울립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.score).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Option C — deterministic partial-coverage floor
// ─────────────────────────────────────────────────────────────────────

describe('Deterministic partial-coverage floor (hybrid path)', () => {
  it('partial deterministic coverage (1/2 cited labels grounded) sets a positive floor against over-strict LLM', async () => {
    // Both wines are in grounding. The answer cites Opus One (grounded) and
    // a fabricated vintage 2099 (NOT grounded). Deterministic coverage:
    //   - "Opus One" → grounded label-citation = 1 grounded claim
    //   - "2099"     → ungrounded vintage = 1 ungrounded claim
    // Coverage fraction = 1/2 = 0.5. An over-strict LLM returning 0.0 must
    // NOT pull final score below the deterministic floor.
    const outcome = groundingOutcome([OPUS_ONE, ALMAVIVA]);
    const overStrictJudge = makeFakeScoring(0.0);
    const r: FaithfulnessResult = await judgeFaithfulnessHybrid(
      overStrictJudge,
      'Opus One 2099를 추천드립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.faithfulnessSource).toBe('hybrid');
    expect(r.deterministicScore).not.toBeNull();
    // Deterministic coverage must be positive (some grounded), strictly < 1.0.
    expect(r.deterministicScore ?? -1).toBeGreaterThan(0);
    expect(r.deterministicScore ?? 2).toBeLessThan(1);
    // Final score takes the max of deterministic coverage and LLM score.
    expect(r.score ?? -1).toBeGreaterThanOrEqual(r.deterministicScore ?? 0);
  });

  it('zero deterministic coverage (no claims grounded) keeps a 0 floor — no whitewashing', async () => {
    // Answer cites a wine NOT in grounding at all (totally hallucinated).
    // The deterministic verifier finds 0 grounded labels. The floor must be 0,
    // so an LLM=0 stays 0 (we never silently credit a hallucinated answer).
    const outcome = groundingOutcome([MARGAUX]);
    const r = await judgeFaithfulnessHybrid(
      makeFakeScoring(0.0),
      'Cloudy Bay Sauvignon Blanc 2020을 추천드립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    // Source is 'hybrid' if any extractable label citation existed, OR 'llm'
    // if not. Either way, the final score must be 0 — the floor is 0.
    expect(r.score).toBe(0);
  });

  it('floor never raises the score above what LLM said is fully grounded', async () => {
    // Deterministic coverage = 1.0 (all grounded) short-circuits to deterministic
    // path BEFORE the floor logic is reached — verifying back-compat with the
    // existing measurement anchors test suite (the new floor logic must not
    // change the fully-grounded path).
    const outcome = groundingOutcome([MARGAUX]);
    const r = await judgeFaithfulnessHybrid(
      makeFakeScoring(0.0),
      'Château Margaux 2015를 추천드립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.faithfulnessSource).toBe('deterministic');
    expect(r.score).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Telemetry: faithDisagreement must still detect inverted disagreement
// ─────────────────────────────────────────────────────────────────────

describe('Disagreement telemetry — preserved after calibration', () => {
  it('disagreement is computed against the RAW LLM score, not the floored final score', async () => {
    // Deterministic coverage = 0.5 (partial), LLM = 0.0 → final score 0.5.
    // Disagreement must still be detected against |0.5 - 0.0| = 0.5 (boundary,
    // strict `>`, so NOT a disagreement here) — or, with adjusted threshold,
    // not flagged. The contract: we compute disagreement on the raw signals,
    // not on the floored final score.
    const outcome = groundingOutcome([OPUS_ONE, ALMAVIVA]);
    const r = await judgeFaithfulnessHybrid(
      makeFakeScoring(0.0),
      'Opus One 2099를 추천드립니다.',
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.deterministicScore).not.toBeNull();
    expect(r.llmScore).toBe(0.0);
    // |0.5 - 0.0| = 0.5 — at the threshold boundary (`>` strict). The
    // calibration MUST NOT change the disagreement-threshold semantics.
    expect(r.faithDisagreement).toBe(false);
  });
});
