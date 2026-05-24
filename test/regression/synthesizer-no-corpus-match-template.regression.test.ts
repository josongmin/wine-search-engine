/**
 * Regression: SynthesisRunner corpus-gap admission template
 * (Wave 1 Cluster F).
 *
 * The DecisionEngine emits `failureReason: 'NO_CORPUS_MATCH'` when the
 * planner extracts a high-confidence anchor but the resolver returns 0
 * candidates (the requested entity is not in our catalogue). The
 * orchestrator forwards this to the synthesizer as
 * `decisionStatus: 'no_corpus_match'`. The synthesizer MUST emit the
 * deterministic `corpusGapAdmission` Korean / English template — NOT a
 * "please clarify" prompt and NOT the security / unsupported-intent
 * templates.
 *
 * Pins:
 *   1. Korean query → `corpusGapAdmission.korean` template mentioning
 *      "카탈로그에서 찾지 못했어요".
 *   2. English query → `corpusGapAdmission.english` template mentioning
 *      "not find that wine in our catalogue".
 *   3. `degradedReason === 'no_corpus_match'` (distinct from
 *      `'policy_blocked'` / `'no_results'`).
 *   4. NO LLM call is made for this branch (short-circuit before any
 *      structured-LLM invocation).
 *   5. The `corpusGapAdmission` template is NOT confused with the
 *      `policyBlocked` template — when `policyBlocked: true` AND
 *      `decisionStatus: 'no_corpus_match'` are both set, the corpus-gap
 *      template wins (defensive ordering).
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  ExecuteResult,
  StructuredLlmPort,
  SynthesizeRequest,
  SynthesizeResult,
} from '../../src/domain/ai/port/structured-llm.port.js';
import { SynthesisRunner } from '../../src/application/wine-search/synthesis-runner.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';
import { FALLBACK_TEMPLATES } from '../../src/application/wine-search/synthesis-fallback-templates.js';

const REQUEST_ID = 'req-corpus-gap-regress';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;

function makeAnalysis(query: string, hangulDominant: boolean): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 3 },
    hangulDominant,
    preservedSurface: query,
  };
}

function makeNeverCalledLlm(): StructuredLlmPort {
  const fail = (_req: unknown): never => {
    throw new Error('StructuredLlm should NOT be called on the corpus-gap short-circuit path');
  };
  return {
    analyze: (req: AnalyzeRequest) => Promise.resolve(fail(req) as unknown as { result: z.infer<typeof AnalyzeResult>; usage: TokenUsage }),
    execute: (req: ExecuteRequest) => Promise.resolve(fail(req) as unknown as { result: z.infer<typeof ExecuteResult>; usage: TokenUsage }),
    synthesize: (req: SynthesizeRequest) => Promise.resolve(fail(req) as unknown as SynthesizeResult),
  } as unknown as StructuredLlmPort;
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe('SynthesisRunner — no_corpus_match template (Wave 1 Cluster F)', () => {
  it('emits the Korean corpusGapAdmission template when decisionStatus=no_corpus_match (hangul query)', async () => {
    const runner = new SynthesisRunner({ structuredLlm: makeNeverCalledLlm(), logger: makeLogger() });

    const result = await runner.run({
      query: '사씨카이아 2018',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('사씨카이아 2018', true),
      toolOutcomes: [],
      policyBlocked: false,
      decisionStatus: 'no_corpus_match',
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(result.answer).toBe(FALLBACK_TEMPLATES.corpusGapAdmission.korean);
    // Spot-check the human-readable signal so a future copy change still
    // honours the intent ("not in catalogue / 카탈로그에서 찾지 못했어요").
    expect(result.answer).toContain('카탈로그');
    // Must NOT degrade to a "please clarify" template.
    expect(result.answer).not.toBe(FALLBACK_TEMPLATES.policyBlocked.korean);
    expect(result.answer).not.toBe(FALLBACK_TEMPLATES.unsupportedIntent.korean);
    expect(result.degradedReason).toBe('no_corpus_match');
    expect(result.layer).toBe('layer4');
    expect(result.synthesisAttempts).toBe(0);
    expect(result.verificationAttempts).toBe(0);
  });

  it('emits the English corpusGapAdmission template when decisionStatus=no_corpus_match (English query)', async () => {
    const runner = new SynthesisRunner({ structuredLlm: makeNeverCalledLlm(), logger: makeLogger() });

    const result = await runner.run({
      query: 'Sassicaia 2018',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('Sassicaia 2018', false),
      toolOutcomes: [],
      policyBlocked: false,
      decisionStatus: 'no_corpus_match',
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(result.answer).toBe(FALLBACK_TEMPLATES.corpusGapAdmission.english);
    expect(result.answer.toLowerCase()).toContain('catalogue');
    expect(result.answer).not.toBe(FALLBACK_TEMPLATES.policyBlocked.english);
    expect(result.answer).not.toBe(FALLBACK_TEMPLATES.unsupportedIntent.english);
    expect(result.degradedReason).toBe('no_corpus_match');
  });

  it('does NOT call the structured LLM on the corpus-gap short-circuit path', async () => {
    const llm = makeNeverCalledLlm();
    const runner = new SynthesisRunner({ structuredLlm: llm, logger: makeLogger() });

    await runner.run({
      query: '사씨카이아',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('사씨카이아', true),
      toolOutcomes: [],
      policyBlocked: false,
      decisionStatus: 'no_corpus_match',
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    // makeNeverCalledLlm throws if any LLM method is invoked; if we got
    // here without throwing, no LLM call was made.
    expect(true).toBe(true);
  });

  it('corpus-gap branch wins over policyBlocked when both flags are set (defensive ordering)', async () => {
    const runner = new SynthesisRunner({ structuredLlm: makeNeverCalledLlm(), logger: makeLogger() });

    const result = await runner.run({
      query: '사씨카이아',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('사씨카이아', true),
      toolOutcomes: [],
      // Both signals defensively set — corpus_gap is the more specific
      // signal (catalogue-coverage gap, not a policy event), so it must
      // win regardless of policyBlocked.
      policyBlocked: true,
      blockedKind: 'security_block',
      decisionStatus: 'no_corpus_match',
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(result.answer).toBe(FALLBACK_TEMPLATES.corpusGapAdmission.korean);
    expect(result.degradedReason).toBe('no_corpus_match');
    expect(result.degradedReason).not.toBe('policy_blocked');
  });

  it('without decisionStatus, policyBlocked=true still emits the security template (regression: corpus_gap is opt-in)', async () => {
    const runner = new SynthesisRunner({ structuredLlm: makeNeverCalledLlm(), logger: makeLogger() });

    const result = await runner.run({
      query: '사씨카이아',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('사씨카이아', true),
      toolOutcomes: [],
      policyBlocked: true,
      blockedKind: 'security_block',
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(result.answer).toBe(FALLBACK_TEMPLATES.policyBlocked.korean);
    expect(result.degradedReason).toBe('policy_blocked');
  });
});
