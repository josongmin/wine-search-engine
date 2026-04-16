import { buildAgentQueryExecutionContract, isExactMetadataEntityLookupCandidate } from '../agent/agent-query-execution-contract.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { stripExactEntityMetadataSuffix } from '../../domain/query/service/exact-entity-metadata-signals.js';
import { extractAllPairingConstraints, type PairingTag } from '../../domain/query/service/pairing-extractor.js';
import { parseSpans, resolveOverlaps, type Span } from '../../domain/attribute/service/span-parser.js';
import { resolveEntity } from '../../domain/attribute/service/entity-resolver.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';

const SHORT_BARE_ENTITY_QUERY_MAX_TOKENS = 4;

interface SearchToolRetrievalCoreInput {
  readonly query: string;
  readonly wine_type?: string | undefined;
  readonly country?: string | undefined;
  readonly appellation?: string | undefined;
  readonly vintage_min?: number | undefined;
  readonly vintage_max?: number | undefined;
}

function pairingTagToSemanticTerm(tag: PairingTag): string {
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
        } => entry.resolved !== null,
      )
      .filter((entry) => entry.resolved.entityType !== 'wine_type');

    for (const entry of resolvedSpans) {
      const canonical = entry.resolved.canonicalValue.trim().toLowerCase();
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
    case 'country':
      return input.country?.trim().toLowerCase() === canonical;
    case 'appellation':
      return input.appellation?.trim().toLowerCase() === canonical;
    default:
      return false;
  }
}

export function buildSearchToolRetrievalCoreQuery(
  input: SearchToolRetrievalCoreInput,
): string {
  const queryContract = buildAgentQueryExecutionContract(input.query);
  const normalizedQuery = queryContract.hasEntityMetadataSignal && isExactMetadataEntityLookupCandidate(input.query)
    ? stripExactEntityMetadataSuffix(input.query)
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
  const hasPositiveStructuredFilters =
    input.wine_type !== undefined
    || input.country !== undefined
    || input.appellation !== undefined
    || input.vintage_min !== undefined
    || input.vintage_max !== undefined;

  if (pairingTags.length === 0 && !hasPositiveStructuredFilters) {
    const canonicalEntityTerms = resolveCanonicalEntityTerms(queryViews);
    if (queryContract.hasEntityMetadataSignal && isExactMetadataEntityLookupCandidate(input.query) && canonicalEntityTerms.length > 0) {
      return [...canonicalEntityTerms].sort((a, b) => b.length - a.length)[0]!;
    }
    if (tokenCount > 0 && tokenCount <= SHORT_BARE_ENTITY_QUERY_MAX_TOKENS && canonicalEntityTerms.length === 1) {
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
        } => entry.resolved !== null,
      )
      .filter((entry) => !isResolvedEntityRepresentedByStructuredFilters(entry.resolved, input));

    for (const entry of resolvedSpans) {
      if (entry.resolved.entityType === 'wine_type' && input.wine_type !== undefined) {
        continue;
      }
      hasEntitySemanticTerm = true;
      add(entry.resolved.canonicalValue.toLowerCase());
    }
  }

  for (const tag of pairingTags) {
    add(pairingTagToSemanticTerm(tag));
  }

  if (!hasEntitySemanticTerm && pairingTags.length === 0 && hasPositiveStructuredFilters) {
    add(buildLexicalNucleus(queryViews, input.query));
  }

  if (!hasEntitySemanticTerm) {
    add(wineTypeToSemanticTerm(input.wine_type));
  }

  if (semanticTerms.length === 0) {
    return normalizedQuery;
  }

  const hasWineToken = semanticTerms.some((term) => /(?:^|[^\p{L}\p{N}])wine(?=$|[^\p{L}\p{N}])/iu.test(term));
  if (!hasWineToken) {
    semanticTerms.push('wine');
  }

  return semanticTerms.join(' ');
}
