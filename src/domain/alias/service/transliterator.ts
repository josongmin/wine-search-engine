import type { AliasType } from '../model/alias.js';
import { stripVintageYears } from '../../shared/utils/vintage.js';
import {
  buildHangulJamoKey,
  containsHangul as sharedContainsHangul,
} from '../../shared/utils/hangul.js';

/**
 * Result of generating a transliterated alias.
 */
interface TransliterationResult {
  /** The transliterated surface form. */
  readonly value: string;
  /** Alias type classification. */
  readonly type: AliasType;
  /**
   * Confidence that this transliteration is correct.
   * Range [0, 1]. This is NOT a calibrated decision confidence C.
   */
  readonly confidence: number;
}

/** Supported source languages for transliteration. */
export type SourceLang = 'fr' | 'it' | 'es' | 'en';

/** High confidence when label hits curated exception dictionary. */
const TRANSLITERATION_EXCEPTION_CONFIDENCE = 0.95;
/** Default confidence for rule-based transliteration (non-exception). */
const TRANSLITERATION_RULE_CONFIDENCE = 0.75;
/** Compact phonetic variant confidence (space-stripped primary). */
const TRANSLITERATION_COMPACT_CONFIDENCE = 0.6;

/**
 * Cross-lingual transliterator for wine domain terms.
 * Implements RFC-003 §4.5 with rule-based French/Italian/Spanish/English
 * to Korean transliteration, plus an exception dictionary for established names.
 */
export class Transliterator {
  private static KO_TO_LATIN_IME_PREFIX_INDEX:
    | ReadonlyMap<string, readonly {
      readonly latin: string;
      readonly jamoKey: string;
      readonly syllableBoundaryOffsets: ReadonlySet<number>;
    }[]>
    | undefined;
  /**
   * French to Korean transliteration rules.
   * Ordered from longest to shortest match to ensure greedy matching.
   */
  private static readonly FR_KO_RULES: ReadonlyMap<string, string> = new Map([
    // Multi-character patterns (must precede single-char)
    ['château', '샤또'],
    ['chateau', '샤또'],
    ['chât', '샤'],
    ['chat', '샤'],
    ['ch', '슈'],
    ['ph', '프'],
    ['th', '트'],
    ['ou', '우'],
    ['au', '오'],
    ['eau', '오'],
    ['eux', '외'],
    ['ain', '앙'],
    ['ein', '앙'],
    ['on', '옹'],
    ['an', '앙'],
    ['en', '앙'],
    ['in', '앙'],
    ['gn', '뉴'],
    ['gu', '그'],
    ['qu', '크'],
    ['oi', '와'],
    ['ui', '위'],
    ['ille', '이유'],
    ['il', '일'],
    ['tion', '시옹'],
    ['sion', '시옹'],
    // Standalone words / fragments common in wine
    ['margaux', '마고'],
    ['haut', '오'],
    ['lafite', '라피트'],
    ['rothschild', '로칠드'],
    ['saint', '생'],
    ['mouton', '무통'],
    ['latour', '라투르'],
    ['petrus', '페트뤼스'],
    ['pétrus', '페트뤼스'],
    ['médoc', '메독'],
    ['medoc', '메독'],
    ['pauillac', '포이약'],
    ['pomerol', '포므롤'],
    ['émilion', '에밀리옹'],
    ['emilion', '에밀리옹'],
    ['bordeaux', '보르도'],
    ['bourgogne', '부르고뉴'],
    ['burgundy', '부르고뉴'],
    ['champagne', '샴페인'],
    ['loire', '루아르'],
    ['rhône', '론'],
    ['rhone', '론'],
    ['alsace', '알자스'],
    ['chablis', '샤블리'],
    ['beaujolais', '보졸레'],
    ['sauternes', '소테른'],
    ['graves', '그라브'],
    // Single consonants / vowels (fallback)
    ['a', '아'],
    ['b', '브'],
    ['c', '크'],
    ['d', '드'],
    ['e', '에'],
    ['é', '에'],
    ['è', '에'],
    ['ê', '에'],
    ['f', '프'],
    ['g', '그'],
    ['h', ''],
    ['i', '이'],
    ['j', '주'],
    ['k', '크'],
    ['l', '르'],
    ['m', '므'],
    ['n', '느'],
    ['o', '오'],
    ['ô', '오'],
    ['p', '프'],
    ['r', '르'],
    ['s', '스'],
    ['t', '트'],
    ['u', '위'],
    ['û', '위'],
    ['v', '브'],
    ['w', '우'],
    ['x', '크스'],
    ['y', '이'],
    ['z', '즈'],
  ]);

  /**
   * Spanish to Korean transliteration rules.
   * Ordered longest-first for greedy matching.
   */
  private static readonly ES_KO_RULES: ReadonlyMap<string, string> = new Map([
    // Wine estate / region names (exceptions-first, then patterns)
    ['rioja', '리오하'],
    ['ribera', '리베라'],
    ['rueda', '루에다'],
    ['penedes', '페네데스'],
    ['priorat', '프리오라트'],
    ['cava', '카바'],
    ['jerez', '헤레스'],
    ['málaga', '말라가'],
    ['malaga', '말라가'],
    ['galicia', '갈리시아'],
    ['toro', '토로'],
    ['jumilla', '후미야'],
    ['bierzo', '비에르소'],
    ['duero', '두에로'],
    // Multi-char patterns
    ['ll', '이'],
    ['ñ', '냐'],
    ['ch', '츠'],
    ['rr', '르'],
    ['gu', '구'],
    ['qu', '크'],
    ['ue', '웨'],
    ['ie', '예'],
    ['cion', '시온'],
    ['tion', '시온'],
    ['ez', '에스'],
    ['ia', '이아'],
    ['io', '이오'],
    // Single characters
    ['a', '아'],
    ['b', '브'],
    ['c', '크'],
    ['d', '드'],
    ['e', '에'],
    ['é', '에'],
    ['f', '프'],
    ['g', '그'],
    ['h', ''],
    ['i', '이'],
    ['j', '흐'],
    ['k', '크'],
    ['l', '르'],
    ['m', '므'],
    ['n', '느'],
    ['o', '오'],
    ['ó', '오'],
    ['p', '프'],
    ['q', '크'],
    ['r', '르'],
    ['s', '스'],
    ['t', '트'],
    ['u', '우'],
    ['ú', '우'],
    ['v', '브'],
    ['w', '우'],
    ['x', '흐스'],
    ['y', '이'],
    ['z', '스'],
  ]);

  /**
   * English to Korean transliteration rules for wine domain terms.
   * Primarily exception-based; fallback to FR rules for phonemes.
   */
  private static readonly EN_KO_RULES: ReadonlyMap<string, string> = new Map([
    // Common English wine terms / regions
    ['napa', '나파'],
    ['sonoma', '소노마'],
    ['valley', '밸리'],
    ['creek', '크릭'],
    ['estate', '이스테이트'],
    ['winery', '와이너리'],
    ['cellar', '셀러'],
    ['ridge', '릿지'],
    ['stag', '스태그'],
    ['opus', '오퍼스'],
    ['harvest', '하베스트'],
    ['vintage', '빈티지'],
    ['reserve', '리저브'],
    ['barrel', '배럴'],
    ['vineyard', '빈야드'],
    ['hills', '힐스'],
    ['acres', '에이커스'],
    // Multi-char English patterns
    ['th', '스'],
    ['wh', '우'],
    ['ph', '프'],
    ['gh', ''],
    ['sh', '시'],
    ['ch', '츠'],
    ['ck', '크'],
    ['ng', '이'],
    ['tion', '션'],
    ['igh', '아이'],
    ['ou', '아우'],
    ['ow', '아우'],
    ['oo', '우'],
    ['ee', '이'],
    ['ea', '이'],
    ['ai', '에이'],
    ['ay', '에이'],
    // Single characters
    ['a', '아'],
    ['b', '브'],
    ['c', '크'],
    ['d', '드'],
    ['e', '에'],
    ['f', '프'],
    ['g', '그'],
    ['h', ''],
    ['i', '이'],
    ['j', '주'],
    ['k', '크'],
    ['l', '르'],
    ['m', '므'],
    ['n', '느'],
    ['o', '오'],
    ['p', '프'],
    ['q', '크'],
    ['r', '르'],
    ['s', '스'],
    ['t', '트'],
    ['u', '우'],
    ['v', '브'],
    ['w', '우'],
    ['x', '크스'],
    ['y', '이'],
    ['z', '즈'],
  ]);

  /**
   * Italian to Korean transliteration rules.
   */
  private static readonly IT_KO_RULES: ReadonlyMap<string, string> = new Map([
    // Wine region/style names
    ['barolo', '바롤로'],
    ['brunello', '브루넬로'],
    ['chianti', '키안티'],
    ['amarone', '아마로네'],
    ['barbaresco', '바르바레스코'],
    ['montalcino', '몬탈치노'],
    ['valpolicella', '발폴리첼라'],
    ['prosecco', '프로세코'],
    ['sangiovese', '산지오베제'],
    ['nebbiolo', '네비올로'],
    ['montepulciano', '몬테풀치아노'],
    ['pinot', '피노'],
    ['grappa', '그라파'],
    ['toscana', '토스카나'],
    ['piemonte', '피에몬테'],
    ['veneto', '베네토'],
    ['sicilia', '시칠리아'],
    // Multi-character patterns
    ['gli', '글리'],
    ['gn', '뉴'],
    ['ch', '크'],
    ['gh', '그'],
    ['sc', '스크'],
    ['zz', '쯔'],
    ['cc', '끄'],
    ['ll', '를'],
    ['rr', '르'],
    ['ss', '스'],
    // Single characters
    ['a', '아'],
    ['b', '브'],
    ['c', '크'],
    ['d', '드'],
    ['e', '에'],
    ['f', '프'],
    ['g', '그'],
    ['h', ''],
    ['i', '이'],
    ['j', '주'],
    ['k', '크'],
    ['l', '르'],
    ['m', '므'],
    ['n', '느'],
    ['o', '오'],
    ['p', '프'],
    ['q', '크'],
    ['r', '르'],
    ['s', '스'],
    ['t', '트'],
    ['u', '우'],
    ['v', '브'],
    ['w', '우'],
    ['x', '크스'],
    ['y', '이'],
    ['z', '즈'],
  ]);

  /**
   * Exception dictionary for well-known wine names that have established
   * Korean transliterations differing from rule-based output.
   */
  private static readonly EXCEPTIONS: ReadonlyMap<string, string> = new Map([
    // French estates and brands
    ['opus one', '오푸스원'],
    ['moët', '모엣'],
    ['moet', '모엣'],
    ['dom pérignon', '돔 페리뇽'],
    ['dom perignon', '돔 페리뇽'],
    ['beaujolais nouveau', '보졸레 누보'],
    ['château margaux', '샤또 마고'],
    ['chateau margaux', '샤또 마고'],
    ['château lafite rothschild', '샤또 라피트 로칠드'],
    ['chateau lafite rothschild', '샤또 라피트 로칠드'],
    ['château mouton rothschild', '샤또 무통 로칠드'],
    ['chateau mouton rothschild', '샤또 무통 로칠드'],
    ['château latour', '샤또 라투르'],
    ['chateau latour', '샤또 라투르'],
    ['château haut-brion', '샤또 오브리옹'],
    ['chateau haut-brion', '샤또 오브리옹'],
    ['château pétrus', '샤또 페트뤼스'],
    ['chateau petrus', '샤또 페트뤼스'],
    ['château cheval blanc', '샤또 슈발 블랑'],
    ['chateau cheval blanc', '샤또 슈발 블랑'],
    ['louis vuitton', '루이 비통'],
    ['veuve clicquot', '뵈브 클리코'],
    ['laurent-perrier', '로랑 페리에'],
    ['taittinger', '테탱저'],
    ['krug', '크뤼그'],
    ['bollinger', '볼랑제'],
    ['ruinart', '뤼나르'],
    // Italian
    ['sassicaia', '사시카이아'],
    ['tignanello', '티냐넬로'],
    ['ornellaia', '오르넬라이아'],
    ['antinori', '안티노리'],
    ['gaja', '가야'],
    // New World — USA
    ['screaming eagle', '스크리밍 이글'],
    ['harlan estate', '할란 이스테이트'],
    ['ridge monte bello', '릿지 몬테 벨로'],
    ['stag\'s leap wine cellars', '스탁스 립 와인 셀러스'],
    ['caymus', '케이머스'],
    ['duckhorn', '덕혼'],
    ['silver oak', '실버 오크'],
    ['jordan', '조던'],
    ['beringer', '베린저'],
    // New World — Australia/NZ
    ['penfolds', '펜폴즈'],
    ['grange', '그랜지'],
    ['henschke', '헨시키'],
    ['cloudy bay', '클라우디 베이'],
    ['villa maria', '빌라 마리아'],
    ['leeuwin estate', '르윈 이스테이트'],
    // New World — Argentina
    ['catena zapata', '카테나 자파타'],
    ['achaval ferrer', '아차발 페레르'],
    ['zuccardi', '수카르디'],
    ['clos de los siete', '클로 드 로스 시에테'],
    // New World — Chile
    ['concha y toro', '콘차 이 토로'],
    ['almaviva', '알마비바'],
    ['don melchor', '돈 멜초르'],
    ['clos apalta', '클로스 아팔타'],
    // South Africa
    ['kanonkop', '카논코프'],
    ['meerlust', '메르루스트'],
    // Spanish estates
    ['vega sicilia', '베가 시실리아'],
    ['tempranillo', '템프라니요'],
    ['rioja', '리오하'],
    ['ribera del duero', '리베라 델 두에로'],
    ['alvaro palacios', '알바로 팔라시오스'],
    ['torres', '토레스'],
    ['pingus', '핑구스'],
    // German
    ['mosel', '모젤'],
    ['rheingau', '라인가우'],
    ['riesling', '리슬링'],
    ['spätlese', '슈페트레제'],
    ['auslese', '아우스레제'],
    ['trockenbeerenauslese', '트로켄베렌아우스레제'],
    ['egon müller', '에곤 뮬러'],
    ['jj prüm', '요한 요제프 프룸'],
    // Austrian
    ['grüner veltliner', '그뤼너 펠트리너'],
    ['blaufränkisch', '블라우프랜키시'],
    // Champagne houses (supplement)
    ['gosset', '고쎄'],
    ['pol roger', '폴 로저'],
    ['deutz', '도츠'],
    ['drappier', '드라피에'],
    // Burgundy producers
    ['domaine de la romanée-conti', '도멘 드 라 로마네 콩티'],
    ['romanée-conti', '로마네 콩티'],
    ['romanee-conti', '로마네 콩티'],
    ['leroy', '르루아'],
    ['armand rousseau', '아르망 루소'],
    ['drc', '디알시'],
    ['leflaive', '르플레브'],
    ['ramonet', '라모네'],
    // Rhône producers
    ['guigal', '기갈'],
    ['chapoutier', '샤푸티에'],
    ['jaboulet', '자불레'],
    ['chave', '샤브'],
  ]);

  /** Supported source languages for alias generation (module-scope, Rule 16). */
  private static readonly VALID_LANGS: Set<string> = new Set(['fr', 'it', 'es', 'en']);

  private static readonly FR_SORTED_KEYS: readonly string[] =
    [...Transliterator.FR_KO_RULES.keys()].sort((a, b) => b.length - a.length);
  private static readonly ES_SORTED_KEYS: readonly string[] =
    [...Transliterator.ES_KO_RULES.keys()].sort((a, b) => b.length - a.length);
  private static readonly EN_SORTED_KEYS: readonly string[] =
    [...Transliterator.EN_KO_RULES.keys()].sort((a, b) => b.length - a.length);
  private static readonly IT_SORTED_KEYS: readonly string[] =
    [...Transliterator.IT_KO_RULES.keys()].sort((a, b) => b.length - a.length);

  // ---------------------------------------------------------------------------
  // Reverse transliteration (Korean → Latin) for claim verification
  // ---------------------------------------------------------------------------
  //
  // The claim verifier (RFC-020) needs to match Korean-surface wine claims like
  // "오퍼스 원 2018" against Latin-surface evidence like "opus one 2018". The
  // forward transliterator above is a many-to-one function (multiple Latin forms
  // can produce the same Korean output), so a perfect inverse does not exist —
  // but for verification we do not need one. We only need to recognize that the
  // Korean phrase IS a known wine term, and the Latin canonical form of it.
  //
  // Strategy: build an inverse index from EXCEPTIONS (curated, high-confidence
  // Korean↔Latin pairs) at first use, keyed on the whitespace-stripped Korean
  // form so "오푸스원" and "오푸스 원" both match. This mirrors the retrieval-side
  // alias infrastructure but keeps the verifier dependency-free.
  //
  // What this does NOT do: invert rule-based transliteration. Rule inversion is
  // ambiguous (e.g. "이" could be 'i'/'e'/'y'), would need a language model to
  // disambiguate, and the verifier has no LLM budget. Curated dictionary covers
  // the long tail of well-known names which is exactly the verification target.

  /** Lazily-populated inverse index: normalized Korean → canonical Latin. */
  private static KO_TO_LATIN_INDEX: ReadonlyMap<string, string> | undefined;

  /**
   * Normalize a Korean wine term for inverse lookup: strip whitespace, punctuation,
   * and year tokens so "오퍼스 원 2018" and "오푸스원" collide on the same key.
   * Also applies the Korean wine typo correction table (e.g. 오퍼스 → 오푸스)
   * when it is imported, but we inline the minimal mapping here to keep this
   * module free of cross-domain imports.
   */
  private static normalizeKoreanWineKey(s: string): string {
    // Strip 4-digit vintage years — they are never part of a wine identity label.
    // Delegates to the vintage SSoT (`@domain/shared/utils/vintage`).
    const vintageStripped = stripVintageYears(s.toLowerCase().normalize('NFKC'));
    return vintageStripped
      // Strip whitespace, punctuation, and Latin letters (vintage abbreviations may leak in,
      // e.g. "돔 페리뇽 NV" must strip "nv" so the key matches the EXCEPTIONS entry "돔페리뇽").
      // The .toLowerCase().normalize('NFKC') above ensures uppercase Latin is already lowercased.
      .replace(/[\s\-_.,()'"·a-z]+/gu, '')
      // Apply the common "오퍼스" → "오푸스" typo normalization inline. This is the single
      // Korean→Korean misspelling that appears in real benchmark scenarios for Opus One.
      // Keeping it inline avoids a dependency on korean-wine-aliases.ts.
      .replace(/오퍼스/gu, '오푸스');
  }

  private static buildKoToLatinIndex(): ReadonlyMap<string, string> {
    const index = new Map<string, string>();
    for (const [latin, korean] of Transliterator.EXCEPTIONS) {
      const key = Transliterator.normalizeKoreanWineKey(korean);
      if (key.length === 0) continue;
      // First write wins. Multiple Latin forms may share the same Korean (e.g.
      // "château margaux" and "chateau margaux" both → "샤또 마고") — the de-accented
      // form is simpler for downstream matching so we prefer whichever appears first
      // in the dictionary (deterministic iteration order of Map).
      if (!index.has(key)) {
        index.set(key, latin);
      }
    }
    return index;
  }

  private static buildKoToLatinImePrefixIndex(): ReadonlyMap<string, readonly {
    readonly latin: string;
    readonly jamoKey: string;
    readonly syllableBoundaryOffsets: ReadonlySet<number>;
  }[]> {
    const index = new Map<string, Array<{
      readonly latin: string;
      readonly jamoKey: string;
      readonly syllableBoundaryOffsets: ReadonlySet<number>;
    }>>();

    for (const [latin, korean] of Transliterator.EXCEPTIONS) {
      const normalizedKorean = Transliterator.normalizeKoreanWineKey(korean);
      const key = buildHangulJamoKey(normalizedKorean);
      if (!key.containsHangul || key.key.length === 0) {
        continue;
      }

      const record = {
        latin,
        jamoKey: key.key,
        syllableBoundaryOffsets: key.syllableBoundaryOffsets,
      };

      for (let prefixLength = 1; prefixLength < key.key.length; prefixLength += 1) {
        const prefix = key.key.slice(0, prefixLength);
        const existing = index.get(prefix);
        if (existing === undefined) {
          index.set(prefix, [record]);
          continue;
        }
        if (existing.some((item) => item.latin === latin && item.jamoKey === key.key)) {
          continue;
        }
        existing.push(record);
      }
    }

    return index;
  }

  /**
   * Look up the canonical Latin form of a Korean wine term using the curated
   * exception dictionary. Returns `undefined` when no match is found.
   *
   * The input may contain punctuation, vintage years, and whitespace — they are
   * stripped before lookup. Matching is exact on the normalized key (no partial
   * match) because verification requires strong identity signal, not recall.
   *
   * Examples:
   *   "오푸스 원 2018"  → "opus one"
   *   "오퍼스원"       → "opus one"  (typo corrected)
   *   "돔 페리뇽"      → "dom pérignon"
   *   "unknown 와인"   → undefined
   */
  static romanizeWineTerm(koreanTerm: string): string | undefined {
    Transliterator.KO_TO_LATIN_INDEX ??= Transliterator.buildKoToLatinIndex();
    const key = Transliterator.normalizeKoreanWineKey(koreanTerm);
    if (key.length === 0) return undefined;
    return Transliterator.KO_TO_LATIN_INDEX.get(key);
  }

  /**
   * IME-aware prefix lookup over curated Korean wine exception surfaces.
   *
   * Returns the canonical Latin term when the Korean input is a multi-syllable
   * prefix of a known exception surface, including both incomplete IME states
   * and completed syllable boundaries, such as:
   *   "오푸"     -> "opus one"
   *   "오푸스ㅇ" -> "opus one"
   *   "오퍼스ㅇ" -> "opus one"  (typo-corrected before lookup)
   *   "오푸스"   -> "opus one"
   */
  static romanizeWineTermPrefix(koreanTerm: string): string | undefined {
    Transliterator.KO_TO_LATIN_IME_PREFIX_INDEX ??= Transliterator.buildKoToLatinImePrefixIndex();

    const normalized = Transliterator.normalizeKoreanWineKey(koreanTerm);
    if (normalized.length === 0) {
      return undefined;
    }

    const key = buildHangulJamoKey(normalized);
    if (!key.containsHangul || key.key.length === 0 || key.syllableCount < 2) {
      return undefined;
    }

    for (const record of Transliterator.KO_TO_LATIN_IME_PREFIX_INDEX.get(key.key) ?? []) {
      if (!record.jamoKey.startsWith(key.key)) {
        continue;
      }
      return record.latin;
    }

    return undefined;
  }

  /**
   * Returns the curated Korean exception surface for a Latin wine term.
   *
   * This is intentionally exception-only: query-time IME completion must be
   * anchored to high-confidence alias vocabulary, not broad rule-generated
   * transliterations. Vintage years and punctuation are stripped so
   * `Opus One 2018` can still reuse the `opus one` exception surface.
   */
  static koreanExceptionSurfaceForLatinTerm(latinTerm: string): string | undefined {
    const normalized = stripVintageYears(latinTerm.normalize('NFC').toLowerCase())
      .replace(/[^\p{L}\p{N}'\s-]+/gu, ' ')
      .replace(/[-\s]+/gu, ' ')
      .trim();
    if (normalized.length === 0) return undefined;
    return Transliterator.EXCEPTIONS.get(normalized);
  }

  /**
   * Test whether a string contains any Hangul (한글) syllables. Used by the
   * verifier to decide whether to attempt reverse romanization before comparing
   * against Latin-only evidence. Delegates to @domain/shared/utils/hangul (SSoT).
   */
  static containsHangul(s: string): boolean {
    return sharedContainsHangul(s);
  }

  /**
   * Transliterates a wine-domain string from the given source language to Korean.
   *
   * Resolution order:
   * 1. Check the exception dictionary for the full input.
   * 2. For each word, check word-level exceptions.
   * 3. Apply character-level rules from the appropriate rule table.
   *
   * @param input - The string to transliterate.
   * @param sourceLang - The source language.
   * @returns Korean transliteration.
   */
  transliterate(input: string, sourceLang: SourceLang): string {
    // NFC-normalize before lowercasing: macOS produces NFD-encoded strings (decomposed
    // accented chars, e.g. 'e' + combining acute = '\u0301'), but EXCEPTIONS keys are NFC.
    // Map.get() uses strict codepoint equality so NFD input silently misses NFC keys.
    const lower = input.normalize('NFC').toLowerCase().trim();

    // 1. Full-string exception lookup
    const fullException = Transliterator.EXCEPTIONS.get(lower);
    if (fullException !== undefined) {
      return fullException;
    }

    // 2. Word-by-word transliteration
    const words = lower.split(/[\s-]+/);
    const transliteratedWords: string[] = [];

    for (const word of words) {
      // Check word-level exception
      const wordException = Transliterator.EXCEPTIONS.get(word);
      if (wordException !== undefined) {
        transliteratedWords.push(wordException);
        continue;
      }

      // Apply rule-based transliteration
      transliteratedWords.push(this.applyRules(word, sourceLang));
    }

    return transliteratedWords.join(' ');
  }

  /**
   * Generates alias candidates from a canonical label by transliterating it.
   * Returns multiple results with varying confidence levels.
   *
   * @param canonicalLabel - The canonical (original-language) label.
   * @param sourceLang - The source language of the label.
   * @returns An array of transliteration results.
   */
  generateAliases(
    canonicalLabel: string,
    sourceLang: string,
  ): readonly TransliterationResult[] {
    if (!Transliterator.VALID_LANGS.has(sourceLang)) return [];
    // Guard empty input: transliterate('') produces [''] from split, then
    // applyRules('', …) returns '', which would create an empty alias and
    // throw INVARIANT_VIOLATION in createAlias. Fail early and cleanly.
    if (canonicalLabel.trim().length === 0) return [];
    const lang = sourceLang as SourceLang;
    const results: TransliterationResult[] = [];

    const lower = canonicalLabel.normalize('NFC').toLowerCase().trim();
    const isException = Transliterator.EXCEPTIONS.has(lower);

    // Primary transliteration
    const primary = this.transliterate(canonicalLabel, lang);
    results.push({
      value: primary,
      type: 'translation',
      confidence: isException ? TRANSLITERATION_EXCEPTION_CONFIDENCE : TRANSLITERATION_RULE_CONFIDENCE,
    });

    // If not an exception, also generate a phonetic variant without spaces
    if (!isException) {
      const compact = primary.replace(/\s+/g, '');
      if (compact !== primary) {
        results.push({
          value: compact,
          type: 'phonetic',
          confidence: TRANSLITERATION_COMPACT_CONFIDENCE,
        });
      }
    }

    return results;
  }

  /**
   * Applies character-level transliteration rules to a single word.
   * Uses greedy longest-match from left to right.
   */
  private applyRules(word: string, sourceLang: SourceLang): string {
    const rules = this.getRulesForLang(sourceLang);
    const sortedKeys = this.getSortedKeysForLang(sourceLang);

    let result = '';
    let i = 0;

    while (i < word.length) {
      let matched = false;
      for (const key of sortedKeys) {
        if (word.startsWith(key, i)) {
          const repl = rules.get(key);
          if (repl !== undefined) {
            result += repl;
            i += key.length;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        // Pass through characters not in the rule table (e.g. digits, Korean)
        const ch = word[i];
        if (ch === undefined) break;
        result += ch;
        i++;
      }
    }

    return result;
  }

  /**
   * Returns the transliteration rule map for the given language.
   * French rules are used as default/fallback for Spanish and English.
   */
  private getRulesForLang(lang: SourceLang): ReadonlyMap<string, string> {
    switch (lang) {
      case 'it':
        return Transliterator.IT_KO_RULES;
      case 'es':
        return Transliterator.ES_KO_RULES;
      case 'en':
        return Transliterator.EN_KO_RULES;
      case 'fr':
      default:
        return Transliterator.FR_KO_RULES;
    }
  }

  private getSortedKeysForLang(lang: SourceLang): readonly string[] {
    switch (lang) {
      case 'it':
        return Transliterator.IT_SORTED_KEYS;
      case 'es':
        return Transliterator.ES_SORTED_KEYS;
      case 'en':
        return Transliterator.EN_SORTED_KEYS;
      case 'fr':
      default:
        return Transliterator.FR_SORTED_KEYS;
    }
  }
}
