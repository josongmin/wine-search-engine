import { BKTree, levenshteinDistance } from './bk-tree.js';
import { soundexKo, soundexEn } from './phonetic.js';

export interface FuzzyMatchResult {
  readonly term: string;
  readonly editDistance: number;
  readonly phoneticSim: number;
  readonly combinedScore: number;
}

// TODO: Initialize at startup with alias terms from the database.
// Planner integration is deferred until an alias store (infrastructure concern) is available.
export class FuzzyMatcher {
  private bkTreeEn: BKTree | null = null;
  private bkTreeKo: BKTree | null = null;

  initialize(terms: readonly string[]): void {
    const enTerms = terms.filter((t) => /[a-z]/i.test(t));
    const koTerms = terms.filter((t) => /[가-힣]/.test(t));
    this.bkTreeEn = BKTree.build(enTerms, levenshteinDistance);
    this.bkTreeKo = BKTree.build(koTerms, levenshteinDistance);
  }

  match(query: string, maxEditDistance: number = 2): readonly FuzzyMatchResult[] {
    const isKorean = /[가-힣]/.test(query);
    const tree = isKorean ? this.bkTreeKo : this.bkTreeEn;
    if (!tree) return [];

    const phoneticFn = isKorean ? soundexKo : soundexEn;
    const queryPhonetic = phoneticFn(query);
    const candidates = tree.search(query, maxEditDistance, levenshteinDistance);

    return candidates
      .map((c) => {
        const phoneticSim = phoneticFn(c.term) === queryPhonetic ? 1.0 : 0.0;
        const editSim = 1 - c.distance / Math.max(query.length, c.term.length, 1);
        const combinedScore = 0.6 * editSim + 0.4 * phoneticSim;
        return { term: c.term, editDistance: c.distance, phoneticSim, combinedScore };
      })
      .filter((r) => r.combinedScore >= 0.5)
      .sort((a, b) => b.combinedScore - a.combinedScore);
  }
}
