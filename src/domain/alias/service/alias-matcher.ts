import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { Alias, AliasScope, AliasType } from '../model/alias.js';
import type { AliasRepository } from '../port/alias-repository.port.js';
import type { CharNgramIndex } from './char-ngram-index.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';

/**
 * Result of matching a query string against the alias index.
 */
export interface AliasMatchResult {
  /** The entity the matched alias points to. */
  readonly entityId: CanonicalEntityId;
  /** The alias that matched. */
  readonly alias: Alias;
  /** How the match was found. */
  readonly matchType: 'exact' | 'normalized' | 'char_ngram' | 'fuzzy' | 'phonetic';
  /**
   * Raw match score in [0, 1].
   * 1.0 for exact, scaled by similarity for fuzzy/phonetic.
   */
  readonly matchScore: number;
  /**
   * Weighted score combining matchScore with alias type weight and prior.
   * weightedScore = matchScore * typeWeight(alias.type) * alias.confidencePrior
   */
  readonly weightedScore: number;
}

/**
 * Type priority weights used in score calculation.
 * See RFC-003 §5.
 */
/** Base score when normalized alias value matches (before type/prior weighting). */
const NORMALIZED_ALIAS_MATCH_SCORE = 0.95;
/** Phonetic skeleton match score (consonant-skeleton heuristic). */
const PHONETIC_ALIAS_MATCH_SCORE = 0.8;

const TYPE_WEIGHTS: Readonly<Record<AliasType, number>> = {
  canonical: 1.0,
  translation: NORMALIZED_ALIAS_MATCH_SCORE,
  phonetic: 0.85,
  misspelling: 0.6,
  observed_query_alias: 0.7,
  catalog_noise_alias: 0.4,
};

/**
 * Computes the Levenshtein edit distance between two strings.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns The minimum number of single-character edits (insertions, deletions,
 *          substitutions) to transform `a` into `b`.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimize for trivial cases
  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows instead of full matrix for O(min(m,n)) space
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = prev[j];
      const ins = curr[j - 1];
      const sub = prev[j - 1];
      if (del === undefined || ins === undefined || sub === undefined) {
        throw new Error('levenshtein: internal row undefined');
      }
      curr[j] = Math.min(del + 1, ins + 1, sub + cost);
    }
    [prev, curr] = [curr, prev];
  }

  const dist = prev[n];
  if (dist === undefined) {
    throw new Error('levenshtein: result undefined');
  }
  return dist;
}

/**
 * Normalizes a string for matching: lowercases, strips combining diacritical
 * marks (accents), and collapses contiguous whitespace to a single space.
 *
 * @param input - The raw input string.
 * @returns The normalized form.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Default fuzzy match threshold: max edit distance relative to string length. */
const FUZZY_THRESHOLD_RATIO = 0.3;
/** Minimum length for fuzzy matching to avoid false positives on short strings. */
const MIN_FUZZY_LENGTH = 4;

/**
 * Multi-strategy alias matcher implementing RFC-003 §5.
 *
 * Matching pipeline: exact -> normalized -> fuzzy -> phonetic.
 * Each stage only runs if previous stages yielded no results.
 * Embedding-only match is forbidden as sole authority per RFC-003.
 */
export class AliasMatcher {
  private readonly charNgramIndex?: CharNgramIndex | undefined;

  constructor(
    private readonly aliasRepo: AliasRepository,
    options?: { readonly charNgramIndex?: CharNgramIndex },
  ) {
    if (options?.charNgramIndex) {
      this.charNgramIndex = options.charNgramIndex;
    }
  }

  /**
   * Matches a query string against the alias index using a cascading
   * strategy: exact, then normalized, then fuzzy, then phonetic.
   *
   * @param query - The user's search term.
   * @param scope - Optional scope filter.
   * @param limit - Maximum results to return (default 10).
   * @returns Match results sorted by weightedScore descending.
   */
  async match(
    query: string,
    scope?: AliasScope,
    limit: number = 10,
  ): Promise<readonly AliasMatchResult[]> {
    // Stage 1: Exact match
    const exactResults = await this.exactMatch(query, scope);
    if (exactResults.length > 0) {
      return this.rankAndLimit(exactResults, limit);
    }

    // Stage 2: Normalized match
    const normalizedResults = await this.normalizedMatch(query, scope);
    if (normalizedResults.length > 0) {
      return this.rankAndLimit(normalizedResults, limit);
    }

    // Stage 2.5: Char n-gram match (handles collapsed whitespace, missing spaces)
    const charNgramResults = await this.charNgramMatch(query, scope);
    if (charNgramResults.length > 0) {
      return this.rankAndLimit(charNgramResults, limit);
    }

    // Stage 3: Fuzzy match (Levenshtein-based)
    const fuzzyResults = await this.fuzzyMatch(query, scope);
    if (fuzzyResults.length > 0) {
      return this.rankAndLimit(fuzzyResults, limit);
    }

    // Stage 4: Phonetic match (normalized overlap heuristic)
    const phoneticResults = await this.phoneticMatch(query, scope);
    return this.rankAndLimit(phoneticResults, limit);
  }

  /**
   * Exact match: query string matches alias value verbatim.
   */
  private async exactMatch(
    query: string,
    scope?: AliasScope,
  ): Promise<AliasMatchResult[]> {
    const aliases = await this.aliasRepo.findByValue(query, scope);
    return this.activeOnly(aliases).map((alias) => ({
      entityId: alias.entityId,
      alias,
      matchType: 'exact' as const,
      matchScore: 1.0,
      weightedScore: TYPE_WEIGHTS[alias.type] * alias.confidencePrior,
    }));
  }

  /**
   * Normalized match: lowercased, accent-stripped form matches.
   */
  private async normalizedMatch(
    query: string,
    scope?: AliasScope,
  ): Promise<AliasMatchResult[]> {
    const normalized = normalizeForMatch(query);
    const aliases = await this.aliasRepo.findByNormalizedValue(normalized);
    const filtered = scope
      ? this.activeOnly(aliases).filter((a) => a.scope === scope || a.scope === 'global')
      : this.activeOnly(aliases);

    return filtered.map((alias) => ({
      entityId: alias.entityId,
      alias,
      matchType: 'normalized' as const,
      matchScore: NORMALIZED_ALIAS_MATCH_SCORE,
      weightedScore: NORMALIZED_ALIAS_MATCH_SCORE * TYPE_WEIGHTS[alias.type] * alias.confidencePrior,
    }));
  }

  /**
   * Char n-gram match: uses trigram Jaccard similarity to find aliases that
   * match despite collapsed whitespace, missing spaces, or minor character
   * differences (e.g. "opusone" -> "Opus One").
   */
  private async charNgramMatch(
    query: string,
    scope?: AliasScope,
  ): Promise<AliasMatchResult[]> {
    if (!this.charNgramIndex) return [];

    const matches = this.charNgramIndex.search(query);
    if (matches.length === 0) return [];

    const results: AliasMatchResult[] = [];
    for (const m of matches) {
      // Look up the alias by its original surface form
      const aliases = await this.aliasRepo.findByValue(m.term, scope);
      const active = this.activeOnly(aliases);
      for (const alias of active) {
        results.push({
          entityId: alias.entityId,
          alias,
          matchType: 'char_ngram',
          matchScore: m.similarity,
          weightedScore: m.similarity * TYPE_WEIGHTS[alias.type] * alias.confidencePrior,
        });
      }
    }

    return results;
  }

  /**
   * Fuzzy match: finds aliases within edit-distance threshold.
   * Only applied when the query is long enough to avoid false positives.
   */
  private async fuzzyMatch(
    query: string,
    scope?: AliasScope,
  ): Promise<AliasMatchResult[]> {
    const normalized = normalizeForMatch(query);
    if (normalized.length < MIN_FUZZY_LENGTH) {
      return [];
    }

    const maxDist = Math.floor(normalized.length * FUZZY_THRESHOLD_RATIO);

    // Use the fuzzy-candidates retrieval path (prefix/trigram index) rather than
    // exact-normalized lookup, so the repo can return plausible near-miss candidates
    // rather than only exact matches (which would defeat the purpose of fuzzy matching).
    const candidates = await this.aliasRepo.findFuzzyCandidates(normalized, scope);
    const allByScope = this.activeOnly(candidates);

    // Also check entity aliases for nearby values
    const results: AliasMatchResult[] = [];
    for (const alias of allByScope) {
      const dist = editDistance(normalized, alias.normalizedValue);
      if (dist <= maxDist && dist > 0) {
        const maxLen = Math.max(normalized.length, alias.normalizedValue.length);
        const similarity = 1 - dist / maxLen;
        results.push({
          entityId: alias.entityId,
          alias,
          matchType: 'fuzzy',
          matchScore: similarity,
          weightedScore: similarity * TYPE_WEIGHTS[alias.type] * alias.confidencePrior,
        });
      }
    }

    return results;
  }

  /**
   * Phonetic match: uses a consonant-skeleton heuristic as a lightweight
   * phonetic approximation. Full phonetic encoding (Metaphone, etc.) can
   * be injected via the repository in infrastructure.
   */
  private async phoneticMatch(
    query: string,
    scope?: AliasScope,
  ): Promise<AliasMatchResult[]> {
    const normalized = normalizeForMatch(query);
    // Consonant skeleton: strip vowels for rough phonetic similarity
    const skeleton = normalized.replace(/[aeiou]/g, '');
    if (skeleton.length < 2) {
      return [];
    }

    const candidates = await this.aliasRepo.findFuzzyCandidates(normalized, scope);
    const allByScope = this.activeOnly(candidates);

    const results: AliasMatchResult[] = [];
    for (const alias of allByScope) {
      const candidateSkeleton = alias.normalizedValue.replace(/[aeiou]/g, '');
      if (skeleton === candidateSkeleton && normalized !== alias.normalizedValue) {
        results.push({
          entityId: alias.entityId,
          alias,
          matchType: 'phonetic',
          matchScore: PHONETIC_ALIAS_MATCH_SCORE,
          weightedScore: PHONETIC_ALIAS_MATCH_SCORE * TYPE_WEIGHTS[alias.type] * alias.confidencePrior,
        });
      }
    }

    return results;
  }

  /** Filters out suppressed aliases. */
  private activeOnly(aliases: readonly Alias[]): readonly Alias[] {
    return aliases.filter((a) => !a.suppressed);
  }

  /** Sorts by weightedScore descending and limits results.
   *
   * Deduplicates by entityId before limiting: when multiple aliases for the
   * same entity match (e.g. an English and a Japanese alias both found in the
   * same stage), only the highest-scoring entry is retained. Without this,
   * a multilingual entity could occupy multiple slots in the result list,
   * artificially boosting its apparent rank and shrinking the effective limit
   * for other candidates.
   */
  private rankAndLimit(
    results: readonly AliasMatchResult[],
    limit: number,
  ): readonly AliasMatchResult[] {
    // NaN-safe + deterministic tiebreaker (entityId) — see stable-comparator.
    const sorted = [...results].sort(
      compareScoreWithTiebreaker<AliasMatchResult>(
        (r) => r.weightedScore,
        (r) => String(r.entityId),
      ),
    );

    // Deduplicate: keep only the best-scoring result per entityId.
    const seen = new Set<string>();
    const deduped: AliasMatchResult[] = [];
    for (const result of sorted) {
      const key = String(result.entityId);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(result);
      }
    }

    return deduped.slice(0, limit);
  }
}
