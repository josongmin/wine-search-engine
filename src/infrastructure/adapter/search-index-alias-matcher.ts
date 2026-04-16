import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../domain/query/service/anchor-extractor.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { parseSpans } from '../../domain/attribute/service/span-parser.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import type { SparseHit } from '../../domain/retrieval/port/search-index.port.js';

const SEARCH_INDEX_ALIAS_LIMIT = 24;

const EXACT_MULTIPLIER = 1.0;
const COMPACT_MULTIPLIER = 0.93;
const TRANSLITERATED_MULTIPLIER = 0.91;
const PHONETIC_MULTIPLIER = 0.88;

const FIELD_CONFIDENCE = {
  canonical_label: 0.97,
  aliases_identity_safe: 0.96,
  aliases_noisy_recall: 0.92,
  producer: 0.86,
} as const;

type AliasFieldName = keyof typeof FIELD_CONFIDENCE;
type AliasStrategy = 'exact' | 'compact_exact' | 'transliterated_exact' | 'phonetic_exact';

interface CandidateSurface {
  readonly field: AliasFieldName;
  readonly value: string;
}

interface ClassifiedMatch {
  readonly strategy: AliasStrategy;
  readonly multiplier: number;
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

function classifyMatch(query: string, candidate: string): ClassifiedMatch | null {
  const queryViews = buildNormalizedQueryViews(query);
  const candidateViews = buildNormalizedQueryViews(candidate);
  const queryVintage = queryViews.vintageStripped;
  const candidateVintage = candidateViews.vintageStripped;

  const queryTransliterated = queryViews.transliterated;
  const candidateTransliterated = candidateViews.transliterated;
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
      multiplier: TRANSLITERATED_MULTIPLIER,
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
      multiplier: queryTransliterated !== undefined
        ? TRANSLITERATED_MULTIPLIER
        : EXACT_MULTIPLIER,
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
      multiplier: EXACT_MULTIPLIER,
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
      multiplier: COMPACT_MULTIPLIER,
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
      multiplier: PHONETIC_MULTIPLIER,
      normalizedForm: candidateViews.strict,
    };
  }

  return null;
}

function buildSearchQueries(query: string): readonly string[] {
  const queryViews = buildNormalizedQueryViews(query);
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

        const confidence = resolveBaseConfidence(hit, surface.field) * classified.multiplier;
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

    const hits = await this.searchIndex.sparseSearch(
      mergedSearchQueries,
      [],
      SEARCH_INDEX_ALIAS_LIMIT * trimmedQueries.length,
      'hybrid',
    );
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
    for (const query of trimmedQueries) {
      const primaryMatches = primaryBatch?.get(query)
        ?? (primaryBatch === undefined ? await this.primary.findMatches(query) : []);
      if (primaryMatches.length > 0) {
        results.set(query, primaryMatches);
        continue;
      }
      unresolved.push(query);
    }

    if (unresolved.length === 0) {
      return results;
    }

    const secondaryBatch = this.secondary.findMatchesBatch !== undefined
      ? await this.secondary.findMatchesBatch(unresolved)
      : undefined;
    for (const query of unresolved) {
      const secondaryMatches = secondaryBatch?.get(query)
        ?? (secondaryBatch === undefined ? await this.secondary.findMatches(query) : []);
      results.set(query, secondaryMatches);
    }

    return results;
  }
}
