import {
  buildAgentQueryExecutionContract,
  isExactMetadataEntityLookupCandidate,
  isSpecificSkuLikeQuery,
} from './query-execution-contract.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { stripExactEntityLookupSuffix } from '../../domain/query/service/exact-entity-metadata-signals.js';
import { extractAllPairingConstraints, type PairingTag } from '../../domain/query/service/pairing-extractor.js';
import { parseSpans, resolveOverlaps, type Span } from '../../domain/attribute/service/span-parser.js';
import {
  isDirectEntityResolution,
  resolveEntity,
} from '../../domain/attribute/service/entity-resolver.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';

const SHORT_BARE_ENTITY_QUERY_MAX_TOKENS = 4;
const VINTAGE_TOKEN_PATTERN = /(?<![\p{L}\p{N}])(?:18|19|20)\d{2}(?:년산?|년대)?(?![\p{L}\p{N}])/gu;

interface SearchToolRetrievalCoreInput {
  readonly query: string;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly grape_primary?: string | undefined;
  readonly wine_type?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly vintage_min?: number | undefined;
  readonly vintage_max?: number | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly gift_suitability_min?: number | undefined;
  readonly beginner_suitability_min?: number | undefined;
  readonly producer_prestige_min?: number | undefined;
  readonly popularity_min?: number | undefined;
  readonly recipient_profile?: string | undefined;
  readonly sweetness_min?: number | undefined;
  readonly sweetness_max?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly acidity_max?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly drinking_window?: 'now' | undefined;
  readonly drinking_window_target_year?: number | undefined;
  /**
   * Concept comparison legs need representative-set retrieval ("Barolo wine"),
   * not a collapsed bare canonical lookup ("barolo").
   */
  readonly preserveRepresentativeSearch?: boolean | undefined;
}

function hasStructuredSetRetrievalPreferenceHints(
  input: SearchToolRetrievalCoreInput,
): boolean {
  return input.min_price_krw !== undefined
    || input.max_price_krw !== undefined
    || input.max_alcohol_pct !== undefined
    || input.style !== undefined
    || (input.styles?.length ?? 0) > 0
    || input.gift_suitability_min !== undefined
    || input.beginner_suitability_min !== undefined
    || input.producer_prestige_min !== undefined
    || input.popularity_min !== undefined
    || input.recipient_profile !== undefined
    || input.sweetness_min !== undefined
    || input.sweetness_max !== undefined
    || input.acidity_min !== undefined
    || input.acidity_max !== undefined
    || input.tannin_max !== undefined
    || (input.occasion?.length ?? 0) > 0
    || input.drinking_window !== undefined
    || input.drinking_window_target_year !== undefined;
}

function shouldPreserveRepresentativeAnchorOnlyQuery(
  input: SearchToolRetrievalCoreInput,
): boolean {
  if (input.preserveRepresentativeSearch === true) {
    return false;
  }
  if (!hasStructuredSetRetrievalPreferenceHints(input)) {
    return false;
  }

  const normalizedQuery = buildAgentQueryExecutionContract(input.query).hasEntityMetadataSignal
    && isExactMetadataEntityLookupCandidate(input.query)
    ? stripExactEntityLookupSuffix(input.query)
    : input.query;
  const queryViews = buildNormalizedQueryViews(normalizedQuery);
  return resolveCanonicalEntityTerms(queryViews).length > 0;
}

function hasStructuredGeographyFilter(input: SearchToolRetrievalCoreInput): boolean {
  return input.country !== undefined
    || input.region !== undefined
    || input.appellation !== undefined;
}

function collectStructuredRetrievalAnchors(input: SearchToolRetrievalCoreInput): readonly string[] {
  return [
    input.appellation,
    input.region,
    input.country,
    input.grape_primary,
    wineTypeToSemanticTerm(input.wine_type),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function shouldSuppressStructuredEntityLexicalDuplication(
  input: SearchToolRetrievalCoreInput,
  options: {
    readonly hasStructuredEntityAnchor: boolean;
    readonly hasUnrepresentedEntityAnchor: boolean;
    readonly pairingTagCount: number;
    readonly occasionTermCount: number;
  },
): boolean {
  if (input.preserveRepresentativeSearch === true) {
    return false;
  }
  if (!options.hasStructuredEntityAnchor || options.hasUnrepresentedEntityAnchor) {
    return false;
  }
  if (options.pairingTagCount > 0 || options.occasionTermCount > 0) {
    return false;
  }

  return hasStructuredGeographyFilter(input) || hasStructuredSetRetrievalPreferenceHints(input);
}

function pairingTagToSemanticTerm(tag: PairingTag): string {
  return tag.replace(/_/gu, ' ');
}

function occasionTagToSemanticTerm(tag: string): string | undefined {
  if (tag === 'cellaring') {
    return undefined;
  }
  return tag.replace(/_/gu, ' ');
}

function wineTypeToSemanticTerm(wineType: string | undefined): string | undefined {
  if (wineType === undefined) return undefined;
  return wineType === 'rosé' ? 'rose' : wineType;
}

function buildLexicalNucleus(
  queryViews: ReturnType<typeof buildNormalizedQueryViews>,
  rawQuery: string,
): string | undefined {
  const transliterated = queryViews.transliterated?.trim();
  if (transliterated !== undefined && transliterated.length > 0) {
    return transliterated;
  }
  const punctuationStripped = queryViews.punctuationStripped.trim();
  if (punctuationStripped.length > 0) {
    return punctuationStripped;
  }
  const trimmedRawQuery = rawQuery.trim();
  return trimmedRawQuery.length > 0 ? trimmedRawQuery : undefined;
}

function normalizeCanonicalEntityQueryTerm(rawValue: string): string | undefined {
  const queryViews = buildNormalizedQueryViews(rawValue);
  const transliterated = queryViews.transliterated?.trim();
  if (transliterated !== undefined && transliterated.length > 0) {
    return transliterated.toLowerCase();
  }
  const punctuationStripped = queryViews.punctuationStripped.trim();
  return punctuationStripped.length > 0 ? punctuationStripped.toLowerCase() : undefined;
}

function resolveCanonicalEntityTerms(
  queryViews: ReturnType<typeof buildNormalizedQueryViews>,
): readonly string[] {
  const lookupQueries = [
    ...new Set<string>([
      queryViews.strict,
      queryViews.punctuationStripped,
      ...(queryViews.transliterated !== undefined ? [queryViews.transliterated] : []),
    ]),
  ];
  const canonicals: string[] = [];
  const seen = new Set<string>();

  for (const lookupQuery of lookupQueries) {
    for (const span of parseSpans(lookupQuery)) {
      const romanized = Transliterator.romanizeWineTerm(span.text);
      if (romanized === undefined) {
        continue;
      }
      const canonical = romanized.trim().toLowerCase();
      if (canonical.length === 0 || seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      canonicals.push(canonical);
    }

    const resolvedSpans = resolveOverlaps(
      parseSpans(lookupQuery).map((span) => ({
        span,
        resolved: resolveEntity(span.text, { preferEntityOverStyle: true }),
      })),
    )
      .filter(
        (
          entry,
        ): entry is {
          span: Span;
          resolved: NonNullable<ReturnType<typeof resolveEntity>>;
        } => isDirectEntityResolution(entry.resolved),
      )
      .filter((entry) => entry.resolved.entityType !== 'wine_type');

    for (const entry of resolvedSpans) {
      const canonical = normalizeCanonicalEntityQueryTerm(entry.resolved.canonicalValue);
      if (canonical === undefined) {
        continue;
      }
      if (canonical.length === 0 || seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      canonicals.push(canonical);
    }
  }

  return canonicals;
}

function isResolvedEntityRepresentedByStructuredFilters(
  entity: ReturnType<typeof resolveEntity>,
  input: SearchToolRetrievalCoreInput,
): boolean {
  if (entity === null) return false;
  const canonical = entity.canonicalValue.toLowerCase();
  switch (entity.entityType) {
    case 'wine_type': {
      const structuredWineType = wineTypeToSemanticTerm(input.wine_type);
      return structuredWineType !== undefined && canonical === structuredWineType.toLowerCase();
    }
    case 'grape_primary':
      return input.grape_primary?.trim().toLowerCase() === canonical;
    case 'country':
      return input.country?.trim().toLowerCase() === canonical;
    case 'region':
      return input.region?.trim().toLowerCase() === canonical;
    case 'appellation':
      return input.appellation?.trim().toLowerCase() === canonical;
    default:
      return false;
  }
}

function hasVintageBearingDirectEntityAnchor(query: string): boolean {
  const stripped = query
    .replace(VINTAGE_TOKEN_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (stripped.length === 0) {
    return false;
  }
  const resolved = resolveEntity(stripped, { preferEntityOverStyle: true });
  return isDirectEntityResolution(resolved) && resolved.entityType !== 'wine_type';
}

export function buildSearchToolRetrievalCoreQuery(
  input: SearchToolRetrievalCoreInput,
): string {
  const queryContract = buildAgentQueryExecutionContract(input.query);
  const normalizedQuery = queryContract.hasEntityMetadataSignal && isExactMetadataEntityLookupCandidate(input.query)
    ? stripExactEntityLookupSuffix(input.query)
    : input.query;
  const queryViews = buildNormalizedQueryViews(normalizedQuery);
  const tokenCount = queryViews.punctuationStripped.length === 0
    ? 0
    : queryViews.punctuationStripped.split(/\s+/u).length;
  const pairingTags = [
    ...new Set<PairingTag>([
      ...extractAllPairingConstraints(input.query),
      ...extractAllPairingConstraints(queryViews.punctuationStripped),
      ...(queryViews.transliterated !== undefined
        ? extractAllPairingConstraints(queryViews.transliterated)
        : []),
      ]),
  ];
  const occasionTerms = [
    ...new Set(
      (input.occasion ?? [])
        .map(occasionTagToSemanticTerm)
        .filter((term): term is string => typeof term === 'string' && term.length > 0),
    ),
  ];
  const hasPositiveStructuredFilters =
    input.grape_primary !== undefined
    || input.wine_type !== undefined
    || input.country !== undefined
    || input.region !== undefined
    || input.appellation !== undefined
    || input.vintage_min !== undefined
    || input.vintage_max !== undefined;
  const hasExactVintageBounds =
    input.vintage_min !== undefined
    && input.vintage_max !== undefined
    && input.vintage_min === input.vintage_max;
  if (
    hasExactVintageBounds
    && (
      isSpecificSkuLikeQuery(normalizedQuery)
      || hasVintageBearingDirectEntityAnchor(normalizedQuery)
    )
  ) {
    return queryViews.transliterated?.trim().length
      ? queryViews.transliterated.trim()
      : normalizedQuery;
  }

  if (pairingTags.length === 0 && occasionTerms.length === 0 && !hasPositiveStructuredFilters) {
    const canonicalEntityTerms = resolveCanonicalEntityTerms(queryViews);
    if (queryContract.hasEntityMetadataSignal && isExactMetadataEntityLookupCandidate(input.query) && canonicalEntityTerms.length > 0) {
      return [...canonicalEntityTerms].sort((a, b) => b.length - a.length)[0]!;
    }
    if (
      input.preserveRepresentativeSearch !== true
      && tokenCount > 0
      && tokenCount <= SHORT_BARE_ENTITY_QUERY_MAX_TOKENS
      && canonicalEntityTerms.length === 1
    ) {
      return canonicalEntityTerms[0]!;
    }
    if (
      queryViews.transliterated !== undefined
      && queryViews.transliterated !== queryViews.punctuationStripped
      && tokenCount > 0
      && tokenCount <= SHORT_BARE_ENTITY_QUERY_MAX_TOKENS
    ) {
      return queryViews.transliterated;
    }
    return normalizedQuery;
  }

  const semanticTerms: string[] = [];
  const seen = new Set<string>();
  let hasEntitySemanticTerm = false;
  let hasStructuredEntityAnchor = false;
  let hasUnrepresentedEntityAnchor = false;
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    semanticTerms.push(trimmed);
  };

  const lookupQueries = [
    ...new Set<string>([
      queryViews.punctuationStripped,
      ...(queryViews.transliterated !== undefined ? [queryViews.transliterated] : []),
    ]),
  ];

  for (const lookupQuery of lookupQueries) {
    const resolvedSpans = resolveOverlaps(
      parseSpans(lookupQuery).map((span) => ({
        span,
        resolved: resolveEntity(span.text, { preferEntityOverStyle: true }),
      })),
    )
      .filter(
        (
          entry,
        ): entry is {
          span: Span;
          resolved: NonNullable<ReturnType<typeof resolveEntity>>;
        } => isDirectEntityResolution(entry.resolved),
      );

    for (const entry of resolvedSpans) {
      if (
        entry.resolved.entityType === 'wine_type'
        && input.wine_type !== undefined
      ) {
        hasStructuredEntityAnchor = true;
        continue;
      }
      if (isResolvedEntityRepresentedByStructuredFilters(entry.resolved, input)) {
        hasStructuredEntityAnchor = true;
        continue;
      }
      hasUnrepresentedEntityAnchor = true;
      hasEntitySemanticTerm = true;
      add(normalizeCanonicalEntityQueryTerm(entry.resolved.canonicalValue));
    }
  }

  const suppressStructuredEntityLexicalDuplication = shouldSuppressStructuredEntityLexicalDuplication(
    input,
    {
      hasStructuredEntityAnchor,
      hasUnrepresentedEntityAnchor,
      pairingTagCount: pairingTags.length,
      occasionTermCount: occasionTerms.length,
    },
  );

  if (hasEntitySemanticTerm && shouldPreserveRepresentativeAnchorOnlyQuery(input)) {
    return semanticTerms.join(' ');
  }

  if (
    !hasEntitySemanticTerm
    && !suppressStructuredEntityLexicalDuplication
    && (pairingTags.length > 0 || occasionTerms.length > 0 || hasPositiveStructuredFilters)
  ) {
    add(buildLexicalNucleus(queryViews, input.query));
  }

  for (const tag of pairingTags) {
    add(pairingTagToSemanticTerm(tag));
  }

  for (const occasion of occasionTerms) {
    add(occasion);
  }

  if (!hasEntitySemanticTerm) {
    add(input.grape_primary);
  }

  if (!hasEntitySemanticTerm) {
    add(wineTypeToSemanticTerm(input.wine_type));
  }

  if (semanticTerms.length === 0) {
    if (suppressStructuredEntityLexicalDuplication) {
      const structuredAnchors = collectStructuredRetrievalAnchors(input);
      return structuredAnchors.length > 0
        ? [...structuredAnchors, 'wine'].join(' ')
        : 'wine';
    }
    return normalizedQuery;
  }

  const hasWineToken = semanticTerms.some((term) => /(?:^|[^\p{L}\p{N}])wine(?=$|[^\p{L}\p{N}])/iu.test(term));
  if (!hasWineToken) {
    semanticTerms.push('wine');
  }

  return semanticTerms.join(' ');
}
