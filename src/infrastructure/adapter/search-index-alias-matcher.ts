import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../domain/query/service/anchor-extractor.js';
import {
  buildAliasPrefixTerms,
  isEligiblePrefixQuery,
} from '../../domain/query/service/alias-prefix-terms.js';
import {
  resolveAliasMatchConfidence,
  type AliasMatchConfidenceStrategy,
} from '../../domain/query/service/alias-match-confidence.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { parseSpans } from '../../domain/attribute/service/span-parser.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import type { SparseHit } from '../../domain/retrieval/port/search-index.port.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { VespaNetworkError } from '../vespa/vespa-client.js';

const SEARCH_INDEX_ALIAS_LIMIT = 24;
const log = bootstrapLogger.child({ component: 'SearchIndexAliasMatcher' });
const MIN_WHOLE_TOKEN_LOOKUP_LENGTH = 4;

const FIELD_CONFIDENCE = {
  canonical_label: 0.97,
  aliases_identity_safe: 0.96,
  aliases_noisy_recall: 0.92,
  producer: 0.86,
} as const;

type AliasFieldName = keyof typeof FIELD_CONFIDENCE;
type AliasStrategy = Exclude<AliasMatchConfidenceStrategy, 'hangul_ime_completion'>;

interface CandidateSurface {
  readonly field: AliasFieldName;
  readonly value: string;
}

interface ClassifiedMatch {
  readonly strategy: AliasStrategy;
  readonly normalizedForm: string;
}

function compact(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '').trim();
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  const normalizedHaystack = ` ${haystack.trim()} `;
  const normalizedNeedle = ` ${needle.trim()} `;
  return normalizedHaystack.includes(normalizedNeedle);
}

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/)
    .filter(Boolean);
}

function classifyMatch(query: string, candidate: string): ClassifiedMatch | null {
  const queryViews = buildNormalizedQueryViews(query);
  const candidateViews = buildNormalizedQueryViews(candidate);
  const queryVintage = queryViews.vintageStripped;
  const candidateVintage = candidateViews.vintageStripped;
  const imeRomanizedPrefix = Transliterator.romanizeWineTermPrefix(query);
  const candidatePrefixTerms = buildAliasPrefixTerms([candidate]);
  const queryPrefixTerms = buildAliasPrefixTerms([query]).filter((term) => isEligiblePrefixQuery(term));

  const queryTransliterated = queryViews.transliterated;
  const candidateTransliterated = candidateViews.transliterated;
  const transliteratedPrefixTerms = queryTransliterated !== undefined
    ? buildAliasPrefixTerms([queryTransliterated]).filter((term) => isEligiblePrefixQuery(term))
    : [];
  if (
    (queryTransliterated !== undefined &&
      (queryTransliterated === candidateViews.strict ||
        queryTransliterated === candidateVintage ||
        compact(queryTransliterated) === candidateViews.compact)) ||
    (candidateTransliterated !== undefined &&
      (candidateTransliterated === queryViews.strict ||
        candidateTransliterated === queryVintage ||
        compact(candidateTransliterated) === queryViews.compact)) ||
    (queryTransliterated !== undefined &&
      candidateTransliterated !== undefined &&
      queryTransliterated === candidateTransliterated)
  ) {
    return {
      strategy: 'transliterated_exact',
      normalizedForm: candidateViews.strict,
    };
  }

  if (
    imeRomanizedPrefix !== undefined &&
    (
      imeRomanizedPrefix === candidateViews.strict ||
      imeRomanizedPrefix === candidateVintage ||
      compact(imeRomanizedPrefix) === candidateViews.compact ||
      imeRomanizedPrefix === candidateTransliterated
    )
  ) {
    return {
      strategy: 'transliterated_fuzzy',
      normalizedForm: candidateViews.strict,
    };
  }

  const candidatePhrase = candidateVintage.length > 0 ? candidateVintage : candidateViews.punctuationStripped;
  const candidatePhraseTokenCount = candidatePhrase.split(/\s+/).filter(Boolean).length;
  if (
    candidatePhraseTokenCount >= 2 &&
    (
      containsWholePhrase(queryViews.punctuationStripped, candidatePhrase) ||
      (queryTransliterated !== undefined && containsWholePhrase(queryTransliterated, candidatePhrase))
    )
  ) {
    return {
      strategy: queryTransliterated !== undefined
        ? 'transliterated_exact'
        : 'exact',
      normalizedForm: candidateViews.strict,
    };
  }

  if (
    queryViews.strict === candidateViews.strict ||
    queryViews.accentless === candidateViews.accentless ||
    queryViews.punctuationStripped === candidateViews.punctuationStripped ||
    (queryVintage.length > 0 && queryVintage === candidateVintage)
  ) {
    return {
      strategy: 'exact',
      normalizedForm: candidateViews.strict,
    };
  }

  if (
    queryViews.compact.length > 0 &&
    candidateViews.compact.length > 0 &&
    queryViews.compact === candidateViews.compact
  ) {
    return {
      strategy: 'compact_exact',
      normalizedForm: candidateViews.strict,
    };
  }

  const queryTokens = tokenizeForLookup(queryVintage);
  if (
    queryTokens.length === 1 &&
    queryTokens[0] !== undefined &&
    queryTokens[0].length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH &&
    tokenizeForLookup(candidateVintage).includes(queryTokens[0])
  ) {
    return {
      strategy: 'lexical_exact',
      normalizedForm: candidateViews.strict,
    };
  }

  if (transliteratedPrefixTerms.some((term) => candidatePrefixTerms.some((candidateTerm) => candidateTerm.startsWith(term)))) {
    return {
      strategy: 'transliterated_prefix',
      normalizedForm: candidateViews.strict,
    };
  }

  if (queryPrefixTerms.some((term) => candidatePrefixTerms.some((candidateTerm) => candidateTerm.startsWith(term)))) {
    return {
      strategy: 'prefix_exact',
      normalizedForm: candidateViews.strict,
    };
  }

  if (
    queryViews.phoneticCompact !== undefined &&
    candidateViews.phoneticCompact !== undefined &&
    queryViews.phoneticCompact === candidateViews.phoneticCompact
  ) {
    return {
      strategy: 'phonetic_exact',
      normalizedForm: candidateViews.strict,
    };
  }

  return null;
}

function buildSearchQueries(query: string): readonly string[] {
  const queryViews = buildNormalizedQueryViews(query);
  const imeRomanizedPrefix = Transliterator.romanizeWineTermPrefix(query);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  const baseQueries = [
    queryViews.strict,
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    ...(queryViews.transliterated !== undefined ? [queryViews.transliterated] : []),
    ...(imeRomanizedPrefix !== undefined ? [imeRomanizedPrefix] : []),
  ].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

  for (const baseQuery of baseQueries) {
    add(baseQuery);
  }

  for (const baseQuery of baseQueries) {
    for (const span of parseSpans(baseQuery)) {
      add(span.text);
    }
  }

  return ordered;
}

function trimDedupedQueries(queries: readonly string[]): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const trimmed = query.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function collectCandidateSurfaces(hit: SparseHit): readonly CandidateSurface[] {
  const summary = hit.summary;
  const candidates: CandidateSurface[] = [];
  if (summary?.canonicalLabel !== undefined && summary.canonicalLabel.length > 0) {
    candidates.push({ field: 'canonical_label', value: summary.canonicalLabel });
  }
  if (summary?.producer !== undefined && summary.producer.length > 0) {
    candidates.push({ field: 'producer', value: summary.producer });
  }
  return candidates;
}

function resolveBaseConfidence(hit: SparseHit, fallbackField: AliasFieldName): number {
  if (hit.matchedFields.includes('aliases_identity_safe')) {
    return FIELD_CONFIDENCE.aliases_identity_safe;
  }
  if (hit.matchedFields.includes('aliases_noisy_recall')) {
    return FIELD_CONFIDENCE.aliases_noisy_recall;
  }
  if (hit.matchedFields.includes('canonical_label')) {
    return FIELD_CONFIDENCE.canonical_label;
  }
  if (hit.matchedFields.includes('producer')) {
    return FIELD_CONFIDENCE.producer;
  }
  return FIELD_CONFIDENCE[fallbackField];
}

export class SearchIndexAliasMatcher implements AliasMatcher {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  private resolveMatchesForQuery(
    normalizedQuery: string,
    hits: readonly SparseHit[],
  ): readonly AliasMatchResult[] {
    const grouped = new Map<
      string,
      {
        readonly surfaceForm: string;
        readonly normalizedForm: string;
        readonly entityIds: Set<string>;
        readonly matchConfidence: number;
        readonly lookupStrategies: Set<string>;
      }
    >();

    for (const hit of hits) {
      for (const surface of collectCandidateSurfaces(hit)) {
        const classified = classifyMatch(normalizedQuery, surface.value);
        if (classified === null) {
          continue;
        }

        const confidence = resolveAliasMatchConfidence(
          resolveBaseConfidence(hit, surface.field),
          classified.strategy,
        );
        const key = `${surface.value}\u0000${classified.normalizedForm}`;
        const existing = grouped.get(key);
        if (existing === undefined) {
          grouped.set(key, {
            surfaceForm: surface.value,
            normalizedForm: classified.normalizedForm,
            entityIds: new Set([hit.entityId]),
            matchConfidence: confidence,
            lookupStrategies: new Set([`index_${classified.strategy}`]),
          });
          continue;
        }

        existing.entityIds.add(hit.entityId);
        existing.lookupStrategies.add(`index_${classified.strategy}`);
        if (confidence > existing.matchConfidence) {
          grouped.set(key, {
            ...existing,
            matchConfidence: confidence,
          });
        }
      }
    }

    return [...grouped.values()]
      .sort((left, right) => right.matchConfidence - left.matchConfidence)
      .map((match) => ({
        surfaceForm: match.surfaceForm,
        normalizedForm: match.normalizedForm,
        entityIds: [...match.entityIds].map((entityId) => createCanonicalEntityId(entityId)),
        matchConfidence: match.matchConfidence,
        lookupStrategy: [...match.lookupStrategies].sort().join('+'),
      }));
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const trimmedQueries = trimDedupedQueries(normalizedQueries);
    if (trimmedQueries.length === 0) {
      return new Map();
    }

    const mergedSearchQueries = trimDedupedQueries(
      trimmedQueries.flatMap((query) => buildSearchQueries(query)),
    );

    let hits: readonly SparseHit[];
    try {
      hits = await this.searchIndex.sparseSearch(
        mergedSearchQueries,
        [],
        SEARCH_INDEX_ALIAS_LIMIT * trimmedQueries.length,
        'hybrid',
      );
    } catch (error) {
      if (!(error instanceof VespaNetworkError) && !(error instanceof CircuitBreakerOpenError)) {
        throw error;
      }
      log.warn(
        {
          err: error,
          queryCount: trimmedQueries.length,
          lookupQueryCount: mergedSearchQueries.length,
        },
        '[SearchIndexAliasMatcher] Vespa alias lookup failed — degrading to empty alias matches',
      );
      return new Map(
        trimmedQueries.map((query) => [query, [] satisfies readonly AliasMatchResult[]]),
      );
    }
    const matchesByQuery = new Map<string, readonly AliasMatchResult[]>();
    for (const query of trimmedQueries) {
      matchesByQuery.set(query, this.resolveMatchesForQuery(query, hits));
    }
    return matchesByQuery;
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const batch = await this.findMatchesBatch([trimmed]);
    return batch.get(trimmed) ?? [];
  }
}

export class CascadingAliasMatcher implements AliasMatcher {
  constructor(
    private readonly primary: AliasMatcher,
    private readonly secondary: AliasMatcher,
  ) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const primaryMatches = await this.primary.findMatches(normalizedQuery);
    if (primaryMatches.length > 0) {
      return primaryMatches;
    }
    return this.secondary.findMatches(normalizedQuery);
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const trimmedQueries = trimDedupedQueries(normalizedQueries);
    if (trimmedQueries.length === 0) {
      return new Map();
    }

    const results = new Map<string, readonly AliasMatchResult[]>();
    const primaryBatch = this.primary.findMatchesBatch !== undefined
      ? await this.primary.findMatchesBatch(trimmedQueries)
      : undefined;

    const unresolved: string[] = [];
    if (primaryBatch === undefined) {
      const primaryMatches = await Promise.all(
        trimmedQueries.map((query) => this.primary.findMatches(query)),
      );
      for (const [index, query] of trimmedQueries.entries()) {
        const matched = primaryMatches[index] ?? [];
        if (matched.length > 0) {
          results.set(query, matched);
          continue;
        }
        unresolved.push(query);
      }
    } else {
      for (const query of trimmedQueries) {
        const primaryMatches = primaryBatch.get(query) ?? [];
        if (primaryMatches.length > 0) {
          results.set(query, primaryMatches);
          continue;
        }
        unresolved.push(query);
      }
    }

    if (unresolved.length === 0) {
      return results;
    }

    const secondaryBatch = this.secondary.findMatchesBatch !== undefined
      ? await this.secondary.findMatchesBatch(unresolved)
      : undefined;
    if (secondaryBatch === undefined) {
      const secondaryMatches = await Promise.all(
        unresolved.map((query) => this.secondary.findMatches(query)),
      );
      for (const [index, query] of unresolved.entries()) {
        results.set(query, secondaryMatches[index] ?? []);
      }
    } else {
      for (const query of unresolved) {
        results.set(query, secondaryBatch.get(query) ?? []);
      }
    }

    return results;
  }
}
