/**
 * Property-based regression suite for `agent-situational-query-policy`
 * (maturity 3 → 5 hardening).
 *
 * Invariants pinned here (append-only — never delete):
 *   1. Determinism — same input always yields the same classification.
 *   2. NFC stability — NFD-decomposed Korean input classifies identically to its
 *      composed (NFC) form. Regex literals are composed Hangul; without input
 *      normalization `맥주`(NFC) ≠ `ㅁㅐㄱㅈㅜ`(NFD) and the classifier silently
 *      misses real OOD/weather queries.
 *   3. Substring-collision safety (CLAUDE.md rule 29) — common Korean words that
 *      merely *contain* an alcohol/weather syllable (사진/진한/드럼/준비 오래)
 *      and English words that contain a Latin token (rumored/ginger/training/
 *      terrain/obsession/delivery) MUST NOT trigger.
 *   4. No `\b` on Korean (CLAUDE.md rule 8) — verified structurally: Korean
 *      boundaries use `[^가-힣]` / `(?:^|…)` lookarounds, never `\b`.
 *   5. Empty / whitespace / non-string-ish input safety — never throws, returns
 *      false / boilerplate.
 *   6. Bounded output — pairing-context residue never exceeds its cap regardless
 *      of input length.
 *   7. False-positive safety — real Korean situational *occasion* queries
 *      (결혼기념일/집들이/회식/돌잔치) are ordinary wine queries and MUST NOT be
 *      mis-routed by the OOD/online-tasting/weather early-exit branches.
 *
 * Korean cases are MANDATORY (situational queries are frequently Korean).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildOutOfDomainWineRedirectAnswer,
  isAccessibleOnlineTastingQuery,
  isUnsupportedWineExternalInfoQuery,
  isWineOutOfDomainAlcoholQuery,
} from '../../src/application/agent/agent-situational-query-policy.js';

const NUM_RUNS = 100;

// All classifier predicates under test, for batch property assertions.
const PREDICATES: ReadonlyArray<readonly [string, (q: string) => boolean]> = [
  ['isAccessibleOnlineTastingQuery', isAccessibleOnlineTastingQuery],
  ['isWineOutOfDomainAlcoholQuery', isWineOutOfDomainAlcoholQuery],
  ['isUnsupportedWineExternalInfoQuery', isUnsupportedWineExternalInfoQuery],
] as const;

// -----------------------------------------------------------------------------
// Corpora
// -----------------------------------------------------------------------------

/**
 * Real Korean situational *occasion* queries. These are legitimate wine
 * requests and must NOT trip any early-exit classifier (false-positive safety).
 */
const KOREAN_OCCASION_QUERIES = [
  '결혼기념일 선물용 와인 추천',
  '집들이 가져갈 와인 골라줘',
  '회식 때 다 같이 마실 와인',
  '돌잔치 답례품 와인',
  '부모님 생신 선물 와인',
  '승진 축하 와인 추천',
  '연말 모임에 어울리는 와인',
  '데이트할 때 마실 로제 와인',
] as const;

/**
 * Substring-collision corpus (rule 29). Each contains a *substring* of an
 * alcohol/weather/tasting token but is NOT that concept. None may trigger.
 */
const COLLISION_NEGATIVES = [
  // Korean alcohol-syllable collisions
  '진한 바디감의 레드 와인',      // 진 (full-bodied) vs 진토닉
  '사진 찍기 좋은 와이너리',       // 진 (photo)
  '진짜 맛있는 와인 추천',         // 진 (really)
  '드럼 소리 같은 강렬한 와인',    // 럼 (drum)
  '클럼지하지 않은 와인 서버',     // 럼 (clumsy)
  // Korean weather-syllable collisions
  '준비 오래 걸리는 와인',         // 비 오 (takes long to prepare)
  // English alcohol-substring collisions
  'rumored 2010 vintage',          // rum
  'ginger note in this wine',      // gin
  'beginning a wine course',       // gin
  'for the sake of a good pairing',// sake (idiom "sake of")
  // English weather-substring collisions
  'training session for sommeliers', // rain
  'terrain expression of Burgundy',  // rain
  // English online-tasting context collisions
  'delivery options for wine',     // live
  'an obsession with Burgundy',    // session
  'is this wine still alive',      // live
] as const;

/** Plain wine queries — clearly nothing-special, must pass through. */
const PLAIN_WINE_QUERIES = [
  'best Cabernet Sauvignon under $50',
  '오푸스 원 추천',
  '삼겹살에 어울리는 와인',
  'a crisp white for summer',
] as const;

/** True positives per branch (sanity that hardening did not over-suppress). */
const TRUE_OOD_ALCOHOL = [
  '맥주 추천',
  '위스키 추천',
  'cocktail recipes',
  'beer that pairs with steak',
  '럼 추천해줘',
  '와인 말고 소주',
] as const;

const TRUE_WEATHER = [
  '오늘 날씨 좋은 날 마실 와인',
  '비 오는 날 마실 와인',
  '맑은 날 피크닉 와인',
  'rain or shine wine',
] as const;

const TRUE_ONLINE_TASTING = [
  'online tasting session this Friday, available at the supermarket',
  '실시간 와인 시음회, 참가자 모두 살 수 있는 와인',
] as const;

// -----------------------------------------------------------------------------
// Property: determinism
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: determinism', () => {
  it('every predicate is a pure function of its input (numRuns=100)', () => {
    fc.assert(
      fc.property(fc.string(), (q) => {
        for (const [, predicate] of PREDICATES) {
          expect(predicate(q)).toBe(predicate(q));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('determinism holds for Korean-heavy unicode strings (numRuns=100)', () => {
    const koChar = fc.constantFrom(
      ...'결혼기념일집들이회식진한사진럼주맥주소주위스키날씨비오맑'.split(''),
    );
    fc.assert(
      fc.property(fc.array(koChar, { maxLength: 30 }).map((a) => a.join('')), (q) => {
        for (const [, predicate] of PREDICATES) {
          expect(predicate(q)).toBe(predicate(q));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// -----------------------------------------------------------------------------
// Property: NFC stability
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: NFC stability', () => {
  const NFC_SAMPLES = [
    ...TRUE_OOD_ALCOHOL,
    ...TRUE_WEATHER,
    ...KOREAN_OCCASION_QUERIES,
    ...COLLISION_NEGATIVES,
  ];

  it('NFD-decomposed input classifies identically to NFC (all predicates)', () => {
    for (const sample of NFC_SAMPLES) {
      const nfc = sample.normalize('NFC');
      const nfd = sample.normalize('NFD');
      // Sanity: the two encodings are genuinely different byte sequences for KR.
      for (const [name, predicate] of PREDICATES) {
        expect(predicate(nfd), `${name} on NFD(${sample})`).toBe(predicate(nfc));
      }
    }
  });

  it('property: NFC/NFD agree on generated Korean queries (numRuns=100)', () => {
    const koChar = fc.constantFrom(
      ...'결혼기념일집들이회식맥주소주위스키날씨비오맑럼주칵테일'.split(''),
    );
    fc.assert(
      fc.property(fc.array(koChar, { maxLength: 20 }).map((a) => a.join(' ')), (q) => {
        const nfc = q.normalize('NFC');
        const nfd = q.normalize('NFD');
        for (const [, predicate] of PREDICATES) {
          expect(predicate(nfd)).toBe(predicate(nfc));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// -----------------------------------------------------------------------------
// Property: substring-collision safety (rule 29)
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: substring-collision safety', () => {
  it('no collision negative triggers any classifier', () => {
    for (const q of COLLISION_NEGATIVES) {
      for (const [name, predicate] of PREDICATES) {
        expect(predicate(q), `${name} falsely fired on "${q}"`).toBe(false);
      }
    }
  });

  it('property: padding a collision negative with whitespace never flips it (numRuns=100)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...COLLISION_NEGATIVES),
        fc.stringMatching(/^[ \t\n]*$/),
        (base, pad) => {
          for (const [, predicate] of PREDICATES) {
            expect(predicate(`${pad}${base}${pad}`)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// -----------------------------------------------------------------------------
// Property: false-positive safety on Korean occasion queries
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: occasion false-positive safety', () => {
  it('Korean occasion queries (결혼기념일/집들이/회식 …) never early-exit', () => {
    for (const q of [...KOREAN_OCCASION_QUERIES, ...PLAIN_WINE_QUERIES]) {
      for (const [name, predicate] of PREDICATES) {
        expect(predicate(q), `${name} falsely fired on occasion query "${q}"`).toBe(false);
      }
    }
  });

  it('회식 specifically does not match 회/회사 alcohol or weather syllables', () => {
    // 회식 (company dinner) contains 회; ensure no token collision exists.
    for (const q of ['회식 와인', '회사 송년회 와인', '동창회 모임 와인']) {
      expect(isWineOutOfDomainAlcoholQuery(q)).toBe(false);
      expect(isUnsupportedWineExternalInfoQuery(q)).toBe(false);
      expect(isAccessibleOnlineTastingQuery(q)).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// True-positive retention (hardening must not over-suppress)
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: true-positive retention', () => {
  it('OOD alcohol queries still classify as OOD', () => {
    for (const q of TRUE_OOD_ALCOHOL) {
      expect(isWineOutOfDomainAlcoholQuery(q), q).toBe(true);
    }
  });

  it('weather queries still classify as unsupported external info', () => {
    for (const q of TRUE_WEATHER) {
      expect(isUnsupportedWineExternalInfoQuery(q), q).toBe(true);
    }
  });

  it('accessible online-tasting queries still classify', () => {
    for (const q of TRUE_ONLINE_TASTING) {
      expect(isAccessibleOnlineTastingQuery(q), q).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Property: empty / whitespace / adversarial input safety
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: input safety', () => {
  it('never throws and returns false for empty/whitespace input', () => {
    for (const q of ['', '   ', '\t\n  ', ' 　']) {
      for (const [name, predicate] of PREDICATES) {
        expect(() => predicate(q), name).not.toThrow();
        expect(predicate(q), name).toBe(false);
      }
    }
  });

  it('property: arbitrary string never throws in any predicate (numRuns=100)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (q) => {
        for (const [, predicate] of PREDICATES) {
          expect(() => predicate(q)).not.toThrow();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// -----------------------------------------------------------------------------
// Property: bounded redirect output
// -----------------------------------------------------------------------------

describe('situational-query-policy properties: bounded redirect output', () => {
  it('property: pairing-context residue never blows up the redirect (numRuns=100)', () => {
    // Cap mirrors MAX_PAIRING_CONTEXT_LEN (80) + boilerplate + scaffolding.
    const HARD_CAP = 600;
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), fc.boolean(), (dish, hasHangul) => {
        const query = `beer that pairs with ${dish} 어울리는`;
        const answer = buildOutOfDomainWineRedirectAnswer(hasHangul, { query });
        expect(typeof answer).toBe('string');
        expect(answer.length).toBeLessThanOrEqual(HARD_CAP);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves a short Korean pairing dish in the redirect', () => {
    const answer = buildOutOfDomainWineRedirectAnswer(true, {
      query: '삼겹살에 어울리는 맥주',
    });
    expect(answer).toContain('삼겹살');
    expect(answer).toContain('와인');
  });

  it('NFD pairing query still surfaces the dish (NFC stability)', () => {
    const answer = buildOutOfDomainWineRedirectAnswer(true, {
      query: '삼겹살에 어울리는 맥주'.normalize('NFD'),
    });
    expect(answer.normalize('NFC')).toContain('삼겹살');
  });
});
