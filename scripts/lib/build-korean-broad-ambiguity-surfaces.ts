import { CURATED_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/entity-alias-catalog.js';
import { GOLD_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/gold-korean-entity-alias-catalog.js';
import { SEEDED_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/seeded-korean-entity-alias-catalog.js';
import { SILVER_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/silver-korean-entity-alias-catalog.js';
import {
  loadGoldStructuredKoreanAliasSourceRows,
  loadSeedStructuredKoreanAliasSourceRows,
  loadSilverStructuredKoreanAliasSourceRows,
  type StructuredKoreanAliasSourceProvenance,
  type StructuredKoreanAliasSourceRow,
} from './structured-korean-alias-source.js';

const WHITESPACE_RE = /\s+/gu;

export type BroadAmbiguityClassifier =
  | 'producer_family'
  | 'cross_producer_shared_surface'
  | 'multi_entity_generic_surface';

export interface GeneratedKoreanBroadAmbiguitySurfaceEntry {
  readonly term: string;
  readonly types: readonly string[];
  readonly severity: 'high';
  readonly classifiers: readonly BroadAmbiguityClassifier[];
  readonly sources: readonly StructuredKoreanAliasSourceProvenance[];
  readonly supportingCanonicalValues: readonly string[];
}

interface CandidateExactAliasEntry {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly provenance: StructuredKoreanAliasSourceProvenance;
}

interface AliasObservation {
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly row: StructuredKoreanAliasSourceRow;
}

function normalizeSurface(surface: string): string {
  return surface.normalize('NFKC').toLowerCase().replace(WHITESPACE_RE, ' ').trim();
}

function compactSurface(surface: string): string {
  return normalizeSurface(surface).replaceAll(' ', '');
}

function tokenize(surface: string): readonly string[] {
  return normalizeSurface(surface).split(' ').filter((token) => token.length > 0);
}

function isContiguousTokenSubsequence(
  shortTokens: readonly string[],
  longTokens: readonly string[],
): boolean {
  if (shortTokens.length === 0 || shortTokens.length >= longTokens.length) {
    return false;
  }

  for (let start = 0; start <= longTokens.length - shortTokens.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < shortTokens.length; offset += 1) {
      if (longTokens[start + offset] !== shortTokens[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }

  return false;
}

function isProperBroadSuperphrase(surface: string, alias: string): boolean {
  const normalizedSurface = normalizeSurface(surface);
  const normalizedAlias = normalizeSurface(alias);

  if (normalizedSurface.length === 0 || normalizedSurface === normalizedAlias) {
    return false;
  }

  if (isContiguousTokenSubsequence(tokenize(surface), tokenize(alias))) {
    return true;
  }

  const compactCandidate = compactSurface(surface);
  const compactAlias = compactSurface(alias);

  if (compactCandidate.length === 0 || compactCandidate === compactAlias) {
    return false;
  }

  return compactAlias.startsWith(compactCandidate) || compactAlias.endsWith(compactCandidate);
}

function collectCandidateExactAliases(): readonly CandidateExactAliasEntry[] {
  return [
    ...GOLD_KOREAN_ENTITY_ALIAS_CATALOG.map((entry) => ({
      surface: entry.surface,
      canonicalValue: entry.canonicalValue,
      provenance: entry.provenance,
    })),
    ...SEEDED_KOREAN_ENTITY_ALIAS_CATALOG.map((entry) => ({
      surface: entry.surface,
      canonicalValue: entry.canonicalValue,
      provenance: entry.provenance,
    })),
    ...SILVER_KOREAN_ENTITY_ALIAS_CATALOG.map((entry) => ({
      surface: entry.surface,
      canonicalValue: entry.canonicalValue,
      provenance: entry.provenance,
    })),
  ];
}

function buildProtectedCuratedSurfaceSet(): ReadonlySet<string> {
  return new Set(
    CURATED_ENTITY_ALIAS_CATALOG
      .filter((entry) =>
        entry.provenance !== 'gold_catalog'
        && entry.provenance !== 'seed_catalog'
        && entry.provenance !== 'silver_catalog')
      .map((entry) => normalizeSurface(entry.surface)),
  );
}

export async function buildGeneratedKoreanBroadAmbiguitySurfaces():
Promise<readonly GeneratedKoreanBroadAmbiguitySurfaceEntry[]> {
  const sourceRows = [
    ...(await loadGoldStructuredKoreanAliasSourceRows()),
    ...loadSeedStructuredKoreanAliasSourceRows(),
    ...(await loadSilverStructuredKoreanAliasSourceRows()),
  ];
  const candidateEntries = collectCandidateExactAliases();
  const protectedCuratedSurfaces = buildProtectedCuratedSurfaceSet();
  const rowByCanonical = new Map(sourceRows.map((row) => [row.canonicalLabel, row] as const));
  const producerFamilySize = new Map<string, number>();
  const observations: AliasObservation[] = [];

  for (const row of sourceRows) {
    const producerKey = normalizeSurface(row.producer);
    producerFamilySize.set(producerKey, (producerFamilySize.get(producerKey) ?? 0) + 1);

    for (const alias of row.koreanAliases) {
      observations.push({
        alias,
        normalizedAlias: normalizeSurface(alias),
        row,
      });
    }
  }

  const aggregated = new Map<
    string,
    {
      term: string;
      types: Set<string>;
      classifiers: Set<BroadAmbiguityClassifier>;
      sources: Set<StructuredKoreanAliasSourceProvenance>;
      supportingCanonicalValues: Set<string>;
    }
  >();

  for (const candidate of candidateEntries) {
    const row = rowByCanonical.get(candidate.canonicalValue);
    if (row === undefined) {
      continue;
    }

    const candidateKey = normalizeSurface(candidate.surface);
    if (protectedCuratedSurfaces.has(candidateKey)) {
      continue;
    }
    const sameProducerRows = sourceRows.filter(
      (sourceRow) => normalizeSurface(sourceRow.producer) === normalizeSurface(row.producer),
    );
    const supportingObservations = observations.filter((observation) =>
      isProperBroadSuperphrase(candidate.surface, observation.alias),
    );

    const supportingProducerKeys = new Set(
      supportingObservations.map((observation) => normalizeSurface(observation.row.producer)),
    );
    const producerScopedSupportingAliases = new Set(
      supportingObservations
        .filter((observation) =>
          normalizeSurface(observation.row.producer) === normalizeSurface(row.producer))
        .map((observation) => observation.normalizedAlias),
    );
    const producerScopedSupportingCanonicals = new Set(
      supportingObservations
        .filter((observation) =>
          normalizeSurface(observation.row.producer) === normalizeSurface(row.producer))
        .map((observation) => observation.row.canonicalLabel),
    );
    const supportingCanonicalValues = new Set(
      supportingObservations.map((observation) => observation.row.canonicalLabel),
    );

    const producerFamilyBroad =
      (producerFamilySize.get(normalizeSurface(row.producer)) ?? 0) > 1
      && producerScopedSupportingAliases.size > 1
      && producerScopedSupportingCanonicals.size > 1
      && sameProducerRows.length > 1;
    const multiEntityBroad = supportingCanonicalValues.size > 1;

    if (!producerFamilyBroad && !multiEntityBroad) {
      continue;
    }

    const current = aggregated.get(candidateKey) ?? {
      term: candidate.surface,
      types: new Set<string>(),
      classifiers: new Set<BroadAmbiguityClassifier>(),
      sources: new Set<'gold_catalog' | 'seed_catalog'>(),
      supportingCanonicalValues: new Set<string>(),
    };

    current.sources.add(candidate.provenance);
    current.supportingCanonicalValues.add(candidate.canonicalValue);

    if (producerFamilyBroad) {
      current.types.add('producer');
      current.types.add('entity');
      current.classifiers.add('producer_family');
    }

    if (multiEntityBroad) {
      current.types.add('entity');
      current.types.add('generic_surface');
      if (supportingProducerKeys.size > 1) {
        current.types.add('appellation');
      }
      current.classifiers.add('multi_entity_generic_surface');
    }

    aggregated.set(candidateKey, current);
  }

  return [...aggregated.values()]
    .map((entry) => ({
      term: entry.term,
      types: [...entry.types].sort(),
      severity: 'high' as const,
      classifiers: [...entry.classifiers].sort(),
      sources: [...entry.sources].sort(),
      supportingCanonicalValues: [...entry.supportingCanonicalValues].sort((left, right) =>
        left.localeCompare(right, 'en')),
    }))
    .sort((left, right) => left.term.localeCompare(right.term, 'ko'));
}
