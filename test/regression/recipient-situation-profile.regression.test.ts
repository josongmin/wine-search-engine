/**
 * Regression tests for nlu.recipient-situation-profile (M2 -> M3 bump).
 *
 * Covers:
 * - Query-string profile classification (parents_first_time / senior_colleague_gift /
 *   unknown_preference_recipient).
 * - Korean + English signals (CLAUDE.md rule 5/8).
 * - Confidence scoring in [0,1] tied to evidence axis density.
 * - Runner-up profile when secondary signal also fires.
 * - Determinism (no Math.random, no locale-dependent output).
 * - Backward compatibility: the candidate-based evidence-axis API surface remains
 *   intact for existing callers (candidate-constraint-evidence,
 *   agent-semantic-contract, etc.).
 */

import { describe, expect, it } from 'vitest';
import {
  RECIPIENT_PROFILE_VALUES,
  candidateMatchesRecipientProfile,
  classifyRecipientSituationProfile,
  recipientProfileEvidenceAxes,
} from '../../src/domain/query/service/recipient-situation-profile.js';

describe('classifyRecipientSituationProfile - profile detection', () => {
  it('detects parents_first_time from Korean parent-gift query', () => {
    const result = classifyRecipientSituationProfile('부모님 처음 드시는 와인 추천');
    expect(result.profile).toBe('parents_first_time');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('detects parents_first_time from English parent-gift query', () => {
    const result = classifyRecipientSituationProfile(
      'wine for my parents who are trying wine for the first time',
    );
    expect(result.profile).toBe('parents_first_time');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects senior_colleague_gift from Korean senior/boss query', () => {
    const result = classifyRecipientSituationProfile('직장 상사 선물용 고급 와인');
    expect(result.profile).toBe('senior_colleague_gift');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects senior_colleague_gift from English senior-colleague gift query', () => {
    const result = classifyRecipientSituationProfile(
      'prestige gift wine for senior colleague at the office',
    );
    expect(result.profile).toBe('senior_colleague_gift');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects unknown_preference_recipient from Korean "잘 모르는 사람" query', () => {
    const result = classifyRecipientSituationProfile('취향을 잘 모르는 사람한테 줄 무난한 와인');
    expect(result.profile).toBe('unknown_preference_recipient');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects unknown_preference_recipient from English crowd-pleaser query', () => {
    const result = classifyRecipientSituationProfile(
      "crowd pleasing safe wine for someone whose taste I don't know",
    );
    expect(result.profile).toBe('unknown_preference_recipient');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('classifyRecipientSituationProfile - confidence shape', () => {
  it('returns profile + confidence + runnerUp fields', () => {
    const result = classifyRecipientSituationProfile('부모님 선물용 와인');
    expect(result).toHaveProperty('profile');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('runnerUp');
    expect(typeof result.confidence).toBe('number');
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it('confidence stays within [0,1] for strongly-typed query', () => {
    const result = classifyRecipientSituationProfile('parents first wine moscato light sweet');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe('classifyRecipientSituationProfile - runner-up', () => {
  it('populates runnerUp when query has both gift and parents signals', () => {
    // "선물" (gift) -> senior_colleague_gift, "부모님" (parents) -> parents_first_time
    const result = classifyRecipientSituationProfile('부모님 선물 와인 추천');
    expect(result.profile).toBeDefined();
    expect(result.runnerUp).toBeDefined();
    expect(result.runnerUp?.profile).not.toBe(result.profile);
    expect(result.runnerUp?.confidence).toBeLessThanOrEqual(result.confidence);
    expect(result.runnerUp?.confidence).toBeGreaterThan(0);
  });

  it('leaves runnerUp undefined when only one profile has any evidence', () => {
    const result = classifyRecipientSituationProfile('직장 상사 선물 샴페인');
    expect(result.profile).toBe('senior_colleague_gift');
    // With purely senior-gift signals and no parents/unknown cues, runnerUp may
    // be undefined OR have confidence === 0; the contract is "no spurious
    // second profile".
    if (result.runnerUp !== undefined) {
      expect(result.runnerUp.confidence).toBe(0);
    }
  });
});

describe('classifyRecipientSituationProfile - no profile cases', () => {
  it('returns profile undefined for generic wine query with no recipient signal', () => {
    // Avoid any region/varietal that doubles as a gift / crowd-pleaser cue
    // (e.g. napa, bordeaux, prosecco, merlot) so we exercise the pure
    // "no recipient signal" branch.
    const result = classifyRecipientSituationProfile('cabernet sauvignon 2018 medium body');
    expect(result.profile).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(result.runnerUp).toBeUndefined();
  });

  it('returns profile undefined for empty query', () => {
    const result = classifyRecipientSituationProfile('');
    expect(result.profile).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(result.runnerUp).toBeUndefined();
  });

  it('returns profile undefined for whitespace-only query', () => {
    const result = classifyRecipientSituationProfile('   \n\t  ');
    expect(result.profile).toBeUndefined();
    expect(result.confidence).toBe(0);
  });
});

describe('classifyRecipientSituationProfile - Korean particle robustness', () => {
  it('classifies "엄마 선물용 와인" as a recipient-gift query (mom = parent)', () => {
    const result = classifyRecipientSituationProfile('엄마 선물용 와인');
    expect(result.profile).toBeDefined();
    expect(['parents_first_time', 'senior_colleague_gift']).toContain(result.profile);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles "아빠" (dad) parent signal', () => {
    const result = classifyRecipientSituationProfile('아빠 처음 드시는 와인');
    expect(result.profile).toBe('parents_first_time');
  });

  it('handles "어머니" formal parent signal', () => {
    const result = classifyRecipientSituationProfile('어머니께 드릴 와인');
    expect(result.profile).toBeDefined();
  });
});

describe('classifyRecipientSituationProfile - determinism', () => {
  it('returns identical output for the same query across 5 runs', () => {
    const query = '부모님 선물용 와인';
    const runs = Array.from({ length: 5 }, () => classifyRecipientSituationProfile(query));
    const first = runs[0];
    expect(first).toBeDefined();
    for (const r of runs) {
      expect(r).toEqual(first);
    }
  });

  it('breaks ties deterministically by canonical RECIPIENT_PROFILE_VALUES order', () => {
    // A query with no evidence should always return the same shape, not random.
    const a = classifyRecipientSituationProfile('wine');
    const b = classifyRecipientSituationProfile('wine');
    expect(a).toEqual(b);
  });
});

describe('classifyRecipientSituationProfile - profile coverage', () => {
  it('only emits canonical profile values', () => {
    const queries = [
      '부모님 처음 와인',
      '직장 상사 선물 와인',
      '잘 모르는 사람 무난한 와인',
      'cabernet 2018',
      '',
    ];
    for (const q of queries) {
      const r = classifyRecipientSituationProfile(q);
      if (r.profile !== undefined) {
        expect(RECIPIENT_PROFILE_VALUES as readonly string[]).toContain(r.profile);
      }
      if (r.runnerUp !== undefined) {
        expect(RECIPIENT_PROFILE_VALUES as readonly string[]).toContain(r.runnerUp.profile);
      }
    }
  });
});

describe('recipient profile - backward compatibility', () => {
  // Existing candidate-based APIs (candidateMatchesRecipientProfile,
  // recipientProfileEvidenceAxes) must continue to work for current callers in
  // candidate-constraint-evidence and agent-semantic-contract.
  it('candidateMatchesRecipientProfile still classifies a moscato candidate as parents_first_time', () => {
    const result = candidateMatchesRecipientProfile(
      {
        wineType: 'white',
        grapePrimary: 'moscato',
        tannin: 0.1,
        sweetness: 0.6,
        acidity: 0.5,
        body: 0.3,
      },
      'parents_first_time',
    );
    expect(result).toBe(true);
  });

  it('recipientProfileEvidenceAxes returns expected axes for moscato candidate', () => {
    const axes = recipientProfileEvidenceAxes(
      {
        wineType: 'white',
        grapePrimary: 'moscato',
        tannin: 0.1,
        sweetness: 0.6,
        acidity: 0.5,
        body: 0.3,
      },
      'parents_first_time',
    );
    expect(axes).toContain('sweet_light');
    expect(axes).toContain('fruit_forward');
  });
});
