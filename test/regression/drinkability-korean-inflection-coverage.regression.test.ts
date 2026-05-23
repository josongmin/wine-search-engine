/**
 * Regression: Korean grammar coverage for the drinkability detector
 * (`hasDrinkabilityKeyword`).
 *
 * Bench scenarios #15 ("…둘 다 지금 마시기 좋은지도 알려줘") and #117
 * ("…두 와인 모두 지금 마시기 좋은지 확인해줘") asked an embedded-question
 * drinkability form (`-은지` / `-은지도`) that the original keyword regex
 * MISSED — its alternation only covered (`아|은|을|을까|을지`) and demanded
 * a non-letter immediately after the inflection. With "좋은지" the `은` matches
 * but the lookahead fails on the following `지` (letter), so the predicate
 * returns false; the deterministic `searchDefaults.drinking_window` never
 * gets set, and the verification-step requirement has ZERO constraint atoms
 * even though the user explicitly asked about current drinkability.
 *
 * That gap had a structural downstream effect: the L1 verify gate's
 * comparison_search path can only distinguish "covered vs uncovered" when
 * the requirement has atoms to track. Empty atoms collapse to
 * `uncovered.length === 0` trivially, which fed the L1 narrowing the wrong
 * signal. Fixing the regex restores the proper signal upstream — SSoT
 * structural improvement, not a gate-level workaround.
 *
 * Test discipline (CLAUDE.md rules 5/8): regex changes touching Korean
 * MUST verify ASCII, accented Latin, Korean, and emoji cases — and MUST NOT
 * use `\b` for non-ASCII boundaries.
 */

import { describe, expect, it } from 'vitest';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
} from '../../src/domain/query/service/exact-entity-metadata-signals.js';

describe('drinkability regex — Korean embedded-question inflections (bench #15 / #117 RCA)', () => {
  // Forms the original regex MISSED. The fix MUST cover all of these without
  // collapsing the existing positive cases.
  const newPositives = [
    '오푸스원 지금 마시기 좋은지 알려줘',           // -은지 (whether)
    '둘 다 지금 마시기 좋은지도 알려줘',             // -은지도 (also/whether) — bench #15
    '두 와인 모두 지금 마시기 좋은지 확인해줘',     // -은지 (verify) — bench #117
    '오푸스원 지금 마시기 좋은지만 알려줘',         // -은지만 (only whether)
    '이 와인 지금 마시기 좋은가?',                   // -은가 (interrogative)
    '지금 마시기 좋습니까?',                         // -습니까 (polite interrogative)
  ];

  for (const q of newPositives) {
    it(`detects "${q}" as a drinkability keyword`, () => {
      expect(hasDrinkabilityKeyword(q)).toBe(true);
      // Drinkability is also a subset of entity-metadata (line 25 spread).
      expect(hasEntityMetadataKeyword(q)).toBe(true);
    });
  }

  // Pre-existing positives — must keep matching.
  const backCompatPositives = [
    '오푸스원 지금 마시기 좋아?',
    '오푸스원 지금 마실 수 있어?',
    'drinking window for Opus One 2018',             // English direct phrase
    'When to drink Opus One 2018?',
    'Is Margaux 2015 currently drinkable?',
  ];

  for (const q of backCompatPositives) {
    it(`still detects pre-existing positive "${q}"`, () => {
      expect(hasDrinkabilityKeyword(q)).toBe(true);
    });
  }

  // False-positive guards: legitimate domain queries that contain SUBSTRINGS
  // of the new alternation tokens but are NOT drinkability questions. CLAUDE.md
  // rule 23 — security/structural patterns blocking queries must include
  // at least one false-positive test.
  const negatives = [
    '오푸스원 추천해줘',                              // bare recommendation, no drinkability
    '보르도 가격 알려줘',                            // price, not drinkability
    '이 와인은 어떤가요',                            // attributive 가요, no 마시기/마실/drink
    '좋은 와인 추천해줘',                            // 좋은 in another context (no 마시기)
    '와인 좋아하시나요',                             // 좋아 but not 마시기 좋아
    'How does it taste?',                            // tasting, not drinkability
    '🍷 wine emoji query',                           // emoji + non-drink
  ];

  for (const q of negatives) {
    it(`does NOT false-positive on "${q}"`, () => {
      expect(hasDrinkabilityKeyword(q)).toBe(false);
    });
  }
});
