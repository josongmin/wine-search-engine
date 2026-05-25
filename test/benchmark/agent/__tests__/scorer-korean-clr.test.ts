import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('Korean CLR diagnostics', () => {
  it('emits CLR_CODE_SWITCH warn when Korean query gets English-only answer', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux. It is a great red wine from Bordeaux France.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeDefined();
    expect(clrDiag?.severity).toBe('warn');
  });

  it('does NOT emit CLR_CODE_SWITCH when Korean query gets Korean answer', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: '보르도 레드 와인을 추천드립니다. 까베르네 소비뇽 위주의 Chateau Margaux가 좋습니다.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeUndefined();
  });

  it('does NOT emit CLR_CODE_SWITCH for English-language query', () => {
    const scenario = makeScenario({}, { query: 'recommend a red wine from France' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux from Bordeaux.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeUndefined();
  });

  it('CLR_CODE_SWITCH does NOT collapse overall score to 0', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux red wine from Bordeaux.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeDefined();
    expect(result.scores.criticalFailure).toBe(false);
    expect(result.scores.overall).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TIER_WEIGHTS sum to 1.0 (Fix 3)
// ─────────────────────────────────────────────────────────────────────

