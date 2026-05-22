import { describe, it, expect } from 'vitest';
import { ReplSession } from '../session.js';
import { MAX_QUERY_LENGTH } from '../../../domain/shared/constants.js';

describe('ReplSession', () => {
  it('returns the current input unchanged with no prior turns', () => {
    const s = new ReplSession();
    expect(s.buildQuery('피자에 어울리는 와인')).toBe('피자에 어울리는 와인');
    expect(s.turnCount).toBe(0);
  });

  it('folds prior turns into the next query (multi-turn 티키타카)', () => {
    const s = new ReplSession();
    s.record('피자에 어울리는 와인 추천', '키안티, 발폴리첼라를 추천합니다.');
    const q = s.buildQuery('그중에 5만원 이하는?');

    expect(q).toContain('이전 대화:');
    expect(q).toContain('피자에 어울리는 와인 추천');
    expect(q).toContain('키안티');
    expect(q).toContain('현재 질문: 그중에 5만원 이하는?');
    expect(s.turnCount).toBe(1);
  });

  it('orders folded turns chronologically (oldest → newest)', () => {
    const s = new ReplSession();
    s.record('첫번째 질문', '첫번째 답변');
    s.record('두번째 질문', '두번째 답변');
    const q = s.buildQuery('세번째');
    expect(q.indexOf('첫번째 질문')).toBeLessThan(q.indexOf('두번째 질문'));
  });

  it('never exceeds the query char budget when folding context', () => {
    const s = new ReplSession();
    // 50 turns of long answers — far more than fits.
    for (let i = 0; i < 50; i += 1) {
      s.record(`질문${i}`, 'x'.repeat(1_000));
    }
    const q = s.buildQuery('마지막 질문');
    expect(q.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
  });

  it('keeps the MOST RECENT turns when the budget is tight (sliding window)', () => {
    const s = new ReplSession();
    for (let i = 0; i < 50; i += 1) {
      s.record(`질문${i}`, 'x'.repeat(1_000));
    }
    const q = s.buildQuery('마지막');
    // The newest turn must survive; the oldest must be evicted.
    expect(q).toContain('질문49');
    expect(q).not.toContain('질문0\n');
  });

  it('falls back to current input alone when it leaves no context budget', () => {
    const s = new ReplSession(120); // tiny budget
    s.record('이전', '답변');
    const longInput = 'a'.repeat(200); // already > budget
    expect(s.buildQuery(longInput)).toBe(longInput);
  });

  it('reset() clears history', () => {
    const s = new ReplSession();
    s.record('q', 'a');
    s.reset();
    expect(s.turnCount).toBe(0);
    expect(s.buildQuery('새 질문')).toBe('새 질문');
  });
});
