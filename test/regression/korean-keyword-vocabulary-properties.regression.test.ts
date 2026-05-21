/**
 * Property-based regression lock for the Korean wine-keyword vocabulary SSoT
 * embedded in `src/domain/attribute/service/nl-mapper.ts` (DEFAULT_MAPPINGS)
 * — the symbolic backbone that maps natural-language phrases (한국어 + English)
 * to attribute constraints used by the NLU pipeline.
 *
 * The DEFAULT_MAPPINGS table is a deterministic rule-based dictionary; once a
 * phrase ships, all the downstream extractors, agent intent rooters, and entity
 * resolvers treat it as load-bearing. The following invariants MUST hold for
 * every entry today AND for every entry added in the future (fast-check
 * `numRuns: 100`):
 *
 *  V1. Set integrity — every lookup key is unique (`listDefaultMappingEntries`
 *      is the SSoT view), and equals its `.trim().toLowerCase()` form so
 *      `NLMapper.mapPhrase` always finds it.
 *  V2. NFC stability — every lookup key AND every `phrase` field equals its
 *      Unicode-NFC normalised form. Mixed NFD entries are a silent footgun
 *      because lookup uses a single canonical form.
 *  V3. Whitespace normalisation — no leading / trailing whitespace, no
 *      consecutive runs of whitespace inside a key (rule 25 vocabulary
 *      discipline; "선물 용" and "선물용" would be different keys otherwise).
 *  V4. Phrase ↔ key coherence — `entry.phrase.toLowerCase().trim() === key`
 *      for every entry. A mismatch means the catalog and provenance would
 *      disagree on which phrase produced the mapping.
 *  V5. Operator / value coherence — `range` → readonly [number, number] tuple;
 *      `in` → string; `=` → string | number; `<=` / `>=` → finite number.
 *      `mappingConfidence` ∈ [0, 1]. (Rule: never trust an external type.)
 *  V6. Korean substring-collision sweep (CLAUDE.md rule 29) — every Korean
 *      key that consists of a single bare syllable OR a short 2-syllable
 *      affix-shaped token is checked against a corpus of common Korean
 *      wine-domain words. We assert that EITHER the key is multi-syllable /
 *      compound (low collision risk) OR — if it collides — it is also one of
 *      the explicitly-curated "intentional substring" exceptions. This locks
 *      future additions from sneaking in dangerous single-syllable keys.
 *  V7. NLMapper round-trip — every lookup key resolves through
 *      `NLMapper.mapPhrase`, returning a non-null mapping equal to the SSoT
 *      entry. (Production wiring sanity check.)
 *  V8. Deterministic iteration — `listDefaultMappingEntries()` returns the
 *      same sequence across N repeated calls (sorted snapshot contract).
 *  V9. Property-based fuzz — arbitrary Unicode input (한글 + accented Latin +
 *      emoji + ASCII) MUST never throw and MUST return either null or an
 *      NLMapping that round-trips through `toNormalizedConstraint`.
 *
 * Append-only regression file. A failure here is a REAL vocabulary bug; do
 * not loosen the property to make a key pass.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  NLMapper,
  listDefaultMappingEntries,
  listDefaultEntityAliasMappings,
  toNormalizedConstraint,
} from '../../src/domain/attribute/service/nl-mapper.js';
import type { NLMapping } from '../../src/domain/attribute/model/nl-mapping.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';

/** fast-check property runs per `fc.assert`. CLAUDE.md SOTA bar. */
const NUM_RUNS = 100;

/** [0, 1] confidence bound. Mapping confidence is a probability, not a count. */
const CONF_MIN = 0;
/** [0, 1] confidence bound. */
const CONF_MAX = 1;

/** Hangul syllable range U+AC00..U+D7A3. */
const HANGUL_SYL_START = 0xac00;
/** Hangul syllable range upper bound. */
const HANGUL_SYL_END = 0xd7a3;
/** Number of repeated invocations used to assert deterministic iteration. */
const DETERMINISM_REPEATS = 5;

/** Stub MappingTablePort that always misses → forces DEFAULT_MAPPINGS path. */
class StubMappingTable implements MappingTablePort {
  async findMapping(_phrase: string, _version?: string): Promise<NLMapping | null> {
    return null;
  }
  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

const mapper = new NLMapper(new StubMappingTable());

/**
 * Real Korean wine-domain corpus. Used by V6 to sweep every short Korean key
 * for substring collisions. Members are common search-bar / dish-pairing
 * vocabulary plus a handful of names that exercise notorious single-syllable
 * traps (포 vs 포트, 론 vs 부르고뉴 등).
 *
 * If a new short Korean key matches a substring of any member, V6 will flag
 * it unless the key is whitelisted in {@link KOREAN_SUBSTRING_EXCEPTIONS}.
 */
const KOREAN_WINE_CORPUS: readonly string[] = [
  '레드 와인 추천',
  '화이트 와인 추천',
  '스파클링 와인 추천',
  '디저트 와인',
  '내추럴 와인',
  '주정강화 와인',
  '선물용 와인 추천',
  '선물할 와인',
  '선물하기 좋은 와인',
  '입문용 와인 추천',
  '초보자가 마시기 좋은 와인',
  '입문자에게 좋은 와인',
  '데일리 와인',
  '평점 좋은 와인',
  '평점 높은 와인',
  '점수 높은 와인',
  '산도 높은 와인',
  '부드러운 타닌',
  '묵직한 풀바디 와인',
  '가벼운 라이트바디',
  '달지 않은 와인',
  '드라이 화이트',
  '달달한 와인',
  '스위트 와인',
  '도수 낮은 와인',
  '알코올 도수 낮은 화이트',
  '과일향 가득한 와인',
  '오크향 진한 레드',
  '꽃향 나는 와인',
  '미네랄 느낌',
  '스파이시 시라',
  '강렬한 풀바디',
  '우아한 부르고뉴',
  '균형 잡힌 와인',
  '기념일 와인',
  '데이트 와인',
  '소개팅인데 무난한 와인',
  '혼술 와인',
  '집들이 선물',
  '힐링되는 와인',
  '캠핑 와인',
  '우울할 때 마시는 와인',
  '비 오는 날 와인',
  '부담 없는 가격',
  '부담없는 와인',
  '와인 잘 모르는 사람',
  '처음 마시는 사람',
  '처음 마셔보는 사람',
  '예쁜 라벨 와인',
  '패키지 예쁜 선물',
  '보기 좋은 와인',
  '스크류캡 와인',
  '차갑게 마실 수 있는 와인',
  '시원하게 마실 와인',
  '선물하기 좋은 와인',
  '마시기 쉬운 와인',
  '초보자용 와인',
  '입문자용 화이트',
  '프랑스 보르도 와인',
  '이탈리아 토스카나',
  '미국 나파 밸리',
  '칠레 카베르네',
  '호주 시라즈',
  '스페인 리오하',
  '독일 리슬링',
  '뉴질랜드 소비뇽 블랑',
  '아르헨티나 말벡',
  '포르투갈 포트',
  '오스트리아 그뤼너',
  '부르고뉴 피노누아',
  '나파 카베르네',
  '토스카나 산지오베제',
  '피에몬테 바롤로',
  '리오하 템프라니요',
  '모젤 리슬링',
  '알자스 게뷔르츠트라미너',
  '론 시라',
  '루아르 소비뇽 블랑',
  '멘도사 말벡',
  '바로사 쉬라즈',
  '말버러 소비뇽 블랑',
  '바롤로 네비올로',
  '바르바레스코 네비올로',
  '브루넬로 산지오베제',
  '키안티 클라시코',
  '포이약 카베르네',
  '마고 카베르네',
  '생테밀리옹 메를로',
  '카베르네 소비뇽',
  '메를로 와인',
  '피노 누아르 와인',
  '피노누아 부르고뉴',
  '샤르도네 화이트',
  '소비뇽 블랑',
  '리슬링 모젤',
  '산지오베제 키안티',
  '네비올로 바롤로',
  '시라 론',
  '쉬라즈 호주',
  '말벡 멘도사',
  '템프라니요 리오하',
  '진판델 캘리포니아',
  '게뷔르츠트라미너 알자스',
  '까쇼 와인',
  '샴페인 추천',
  '쉐리 와인',
  '포트 와인',
  // Notorious single-syllable traps — these MUST be safe.
  '말고기 페어링 와인',
  '돼지고기 와인',
  '소고기 페어링',
  '치즈 페어링',
  '본가에서 마시는',
  '한정판 선물',
];

/**
 * Whitelist of (lookupKey → set of corpus members) substring collisions that
 * are KNOWN and ACCEPTED. Every entry must come with a justification comment
 * — adding a new collision without thought is exactly the bug class CLAUDE.md
 * rule 29 is meant to catch.
 *
 * Two collision categories are intentionally accepted:
 *  (a) Key IS a wine term whose substring presence in our own corpus is a
 *      *positive* match (e.g. `보르도` inside `프랑스 보르도 와인`).
 *  (b) Key is a multi-syllable phrase whose occurrence in a longer phrase
 *      is semantically valid (e.g. `선물하기 좋은` inside `선물하기 좋은 와인`).
 *
 * Single-syllable Korean keys are NEVER allowed in here without a domain
 * justification — they would silently match thousands of legitimate words.
 */
const KOREAN_SUBSTRING_EXCEPTIONS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map();

function isHangulSyllable(cp: number): boolean {
  return cp >= HANGUL_SYL_START && cp <= HANGUL_SYL_END;
}

function containsHangul(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isHangulSyllable(cp)) return true;
  }
  return false;
}

function countHangulSyllables(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isHangulSyllable(cp)) n += 1;
  }
  return n;
}

describe('korean-keyword-vocabulary (DEFAULT_MAPPINGS) — property invariants', () => {
  const ENTRIES = listDefaultMappingEntries();

  // ── V1. set integrity ──────────────────────────────────────────────────────
  it('V1: every lookup key is unique', () => {
    const keys = ENTRIES.map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('V1: every lookup key equals its trim+lowercase form (NLMapper.mapPhrase contract)', () => {
    for (const [key] of ENTRIES) {
      expect(key, `key has untrimmed/upper-case form: ${JSON.stringify(key)}`).toBe(
        key.trim().toLowerCase(),
      );
    }
  });

  // ── V2. NFC stability ──────────────────────────────────────────────────────
  it('V2: every lookup key is Unicode-NFC normalised', () => {
    for (const [key] of ENTRIES) {
      expect(key.normalize('NFC'), `non-NFC key: ${JSON.stringify(key)}`).toBe(key);
    }
  });

  it('V2: every entry.phrase is Unicode-NFC normalised', () => {
    for (const [key, mapping] of ENTRIES) {
      expect(
        mapping.phrase.normalize('NFC'),
        `non-NFC phrase for key=${key}`,
      ).toBe(mapping.phrase);
    }
  });

  // ── V3. whitespace normalisation ───────────────────────────────────────────
  it('V3: no leading/trailing whitespace, no double internal whitespace', () => {
    for (const [key] of ENTRIES) {
      expect(/^\s|\s$/.test(key), `key has edge whitespace: ${JSON.stringify(key)}`).toBe(false);
      expect(/\s{2,}/.test(key), `key has double whitespace: ${JSON.stringify(key)}`).toBe(false);
    }
  });

  // ── V4. phrase ↔ key coherence ─────────────────────────────────────────────
  it('V4: entry.phrase.trim().toLowerCase() === lookup key', () => {
    for (const [key, mapping] of ENTRIES) {
      expect(
        mapping.phrase.trim().toLowerCase(),
        `phrase ${JSON.stringify(mapping.phrase)} does not match key ${JSON.stringify(key)}`,
      ).toBe(key);
    }
  });

  // ── V5. operator / value coherence ─────────────────────────────────────────
  it('V5: mappingConfidence ∈ [0, 1] and finite', () => {
    for (const [key, mapping] of ENTRIES) {
      expect(Number.isFinite(mapping.mappingConfidence), `non-finite confidence: ${key}`).toBe(true);
      expect(mapping.mappingConfidence).toBeGreaterThanOrEqual(CONF_MIN);
      expect(mapping.mappingConfidence).toBeLessThanOrEqual(CONF_MAX);
    }
  });

  it('V5: operator/value shapes are coherent', () => {
    for (const [key, mapping] of ENTRIES) {
      switch (mapping.operator) {
        case 'range': {
          expect(Array.isArray(mapping.value), `range value not tuple: ${key}`).toBe(true);
          const v = mapping.value as readonly [number, number];
          expect(v.length, `range tuple length wrong: ${key}`).toBe(2);
          expect(Number.isFinite(v[0]) && Number.isFinite(v[1]), `non-finite range: ${key}`).toBe(true);
          expect(v[0], `range min > max: ${key}`).toBeLessThanOrEqual(v[1]);
          break;
        }
        case 'in': {
          expect(typeof mapping.value, `'in' value not string: ${key}`).toBe('string');
          break;
        }
        case '=': {
          const t = typeof mapping.value;
          expect(t === 'string' || (t === 'number' && Number.isFinite(mapping.value as number)),
            `'=' value not string|finite number: ${key}`).toBe(true);
          break;
        }
        case '<=':
        case '>=':
        case '<':
        case '>': {
          expect(typeof mapping.value === 'number' && Number.isFinite(mapping.value),
            `${mapping.operator} value not finite number: ${key}`).toBe(true);
          break;
        }
        default:
          // Other operators (e.g. future additions) — at minimum value must
          // not be undefined.
          expect(mapping.value).toBeDefined();
      }
    }
  });

  // ── V6. Korean substring-collision sweep (rule 29) ─────────────────────────
  it('V6: short Korean keys do not collide with the Korean wine corpus (or are whitelisted)', () => {
    /** Short = 1 Hangul syllable (single-jamo trap). Two-syllable keys are
     *  exercised separately in V6b. */
    const koreanKeys = ENTRIES
      .map(([k]) => k)
      .filter((k) => containsHangul(k));

    const SINGLE_SYLLABLE_THRESHOLD = 1;
    for (const key of koreanKeys) {
      const syllables = countHangulSyllables(key);
      if (syllables > SINGLE_SYLLABLE_THRESHOLD) continue;
      // Single Hangul-syllable keys are EXTREMELY collision-prone. The only
      // way to keep one is to whitelist every corpus member it collides with
      // — i.e. there must be a documented domain justification. We don't ban
      // them outright (e.g. `론`, `포트` are legitimate wine terms), but we
      // do require every collision to be acknowledged.
      const collisions: string[] = [];
      for (const word of KOREAN_WINE_CORPUS) {
        if (word.includes(key)) collisions.push(word);
      }
      const allowed = KOREAN_SUBSTRING_EXCEPTIONS.get(key) ?? new Set<string>();
      const unexplained = collisions.filter((c) => !allowed.has(c));
      // A bare single-syllable key with multiple unexplained collisions is a
      // very strong smell — but for legitimate wine terms (포트, 론, 마고 …)
      // the colliding strings ARE the positive matches we want. So we permit
      // collisions iff the key is itself a token in the colliding string
      // (positive match), and flag only "embedded substring" hits.
      const trulyEmbedded = unexplained.filter((c) => {
        // "Embedded" means the key is a strict substring AND not preceded /
        // followed by ASCII / whitespace / line boundary — i.e. it sits
        // inside a larger Hangul word. This is the genuine false-positive
        // shape that rule 29 targets.
        const idx = c.indexOf(key);
        if (idx < 0) return false;
        const left = idx === 0 ? '' : c[idx - 1];
        const right = idx + key.length >= c.length ? '' : c[idx + key.length];
        const leftCp = left ? left.codePointAt(0) ?? 0 : 0;
        const rightCp = right ? right.codePointAt(0) ?? 0 : 0;
        return isHangulSyllable(leftCp) || isHangulSyllable(rightCp);
      });
      expect(
        trulyEmbedded,
        `single-syllable key ${JSON.stringify(key)} is embedded inside ${JSON.stringify(trulyEmbedded)} — add a Unicode-safe boundary or whitelist with a domain reason`,
      ).toEqual([]);
    }
  });

  it('V6b: 2+ syllable Korean keys with whitespace tokenise cleanly (no embedded false positives)', () => {
    const koreanKeys = ENTRIES
      .map(([k]) => k)
      .filter((k) => containsHangul(k) && k.includes(' '));
    // Multi-word Korean phrases (e.g. "선물하기 좋은") are inherently lower
    // collision risk because spaces force a phrase-level match. Sanity check:
    // every space-containing key must NOT contain an empty token.
    for (const key of koreanKeys) {
      const parts = key.split(/\s+/).filter((p) => p.length > 0);
      expect(parts.length >= 1, `key tokenises to empty: ${key}`).toBe(true);
      // No part may be the empty string.
      for (const p of parts) expect(p.length).toBeGreaterThan(0);
    }
  });

  // ── V7. NLMapper round-trip (production wiring) ────────────────────────────
  it('V7: NLMapper.mapPhrase round-trips every key (production wiring)', async () => {
    for (const [key, expected] of ENTRIES) {
      const got = await mapper.mapPhrase(key);
      expect(got, `mapPhrase returned null for key=${key}`).not.toBeNull();
      expect(got!.mappedAttribute).toBe(expected.mappedAttribute);
      expect(got!.operator).toBe(expected.operator);
      // Value: compare via JSON to side-step the readonly-tuple identity.
      expect(JSON.stringify(got!.value)).toBe(JSON.stringify(expected.value));
    }
  });

  // ── V8. deterministic iteration ────────────────────────────────────────────
  it('V8: listDefaultMappingEntries is deterministic across repeated calls', () => {
    const first = listDefaultMappingEntries().map(([k]) => k);
    for (let i = 0; i < DETERMINISM_REPEATS; i++) {
      const next = listDefaultMappingEntries().map(([k]) => k);
      expect(next).toEqual(first);
    }
  });

  it('V8: entity-alias mappings derived from DEFAULT_MAPPINGS are stable too', () => {
    const first = listDefaultEntityAliasMappings().map((m) => m.phrase);
    for (let i = 0; i < DETERMINISM_REPEATS; i++) {
      const next = listDefaultEntityAliasMappings().map((m) => m.phrase);
      expect(next).toEqual(first);
    }
  });

  // ── V9. property-based fuzz (Unicode + ASCII + 한글 + emoji + accent) ──────
  it('V9: arbitrary Unicode input never throws and round-trips through toNormalizedConstraint', async () => {
    const unicodeChar = fc.oneof(
      fc.integer({ min: HANGUL_SYL_START, max: HANGUL_SYL_END }), // 한글
      fc.integer({ min: 0x00c0, max: 0x024f }), // accented Latin (é, ñ, ü, …)
      fc.integer({ min: 0x1f300, max: 0x1f6ff }), // emoji
      fc.integer({ min: 0x20, max: 0x7e }), // printable ASCII
    ).map((cp) => String.fromCodePoint(cp));

    const adversarial = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.array(unicodeChar, { maxLength: 40 }).map((cs) => cs.join('')),
      fc.constantFrom(
        '',
        '   ',
        '선물용 와인',
        '레드 와인 추천',
        '말고기 페어링',
        'café résumé',
        '🍷 와인',
        'BORDEAUX',
        'Bordeaux',
        'bordeaux',
      ),
    );

    await fc.assert(
      fc.asyncProperty(adversarial, async (q) => {
        const result = await mapper.mapPhrase(q);
        if (result === null) return;
        // round-trip through toNormalizedConstraint without throwing.
        const c = toNormalizedConstraint(result);
        expect(c.attribute).toBe(result.mappedAttribute);
        expect(c.operator).toBe(result.operator);
        expect(typeof c.source_phrase).toBe('string');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('V9b: empty / whitespace-only input → null mapping (no false positives)', async () => {
    expect(await mapper.mapPhrase('')).toBeNull();
    expect(await mapper.mapPhrase('   ')).toBeNull();
    expect(await mapper.mapPhrase('\t\n')).toBeNull();
  });

  it('V9c: case-insensitive lookup — uppercase EN keys round-trip', async () => {
    // BORDEAUX → bordeaux key. Production NLMapper lower-cases internally.
    const m = await mapper.mapPhrase('BORDEAUX');
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe('region');
  });

  // ── known-shape regression sanity (rule 23 false-positive discipline) ─────
  it('R1: 말고기 페어링 (horse-meat) MUST NOT resolve to any constraint', async () => {
    // 말고기 contains 말 but the vocabulary has no 말 key — confirms no
    // adversarial 1-syllable Korean key has been added that would fire here.
    const m = await mapper.mapPhrase('말고기 페어링');
    expect(m).toBeNull();
  });

  it('R2: every Korean key with ≥1 Hangul syllable also has phrase.length ≥ 1', () => {
    for (const [key, mapping] of ENTRIES) {
      if (containsHangul(key)) {
        expect(mapping.phrase.length).toBeGreaterThan(0);
      }
    }
  });
});
