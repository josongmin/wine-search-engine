/**
 * Regression tests for `assertWineSearchResult`.
 *
 * The original implementation returned `parsed.data as unknown as
 * WineSearchResult`, a double-cast that violates CLAUDE.md rule 12
 * (no `as DomainType` on validated Zod output). After Zod `safeParse`
 * succeeds, `parsed.data` is already typed — the surrounding helper
 * should simply return it. These tests pin:
 *   1. happy-path returns a typed object whose shape is structurally
 *      identical to the input (no field-level mutation),
 *   2. invariants asserted by the schema survive the round-trip
 *      (booleans, finite numerics, enum literals),
 *   3. the bug-causing branch (invalid input) still throws.
 */

import { describe, expect, it } from 'vitest';
import {
  assertWineSearchResult,
  ORCHESTRATOR_ABORTED_ANSWER_KOREAN,
  type WineSearchResult,
} from '../wine-search-result-schemas.js';

/** Minimal, schema-valid happy-path fixture. */
function makeValidResultPayload(): Record<string, unknown> {
  return {
    answer: '테스트 답변입니다.',
    layer: 'primary',
    groundedOnToolResults: true,
    toolOutcomes: [],
    executionSteps: [
      {
        index: 0,
        source: 'analyzer',
        summary: 'analyzer phase',
        durationMs: 12,
      },
    ],
    toolCallCount: 0,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    totalDurationMs: 42,
    terminationReason: 'answer',
    policyBlocked: false,
    intent: 'search',
    planKind: 'single-search',
  };
}

describe('assertWineSearchResult — no double-cast regression', () => {
  it('returns a typed WineSearchResult for a valid payload without `as` cast', () => {
    const payload = makeValidResultPayload();
    const result: WineSearchResult = assertWineSearchResult(payload);

    // Identity-style structural assertions — the helper must not mutate or
    // re-shape valid input. Each assertion exercises a different field type.
    expect(result.answer).toBe('테스트 답변입니다.');
    expect(result.layer).toBe('primary');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.toolCallCount).toBe(0);
    expect(result.tokenUsage.inputTokens).toBe(100);
    expect(result.tokenUsage.outputTokens).toBe(50);
    expect(result.totalDurationMs).toBe(42);
    expect(result.terminationReason).toBe('answer');
    expect(result.policyBlocked).toBe(false);
    expect(result.intent).toBe('search');
    expect(result.planKind).toBe('single-search');
    expect(result.executionSteps).toHaveLength(1);
    expect(result.executionSteps[0]?.source).toBe('analyzer');
  });

  it('accepts the aborted-template Korean answer as a valid answer string', () => {
    const payload = {
      ...makeValidResultPayload(),
      answer: ORCHESTRATOR_ABORTED_ANSWER_KOREAN,
      terminationReason: 'aborted',
    };
    const result = assertWineSearchResult(payload);
    expect(result.answer).toBe(ORCHESTRATOR_ABORTED_ANSWER_KOREAN);
    expect(result.terminationReason).toBe('aborted');
  });

  it('preserves the optional `terminationKind` discriminant when present', () => {
    const payload = {
      ...makeValidResultPayload(),
      terminationReason: 'blocked',
      policyBlocked: true,
      terminationKind: 'security_block',
    };
    const result = assertWineSearchResult(payload);
    expect(result.terminationKind).toBe('security_block');
    expect(result.policyBlocked).toBe(true);
  });

  it('throws a contract-violation error on invalid input (missing answer)', () => {
    const bad = { ...makeValidResultPayload() };
    delete (bad as Record<string, unknown>).answer;
    expect(() => assertWineSearchResult(bad)).toThrow(/internal contract violation/);
  });

  it('throws on NaN/Infinity in numeric fields (finite-guard)', () => {
    const bad = {
      ...makeValidResultPayload(),
      totalDurationMs: Number.POSITIVE_INFINITY,
    };
    expect(() => assertWineSearchResult(bad)).toThrow(/internal contract violation/);
  });

  it('rejects unknown top-level fields (.strict() invariant)', () => {
    const bad = {
      ...makeValidResultPayload(),
      somethingExtra: 'nope',
    };
    expect(() => assertWineSearchResult(bad)).toThrow(/internal contract violation/);
  });
});
