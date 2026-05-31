/**
 * Faithfulness MEASUREMENT-reliability anchors (append-only regression).
 *
 * Pins the hybrid deterministic-first faithfulness scorer
 * (`judgeFaithfulnessHybrid` in test/benchmark/agent/judge.ts) against a small
 * set of (answer, grounding) pairs with KNOWN faithfulness:
 *
 *   - Fully grounded answers (incl. Korean↔Latin transliteration and compound
 *     label variants) MUST score ~1.0 via the DETERMINISTIC path, with the LLM
 *     judge skipped — this is the authoritative direction. If a future change
 *     makes the deterministic verifier over-strict again (the
 *     judge=1.00/faith=0.00 contradiction this fix targets), these assertions
 *     fail.
 *
 *   - Answers with a PLANTED hallucination (a fabricated vintage absent from
 *     grounding) MUST NOT score 1.0 deterministically; the scorer falls to the
 *     LLM judge and records the disagreement telemetry.
 *
 * The LLM is a deterministic fake — these tests never hit a network and assert
 * the measurement logic, not a real model's behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  judgeFaithfulnessHybrid,
  type FaithfulnessResult,
} from '../benchmark/agent/judge.js';
import type { ChatLlmPort, ChatCompletionRequest, ChatCompletionResult } from '../../src/domain/ai/port/chat-llm.port.js';
import type { ToolOutcome } from '../../src/domain/agent/model/tool-outcome.js';

/**
 * Deterministic fake LLM. Returns a faithfulness score keyed off the answer
 * text embedded in the user prompt: any prompt mentioning the fabricated
 * "Opus One" gets a low score (the planted hallucination), everything else
 * gets a high score. The hybrid scorer should NOT consult this fake for the
 * grounded anchors (deterministic short-circuit), so a high default is safe.
 */
function makeFakeJudge(scoreForHallucination = 0.0, scoreOtherwise = 0.9): ChatLlmPort {
  return {
    complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
      const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const isHallucination = /opus one|fabricated|2099/iu.test(userMsg);
      const score = isHallucination ? scoreForHallucination : scoreOtherwise;
      return Promise.resolve({
        text: JSON.stringify({ score, rationale: 'fake judge' }),
        model: 'fake',
        finishReason: 'stop',
      });
    },
  };
}

/** Build a single success ToolOutcome carrying a GROUNDING_JSON envelope. */
function groundingOutcome(wines: ReadonlyArray<Record<string, unknown>>): ToolOutcome {
  const envelope = `검색 결과입니다.\nGROUNDING_JSON: ${JSON.stringify({ queryType: 'search', wines })}`;
  return {
    stepId: 'step-0:0',
    tool: 'search_hybrid',
    kind: 'success',
    result: envelope,
    durationMs: 10,
  };
}

/** The observation string the LLM judge would see (same envelope text). */
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

describe('faithfulness measurement anchors — grounded answers score ~1.0 deterministically', () => {
  it('exact Latin label + grounded vintage → deterministic 1.0, LLM skipped', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    const answer = 'Château Margaux 2015를 추천드립니다. 보르도의 풀바디 레드 와인입니다.';
    const r: FaithfulnessResult = await judgeFaithfulnessHybrid(
      makeFakeJudge(),
      answer,
      [observationFor(outcome)],
      [outcome],
    );
    expect(r.score).toBe(1.0);
    expect(r.faithfulnessSource).toBe('deterministic');
    expect(r.deterministicScore).toBe(1.0);
    expect(r.llmScore).toBeNull(); // LLM judge skipped
    expect(r.faithDisagreement).toBe(false);
  });

  it('Korean transliteration of grounded wine → deterministic 1.0 (no fabrication detected)', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    // Korean surface "샤또 마고" for the grounded "Château Margaux" — not a new claim.
    const answer = '샤또 마고 2015, 보르도 지역의 카베르네 소비뇽 블렌드를 추천드립니다.';
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(), answer, [observationFor(outcome)], [outcome]);
    expect(r.score).toBe(1.0);
    expect(r.faithfulnessSource).toBe('deterministic');
  });

  it('compound label (canonical + qualifiers) with grounded vintage → deterministic 1.0', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    const answer = 'Château Margaux 2015 (Grand Vin, Bordeaux) 풀바디 레드입니다.';
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(), answer, [observationFor(outcome)], [outcome]);
    expect(r.score).toBe(1.0);
    expect(r.faithfulnessSource).toBe('deterministic');
  });

  it('grounded answer with no vintage assertion → deterministic 1.0', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    const answer = '보르도의 Château Margaux를 추천드립니다. 카베르네 소비뇽 기반 풀바디 레드예요.';
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(), answer, [observationFor(outcome)], [outcome]);
    expect(r.score).toBe(1.0);
    expect(r.faithfulnessSource).toBe('deterministic');
  });
});

describe('faithfulness measurement anchors — planted hallucinations score ~0.0', () => {
  it('fabricated vintage (2099 absent from grounding) → deterministic catches it, partial coverage acts as floor', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    // Answer asserts a vintage (2099) that is NOT in grounding (grounded: 2015).
    // Label "Château Margaux" IS grounded → 1 grounded label-citation, 1
    // ungrounded vintage claim → deterministic coverage = 1/2 = 0.5.
    const answer = 'Château Margaux 2099를 추천드립니다.';
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(0.0), answer, [observationFor(outcome)], [outcome]);
    // Deterministic verifier flagged the fabricated vintage → not 1.0 deterministically.
    expect(r.faithfulnessSource).toBe('hybrid');
    // L3 calibration: partial coverage replaces the old binary 0.0 verdict.
    expect(r.deterministicScore).toBe(0.5);
    // Floor = 0.5 (label grounded). LLM=0.0 cannot drag the score below 0.5.
    expect(r.score).toBe(0.5);
    expect(r.llmScore).toBe(0.0);
    // |0.5 - 0.0| = 0.5 — at the boundary; strict `>` keeps it under threshold.
    expect(r.faithDisagreement).toBe(false);
    expect(r.ungroundedClaims).toContain('2099');
  });

  it('fully fabricated wine (Opus One, absent from grounding) → hybrid LLM path scores 0.0', async () => {
    const outcome = groundingOutcome([MARGAUX]);
    // "Opus One 2099" — both name and vintage fabricated. The fabricated vintage
    // is structurally caught; the fabricated name is caught semantically by the LLM.
    const answer = 'Opus One 2099, 캘리포니아 나파 밸리의 와인을 추천드립니다.';
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(0.0), answer, [observationFor(outcome)], [outcome]);
    expect(r.faithfulnessSource).toBe('hybrid');
    expect(r.score).toBe(0.0);
  });
});

describe('faithfulness measurement anchors — disagreement telemetry', () => {
  it('records faithDisagreement=true when deterministic vs LLM differ by > 0.5 (no labels grounded)', async () => {
    // To exercise the disagreement path we need a det/llm pair that is > 0.5
    // apart. With partial-coverage semantics, an answer that grounds NO labels
    // (fully fabricated entity) yields det=0.0. A lenient LLM returning 1.0
    // produces |0.0 - 1.0| = 1.0 > 0.5 → disagreement.
    const outcome = groundingOutcome([MARGAUX]);
    const lenientJudge = makeFakeJudge(1.0, 1.0); // always 1.0
    // "Opus One 2099" — both name AND vintage absent from grounding (only
    // Château Margaux 2015 is grounded). Zero label citations grounded → det=0.0.
    const answer = 'Opus One 2099를 추천드립니다.';
    const r = await judgeFaithfulnessHybrid(lenientJudge, answer, [observationFor(outcome)], [outcome]);
    expect(r.deterministicScore).toBe(0.0);
    expect(r.llmScore).toBe(1.0);
    expect(r.faithDisagreement).toBe(true); // |0.0 - 1.0| = 1.0 > 0.5
  });
});

describe('faithfulness measurement anchors — no grounding facts falls to LLM', () => {
  it('observations without GROUNDING_JSON → source=llm, deterministicScore=null', async () => {
    // A non-grounding observation (no envelope, no structured wines).
    const outcome: ToolOutcome = {
      stepId: 'step-0:0',
      tool: 'search_hybrid',
      kind: 'success',
      result: '검색을 수행했지만 구조화된 결과가 없습니다.',
      durationMs: 5,
    };
    const r = await judgeFaithfulnessHybrid(makeFakeJudge(), '추천 와인이 있습니다.', [observationFor(outcome)], [outcome]);
    expect(r.faithfulnessSource).toBe('llm');
    expect(r.deterministicScore).toBeNull();
    expect(r.score).toBe(0.9); // the fake's non-hallucination score
  });
});
