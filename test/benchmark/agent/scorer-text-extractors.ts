/**
 * Text extractors — pull prices, vintage years, and Latin proper nouns out of
 * free-text observations / agent answers for scoring.
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition. The three
 * public functions are re-exported from `./scorer.ts` so existing imports
 * (test/benchmark/agent/__tests__/scorer.test.ts, etc.) keep working.
 *
 * Currency conversion constants live here because they are ONLY used by the
 * price extractor — keeping them next to the function avoids cross-file
 * coupling. The USD rate is synced with the production-side constant
 * (KRW_PER_USD_APPROXIMATE) to prevent scorer/pipeline drift (CLAUDE.md rule 30).
 */

import { KRW_PER_USD_APPROXIMATE } from '../../../src/domain/shared/constants.js';

/** Korean 만원 multiplier for price extraction. */
const MAN_WON_MULTIPLIER = 10_000;
/**
 * Approximate USD→KRW rate for price extraction.
 * v4: synced with production constant KRW_PER_USD_APPROXIMATE (src/domain/shared/constants.ts).
 * The scorer and production search pipeline must use the same rate — otherwise the
 * scorer rejects prices that the pipeline correctly surfaced (3.7% systematic bias
 * at the old 1,400 vs production's 1,350). If the shared constant changes, update here too.
 */
const USD_TO_KRW_APPROX = KRW_PER_USD_APPROXIMATE;
/** Approximate EUR→KRW rate for price extraction (€1 ≈ ₩1,500). */
const EUR_TO_KRW_APPROX = 1_500;
/** Approximate GBP→KRW rate for price extraction (£1 ≈ ₩1,700). */
const GBP_TO_KRW_APPROX = 1_700;

/** Extract Korean-style prices: "5만원", "100,000원", "50000원", "$50"
 * @internal exported for direct unit testing of the extractor. */
export function extractKoreanPrices(text: string): number[] {
  const prices: number[] = [];
  // N만원 pattern (만 = 10,000)
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*만\s*원/gu)) {
    prices.push(Number(m[1]) * MAN_WON_MULTIPLIER);
  }
  // Plain numbers + 원 (e.g. 50,000원 or 50000원)
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/gu)) {
    prices.push(Number(m[1]!.replace(/,/g, '')));
  }
  // Dollar amounts ($50 or $ 50.00)
  for (const m of text.matchAll(/\$\s*(\d+(?:\.\d+)?)/gu)) {
    prices.push(Number(m[1]) * USD_TO_KRW_APPROX);
  }
  // Euro amounts (€50 or € 50.00)
  for (const m of text.matchAll(/€\s*(\d+(?:\.\d+)?)/gu)) {
    prices.push(Number(m[1]) * EUR_TO_KRW_APPROX);
  }
  // Pound amounts (£50 or £ 50.00)
  for (const m of text.matchAll(/£\s*(\d+(?:\.\d+)?)/gu)) {
    prices.push(Number(m[1]) * GBP_TO_KRW_APPROX);
  }
  return prices;
}

/** Min/max gap (in years) for a YYYY-YYYY dash pair to look like a drinking
 *  window rather than two independent vintages. 5 years is the shortest plausible
 *  hold-and-drink range; 30 years is the upper bound for fine-aging recommendations. */
const DRINK_WINDOW_DASH_PAIR_MIN_GAP_YEARS = 5;
const DRINK_WINDOW_DASH_PAIR_MAX_GAP_YEARS = 30;
/** Width (in chars) of a 4-digit vintage year — used to skip past the
 *  previous match when computing the gap between two YYYY values. */
const VINTAGE_YEAR_DIGIT_COUNT = 4;

/** Drinking-window context keywords: a year preceded (within ~30 chars) by these
 * is likely a drinking-window endpoint, not a wine vintage. Used by
 * extractVintageYears to filter false positives like "best consumed 2025–2035"
 * or "drink: 2024-2038". */
const DRINK_WINDOW_CONTEXT_RE = /(?:drink(?:ing)?|음용|마시기|peak|hold\s*until|closed|셀러링?|적기|through|까지|~)\s*(?:window|기간)?\s*:?\s*$/iu;

/** Extract 4-digit years that look like wine vintages (1600-2099).
 *  Range extended from 1800 to 1600 to cover rare historic bottles
 *  (pre-phylloxera Bordeaux, Madeira, Tokaji) found in collector queries.
 *  Uses Unicode-safe boundaries instead of \b (CLAUDE.md rule 8).
 *
 *  v4: filters drinking-window years. A year whose left-context (30 chars) matches
 *  DRINK_WINDOW_CONTEXT_RE is likely a drinking window endpoint, not a vintage.
 *  Also filters the second year of a YYYY-YYYY or YYYY–YYYY dash pair when
 *  the gap is 5-30 years (plausible drinking window span).
 * @internal exported for direct unit testing of the extractor. */
export function extractVintageYears(text: string): number[] {
  const CONTEXT_LOOKBACK = 30;
  const years: number[] = [];
  const allMatches: { year: number; index: number }[] = [];
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}])(1[6-9]\d{2}|20\d{2})(?=$|[^\p{L}\p{N}])/gu)) {
    allMatches.push({ year: Number(m[1]), index: m.index });
  }

  for (let i = 0; i < allMatches.length; i++) {
    const { year, index } = allMatches[i]!;
    // Check left-context for drinking-window vocabulary
    const leftContext = text.slice(Math.max(0, index - CONTEXT_LOOKBACK), index);
    if (DRINK_WINDOW_CONTEXT_RE.test(leftContext)) continue;

    // Check if this is the second year of a YYYY-YYYY dash pair (drinking window range)
    if (i > 0) {
      const prev = allMatches[i - 1]!;
      const gap = year - prev.year;
      const betweenText = text.slice(prev.index + VINTAGE_YEAR_DIGIT_COUNT, index).trim();
      // Only filter if the gap looks like a drinking window (5-30 years)
      // and the separator is a dash/endash
      if (
        gap >= DRINK_WINDOW_DASH_PAIR_MIN_GAP_YEARS
        && gap <= DRINK_WINDOW_DASH_PAIR_MAX_GAP_YEARS
        && /^[-–]$/.test(betweenText)
      ) continue;
    }

    years.push(year);
  }
  return years;
}

/**
 * Extract wine-name-like sequences from text. Handles ONLY Latin proper nouns
 * (capitalized multi-word). Korean transliterations of wine names are NOT
 * extracted because:
 *
 * 1. Wine database entries are Latin (Opus One, Château Margaux), and observations
 *    emit them in Latin. Korean transliterations in the agent answer ('오푸스 원')
 *    would need a transliteration map to match — neither side can do this
 *    reliably with a regex.
 * 2. The Korean Hangul-block extraction (`[가-힣]{2,}`) was producing
 *    massive false positives ('좋은와인입니다', '맛있습니다', '추천드립니다'),
 *    which required progressively more stopwords and predicate-suffix filters —
 *    the textbook regex-tightening trap.
 * 3. For mustCiteFromToolResults the Latin path catches the canonical wine names
 *    (e.g., the agent writes "Opus One"); for citation grounding of Korean-named
 *    wines, an LLM judge with the rubric "Every wine mentioned must have appeared
 *    in tool results" handles cross-script matching semantically.
 *
 * v4 STRUCTURAL FIX: removed Korean Hangul extraction + KOREAN_PROPER_NOUN_STOPWORDS
 * + KOREAN_PREDICATE_SUFFIX_RE filter. The function is now Latin-only and
 * deterministic. Korean wine name grounding is delegated to the judge's
 * mustCiteFromToolResults rubric criterion.
 * @internal exported for direct unit testing of the extractor. */
export function extractProperNouns(text: string): string[] {
  // Latin proper nouns: "Opus One", "Château Margaux", "Screaming Eagle"
  // Unicode-aware boundary: \b is ASCII-only and silently fails on accented
  // Latin names (Château, Côte). Use lookahead/lookbehind for non-word chars.
  const latinMatches = text.match(/(?:^|(?<=[\s,;:(]))(?:[A-Z][a-zA-Z'À-ſ-]+(?:\s+[A-Z][a-zA-Z'À-ſ-]+)*)(?=$|[\s,;:.)])/g);
  return latinMatches ?? [];
}
