/**
 * FuzzyMatcher — combines BK-tree edit-distance search with phonetic scoring.
 *
 * Builds a BK-tree index from a set of known terms (e.g. alias surface forms)
 * and uses it to find approximate matches for user queries. A combined score
 * blends edit distance with phonetic similarity to rank candidates.
 */

import { BKTree } from './bk-tree.js';
import { soundexEn, soundexKo } from './phonetic.js';
import { editDistanceSimilarity } from '../../alias/service/edit-distance.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';

interface FuzzyMatchResult {
  readonly term: string;
  readonly editDistance: number;
  readonly combinedScore: number;
}

/**
 * Weight given to phonetic match in combined scoring (0–1).
 * Remainder goes to normalized edit-distance similarity.
 */
const PHONETIC_WEIGHT = 0.3;

/**
 * Default maximum edit distance for fuzzy lookups.
 */
const DEFAULT_MAX_EDIT_DISTANCE = 2;

/**
 * Detects whether a string contains any Hangul characters.
 */
function containsKorean(s: string): boolean {
  return /[\uac00-\ud7a3]/.test(s);
}

export class FuzzyMatcher {
  private readonly tree = new BKTree();
  private readonly terms: string[] = [];

  /**
   * Populates the internal BK-tree with a set of known terms.
   * Must be called before {@link match}.
   */
  initialize(terms: readonly string[]): void {
    this.terms.length = 0;
    for (const t of terms) {
      this.tree.insert(t);
      this.terms.push(t);
    }
  }

  /**
   * Finds terms within `maxEditDistance` of `query`, ranked by combined score.
   */
  match(
    query: string,
    maxEditDistance: number = DEFAULT_MAX_EDIT_DISTANCE,
  ): readonly FuzzyMatchResult[] {
    const bkResults = this.tree.search(query, maxEditDistance);

    const scored: FuzzyMatchResult[] = bkResults.map((r) => ({
      term: r.term,
      editDistance: r.editDistance,
      combinedScore: this.combinedScore(query, r.term, r.editDistance),
    }));

    // NaN-safe + deterministic tiebreaker (term lex order). (Bugbash R22)
    scored.sort(
      compareScoreWithTiebreaker<FuzzyMatchResult>(
        (r) => r.combinedScore,
        (r) => r.term,
      ),
    );

    return scored;
  }

  /**
   * Computes a combined score blending edit-distance similarity and phonetic match.
   *
   * Edit-distance similarity: 1 - (editDistance / max(len(query), len(term)))
   * Phonetic similarity: 1 if phonetic keys match, 0 otherwise.
   */
  private combinedScore(query: string, term: string, editDistance: number): number {
    // SSoT: edit-distance similarity formula lives in alias/service/edit-distance
    // (rule 30 — no duplicated formula that can drift from the canonical one).
    const editSimilarity = editDistanceSimilarity(query, term, editDistance);

    const phoneticMatch = this.phoneticMatch(query, term) ? 1 : 0;

    return (1 - PHONETIC_WEIGHT) * editSimilarity + PHONETIC_WEIGHT * phoneticMatch;
  }

  /**
   * Checks phonetic similarity using the appropriate Soundex variant.
   */
  private phoneticMatch(a: string, b: string): boolean {
    if (containsKorean(a) || containsKorean(b)) {
      return soundexKo(a) === soundexKo(b);
    }
    return soundexEn(a) === soundexEn(b);
  }
}
