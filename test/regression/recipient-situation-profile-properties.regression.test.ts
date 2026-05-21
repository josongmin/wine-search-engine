/**
 * Property-based regression tests for nlu.recipient-situation-profile (M3 -> M5).
 *
 * The example suite (recipient-situation-profile.regression.test.ts) pins a
 * handful of hand-built recipient/occasion queries. This suite re-derives the
 * classifier's invariants over arbitrary input distributions with fast-check
 * (numRuns: 100) so the contract holds across thousands of randomized queries,
 * not just the curated examples.
 *
 * The classifier is a DETERMINISTIC, rule-based recipient-situation profiler.
 * It must:
 *   1. Be a pure function — identical output for identical input, every run.
 *   2. Emit confidence ∈ [0, 1] and finite, for ANY input (incl. adversarial).
 *   3. Only ever emit canonical RECIPIENT_PROFILE_VALUES.
 *   4. Be NFC-stable on Korean recipient/situation phrases (NFD == NFC input).
 *   5. Be substring-collision safe on LATIN signals (CLAUDE.md rule 29):
 *      'mom' must NOT fire on "moment", 'cava' must NOT fire on "excavation",
 *      'safe' must NOT fire on "safety", 'light' must NOT fire on "delightful".
 *      This is enforced via Unicode word boundaries [\p{L}\p{N}] + /u — never
 *      \b (CLAUDE.md rules 8/24), which is ASCII-only and breaks across scripts.
 *   6. Keep KOREAN signals particle-robust — '부모님' must fire inside "부모님께"
 *      (Korean agglutinates; substring matching is the correct semantics there).
 *   7. Be empty/whitespace safe — no profile, confidence 0, no throw.
 *   8. Have a runner-up that, when present, never out-scores the top profile and
 *      always carries strictly positive evidence and a distinct profile.
 *   9. Be monotone — appending more text never DROPS an already-present signal
 *      hit (signals are additive over distinct substrings/tokens).
 *
 * Bumps nlu.recipient-situation-profile maturity 3 -> 5.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  RECIPIENT_PROFILE_VALUES,
  classifyRecipientSituationProfile,
} from '../../src/domain/query/service/recipient-situation-profile.js';

const NUM_RUNS = 100;
const CANONICAL = RECIPIENT_PROFILE_VALUES as readonly string[];

// Real Korean recipient / occasion phrases — one per profile family. Used to
// build positive queries with arbitrary surrounding noise.
const KOREAN_PARENTS = ['부모님', '엄마', '어머니', '아빠', '아버지', '처음', '입문', '달콤'] as const;
const KOREAN_SENIOR = ['상사', '직장', '선물', '고급', '회식', '접대', '격식'] as const;
const KOREAN_UNKNOWN = ['모르는', '취향', '무난', '대중적', '누구나', '안전한'] as const;

// Korean particle suffixes that legitimately agglutinate onto recipient nouns.
const KOREAN_PARTICLES = ['께', '에게', '한테', '용', '이', '가', '은', '는', '도', '만'] as const;

// LATIN false-positive corpus: each contains a recipient SIGNAL as a strict
// substring but NOT as a free-standing token. The classifier must NOT fire.
const LATIN_SUBSTRING_DECOYS = [
  'a moment of pure momentum',          // 'mom'
  'excavation crews drank water',       // 'cava'
  'highlight the delightful flight',    // 'light'
  'safety presentation formaldehyde',   // 'safe' / 'present' / 'formal'
  'kidnapped narrative',                // 'napa'
  'the presenter representative',       // 'present'
  'lightning lighthouse skylight',      // 'light'
  'momentous momentary momentum',       // 'mom'
] as const;

// Non-gift legitimate Korean wine queries that must NOT trip a profile, to
// confirm false-positive safety on the Korean side.
const KOREAN_NON_GIFT = [
  '카베르네 소비뇽 2018 빈티지',
  '탄닌 강한 풀바디 레드 와인',
  '내추럴 와인 추천해줘',
  '5만원 이하 데일리 와인',
] as const;

describe('recipient-situation-profile properties — output contract', () => {
  it('confidence is always finite and within [0,1] for ANY string input', () => {
    fc.assert(
      fc.property(fc.string(), (q) => {
        const r = classifyRecipientSituationProfile(q);
        expect(Number.isFinite(r.confidence)).toBe(true);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS, seed: 0x5A1AD },
    );
  });

  it('only ever emits canonical profile values (top + runner-up)', () => {
    fc.assert(
      fc.property(fc.string(), (q) => {
        const r = classifyRecipientSituationProfile(q);
        if (r.profile !== undefined) {
          expect(CANONICAL).toContain(r.profile);
        }
        if (r.runnerUp !== undefined) {
          expect(CANONICAL).toContain(r.runnerUp.profile);
        }
      }),
      { numRuns: NUM_RUNS, seed: 0xB07735 },
    );
  });

  it('never throws on adversarial unicode / control / emoji input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (q) => {
        expect(() => classifyRecipientSituationProfile(q)).not.toThrow();
      }),
      { numRuns: NUM_RUNS, seed: 0xADDED },
    );
  });
});

describe('recipient-situation-profile properties — determinism', () => {
  it('is a pure function: identical output across repeated calls', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (q) => {
        const a = classifyRecipientSituationProfile(q);
        const b = classifyRecipientSituationProfile(q);
        expect(a).toEqual(b);
      }),
      { numRuns: NUM_RUNS, seed: 0xDE7E2 },
    );
  });

  it('is independent of preceding call history (no shared mutable state)', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), fc.string(), (warmup, q) => {
        const baseline = classifyRecipientSituationProfile(q);
        for (const w of warmup) {
          classifyRecipientSituationProfile(w);
        }
        expect(classifyRecipientSituationProfile(q)).toEqual(baseline);
      }),
      { numRuns: NUM_RUNS, seed: 0xCACE },
    );
  });
});

describe('recipient-situation-profile properties — runner-up contract', () => {
  it('runner-up never out-scores top, is distinct, and has positive evidence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_PARENTS),
        fc.constantFrom(...KOREAN_SENIOR),
        fc.constantFrom(...KOREAN_UNKNOWN),
        (p, s, u) => {
          // Mix signals from multiple profiles so a runner-up is likely.
          const r = classifyRecipientSituationProfile(`${p} ${s} ${u} 와인 추천`);
          if (r.runnerUp !== undefined) {
            expect(r.profile).toBeDefined();
            expect(r.runnerUp.profile).not.toBe(r.profile);
            expect(r.runnerUp.confidence).toBeGreaterThan(0);
            expect(r.runnerUp.confidence).toBeLessThanOrEqual(r.confidence);
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: 0x2ED },
    );
  });
});

describe('recipient-situation-profile properties — NFC stability (Korean)', () => {
  it('NFD-decomposed Korean query yields the same classification as NFC', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_PARENTS, ...KOREAN_SENIOR, ...KOREAN_UNKNOWN),
        (token) => {
          const query = `${token} 와인 추천`;
          const nfc = query.normalize('NFC');
          const nfd = query.normalize('NFD');
          expect(classifyRecipientSituationProfile(nfd)).toEqual(
            classifyRecipientSituationProfile(nfc),
          );
        },
      ),
      { numRuns: NUM_RUNS, seed: 0x4FC },
    );
  });
});

describe('recipient-situation-profile properties — Korean particle robustness', () => {
  it('Korean recipient signal fires even with an agglutinated particle', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_PARENTS),
        fc.constantFrom(...KOREAN_PARTICLES),
        (token, particle) => {
          const r = classifyRecipientSituationProfile(`${token}${particle} 드릴 와인`);
          expect(r.profile).toBe('parents_first_time');
          expect(r.confidence).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS, seed: 0x9A11 },
    );
  });
});

describe('recipient-situation-profile properties — Latin substring-collision safety (rule 29)', () => {
  it('does NOT fire on Latin words that merely CONTAIN a signal substring', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LATIN_SUBSTRING_DECOYS), (decoy) => {
        const r = classifyRecipientSituationProfile(decoy);
        expect(r.profile).toBeUndefined();
        expect(r.confidence).toBe(0);
      }),
      { numRuns: NUM_RUNS, seed: 0x29DEC0 },
    );
  });

  it('decoy + arbitrary non-signal noise still does not fire', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LATIN_SUBSTRING_DECOYS),
        // ASCII letters only, kept away from real signal tokens.
        fc.stringMatching(/^[bcdfghjkmpqvwxz]{0,12}$/),
        (decoy, noise) => {
          const r = classifyRecipientSituationProfile(`${noise} ${decoy} ${noise}`);
          expect(r.profile).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS, seed: 0x015E },
    );
  });

  it('the SAME signal as a free-standing token DOES fire (boundary, not removal)', () => {
    // 'mom', 'cava', 'light', 'safe' as standalone tokens must still classify.
    const positives: ReadonlyArray<readonly [string, string]> = [
      ['a gift for mom', 'parents_first_time'],
      ['cava prosecco for the crowd', 'unknown_preference_recipient'],
      ['light sweet moscato for parents', 'parents_first_time'],
      ['a safe crowd pleasing pick', 'unknown_preference_recipient'],
    ];
    for (const [q, expected] of positives) {
      const r = classifyRecipientSituationProfile(q);
      expect(r.profile).toBe(expected);
      expect(r.confidence).toBeGreaterThan(0);
    }
  });
});

describe('recipient-situation-profile properties — false-positive safety (Korean non-gift)', () => {
  it('legitimate non-gift Korean wine queries do not surface a recipient profile', () => {
    fc.assert(
      fc.property(fc.constantFrom(...KOREAN_NON_GIFT), (q) => {
        const r = classifyRecipientSituationProfile(q);
        expect(r.profile).toBeUndefined();
        expect(r.confidence).toBe(0);
      }),
      { numRuns: NUM_RUNS, seed: 0x6F6 },
    );
  });
});

describe('recipient-situation-profile properties — empty / whitespace safety', () => {
  it('whitespace-only input yields no profile and confidence 0', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ \t\n\r]*$/), (ws) => {
        const r = classifyRecipientSituationProfile(ws);
        expect(r.profile).toBeUndefined();
        expect(r.confidence).toBe(0);
        expect(r.runnerUp).toBeUndefined();
      }),
      { numRuns: NUM_RUNS, seed: 0x0E33 },
    );
  });
});

describe('recipient-situation-profile properties — monotonicity', () => {
  it('appending a recipient signal never lowers that profile confidence', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.constantFrom(...KOREAN_PARENTS),
        (prefix, token) => {
          const base = classifyRecipientSituationProfile(prefix);
          const augmented = classifyRecipientSituationProfile(`${prefix} ${token} 와인`);
          // The augmented query has at least the appended Korean signal, so the
          // parents profile must have non-zero evidence. We assert the top
          // profile of the augmented query is at least as confident as the base
          // top whenever the base already pointed at parents.
          if (base.profile === 'parents_first_time') {
            expect(augmented.confidence).toBeGreaterThanOrEqual(base.confidence);
          }
          expect(augmented.confidence).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS, seed: 0x33333 },
    );
  });
});
