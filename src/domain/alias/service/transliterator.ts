import type { AliasType } from '../model/alias.js';

/**
 * Result of generating a transliterated alias.
 */
export interface TransliterationResult {
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

/**
 * Cross-lingual transliterator for wine domain terms.
 * Implements RFC-003 §4.5 with rule-based French/Italian/Spanish/English
 * to Korean transliteration, plus an exception dictionary for established names.
 */
export class Transliterator {
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
    // New World
    ['screaming eagle', '스크리밍 이글'],
    ['penfolds', '펜폴즈'],
    ['grange', '그랜지'],
    // Spanish
    ['rioja', '리오하'],
    ['tempranillo', '템프라니요'],
    ['vega sicilia', '베가 시실리아'],
    ['ribera del duero', '리베라 델 두에로'],
  ]);

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
    const lower = input.toLowerCase().trim();

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
    const lang = sourceLang as SourceLang;
    const results: TransliterationResult[] = [];

    const lower = canonicalLabel.toLowerCase().trim();
    const isException = Transliterator.EXCEPTIONS.has(lower);

    // Primary transliteration
    const primary = this.transliterate(canonicalLabel, lang);
    results.push({
      value: primary,
      type: 'translation',
      confidence: isException ? 0.95 : 0.75,
    });

    // If not an exception, also generate a phonetic variant without spaces
    if (!isException) {
      const compact = primary.replace(/\s+/g, '');
      if (compact !== primary) {
        results.push({
          value: compact,
          type: 'phonetic',
          confidence: 0.6,
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
    // Sort keys by length descending for greedy matching
    const sortedKeys = [...rules.keys()].sort((a, b) => b.length - a.length);

    let result = '';
    let i = 0;

    while (i < word.length) {
      let matched = false;
      for (const key of sortedKeys) {
        if (word.startsWith(key, i)) {
          result += rules.get(key)!;
          i += key.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Pass through characters not in the rule table (e.g. digits, Korean)
        result += word[i];
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
      case 'fr':
      case 'es':
      case 'en':
      default:
        return Transliterator.FR_KO_RULES;
    }
  }
}
