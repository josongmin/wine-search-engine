import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('scoreAnswerQuality', () => {
  it('empty answer scores 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: '   ' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });

  it('all answerContains matched → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['Opus One', '2018'] }),
      makeExecution({ answer: 'I recommend Opus One 2018, a Napa Cabernet.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(1);
  });

  it('partial match returns ratio', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['Opus One', '2018', 'Napa'] }),
      // Answer is ≥20 chars to avoid the trivial-answer length penalty.
      makeExecution({ answer: 'Opus One is a great wine from California.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBeCloseTo(1 / 3, 5);
  });

  it('Korean substring matching is whitespace-normalised', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['오푸스원'] }),
      // Answer is ≥20 chars to avoid the trivial-answer length penalty.
      makeExecution({ answer: '오푸스 원은 나파 카베르네 기반의 훌륭한 와인입니다.' }),
      undefined,
    );
    // After NFKC + whitespace strip both become "오푸스원..." — match.
    expect(r.scores.answerQuality).toBe(1);
  });

  it('answerExcludes violation → hard 0 (not 0.5)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerExcludes: ['white'] }),
      makeExecution({ answer: 'A nice white wine.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });

  it('answerExcludes case-insensitive', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerExcludes: ['WHITE'] }),
      makeExecution({ answer: 'A nice White wine.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Termination
// ─────────────────────────────────────────────────────────────────────

