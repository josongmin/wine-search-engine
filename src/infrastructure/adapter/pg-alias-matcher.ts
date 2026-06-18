import { type Pool } from 'pg';
import type { AliasMatcher, AliasMatchResult } from '../../domain/query/service/anchor-extractor.js';
import type { AliasType } from '../../domain/alias/model/alias.js';
import { parseAliasType } from '../../domain/alias/model/alias.js';
import { pickHigherTrustAliasType } from '../../domain/alias/service/conflict-resolver.js';
import {
  buildAliasLookupPlan,
  buildAliasSurfaceLookupPlan,
  isPhoneticAliasSurfaceCompatible,
} from '../../domain/query/service/alias-lookup-plan.js';
import {
  buildAliasPrefixTerms,
  isEligiblePrefixQuery,
  isDisallowedWholeLeadingTokenExpansion,
  matchesAliasPrefixTerm,
} from '../../domain/query/service/alias-prefix-terms.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import {
  compactForLookup,
  phoneticCompactForLookup,
} from '../../domain/query/service/phonetic-skeleton.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { doubleMetaphoneKeys } from '../../domain/alias/service/double-metaphone.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';
import {
  damerauLevenshteinOsa,
  editDistanceSimilarity,
  jaroWinklerSimilarity,
} from '../../domain/alias/service/edit-distance.js';

const ALIASES_TABLE_PRESENCE_CACHE_TTL_MS = 10_000;
const ALIASES_TABLE_MISSING_CACHE_TTL_MS = 10_000;

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
  /**
   * RFC-003 §4 alias type as stored on the `aliases.alias_type` column.
   * Optional only because the SQL is incrementally migrating call sites
   * to include the column. When present, the matcher emits it on
   * {@link AliasMatchResult.aliasType} so the resolver scorer can apply
   * type-specific caps without parsing strategy strings.
   */
  alias_type?: string | undefined;
}

type FuzzyLookupStrategy =
  | 'fuzzy_char_ngram'
  | 'transliterated_fuzzy'
  | 'phonetic_fuzzy';

/**
 * Minimum compacted query length (chars) before the fuzzy lane engages.
 * Below 5 chars the edit-distance / n-gram signals are dominated by noise
 * — a single edit on a 3-4 char surface flips the similarity wildly and
 * produces spurious matches across short producer abbreviations. Short
 * surfaces are already covered by the exact/compact/transliterated lanes.
 */
const MIN_FUZZY_QUERY_LENGTH = 5;
/**
 * Per-query ceiling on fuzzy candidate rows pulled from the aliases table
 * (the SQL `LIMIT`). The trigram-LIKE prefilter is recall-oriented and can
 * match broadly; this caps the row scan/transfer + the O(N) re-scoring loop
 * per query. 200 comfortably covers the densest real prefix clusters while
 * keeping batch fuzzy lookups bounded. Re-ranking by edit distance picks the
 * true match from within this pool, so a higher cap adds cost without recall.
 */
const MAX_FUZZY_CANDIDATES = 200;
/**
 * Max OSA edit distance allowed, as a fraction of the longer surface length,
 * for a candidate to clear the fuzzy gate on edit distance alone. 0.25 ≈ one
 * edit per four characters — tolerates realistic single typos/transpositions
 * (Sasicaia↔Sassicaia) without admitting unrelated surfaces of similar length.
 */
const COMPACT_FUZZY_DISTANCE_RATIO = 0.25;
/**
 * Minimum trigram (3-gram) Jaccard overlap to clear the fuzzy gate when edit
 * distance does not. 0.45 keeps mid-length surfaces that share substantial
 * local structure while rejecting incidental trigram coincidence between
 * unrelated names. Paired with the bigram floor for short surfaces.
 */
const MIN_CHAR_NGRAM_OVERLAP = 0.45;
/**
 * Minimum bigram (2-gram) Jaccard overlap floor, used for very short surfaces
 * where trigram coverage collapses. Set higher than the trigram floor (0.6 vs
 * 0.45) because bigrams are far less discriminative — a lower bar would admit
 * near-random 2-gram coincidence.
 */
const MIN_BIGRAM_OVERLAP = 0.6;
/**
 * Minimum length of a single whole-token query before it is allowed to match a
 * candidate token via the lexical-exact lane. Below 4 chars a whole-token
 * equality is too weak a signal (common short fragments collide across many
 * unrelated aliases), so we defer those to the stricter exact/prefix lanes.
 */
const MIN_WHOLE_TOKEN_LOOKUP_LENGTH = 4;
const ALIAS_TABLE_CHECK_TIMEOUT_MESSAGE = 'PostgreSQL alias-table existence probe timed out';

// Phonetic skeleton (PHONETIC_NORMALIZATION_RULES / LATIN_VOWEL_RE /
// compactForLookup / phoneticCompactForLookup) is the SSoT in
// `@domain/query/service/phonetic-skeleton`. The SQL `regexp_replace` chain
// in the exact-lookup query below mirrors PHONETIC_NORMALIZATION_RULES and is
// drift-guarded by `phonetic-skeleton-ssot.regression.test.ts`.

/**
 * Similarity score injected when a candidate's Double Metaphone key
 * intersects the query's key-set during the fuzzy phase.
 *
 * Set high enough to surface phonetic-only matches above noise, but
 * strictly below 1.0 so that lexical/transliterated exact matches still
 * outrank a phonetic-only result when both are present. Empirically,
 * Levenshtein-similar names (e.g. Margaux↔Margeaux) land around 0.86–
 * 0.92; 0.85 keeps phonetic candidates in the same recall band without
 * inflating them past genuine exact matches.
 */
const PHONETIC_FUZZY_BASE_SIMILARITY = 0.85;

interface AliasTablePresenceCacheEntry {
  readonly exists: boolean;
  readonly expiresAt: number;
}

const aliasTablePresenceByPool: Map<Pool, AliasTablePresenceCacheEntry> = new Map();
const aliasesTableDisabledUntilByPool: Map<Pool, number> = new Map();
const aliasesTableDisabledLogByPool: Set<Pool> = new Set();

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(ALIAS_TABLE_CHECK_TIMEOUT_MESSAGE);
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

export async function isAliasTableAvailable(
  pool: Pool,
  options?: { readonly queryTimeoutMs?: number },
): Promise<boolean> {
  const now = Date.now();
  const cached = aliasTablePresenceByPool.get(pool);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.exists;
  }

  const queryTimeoutMs = options?.queryTimeoutMs;
  const timed = queryTimeoutMs === undefined ? undefined : createTimeoutSignal(queryTimeoutMs);
  let result: { rows: ReadonlyArray<{ aliases_exists: boolean }>; };
  try {
    if (timed === undefined) {
      result = await pool.query<{ aliases_exists: boolean }>(
        `SELECT to_regclass('aliases') IS NOT NULL AS aliases_exists`,
      );
    } else if (typeof pool['connect'] === 'function') {
      result = await runAbortablePgQuery<{ aliases_exists: boolean }>(
        pool,
        timed.signal,
        `SELECT to_regclass('aliases') IS NOT NULL AS aliases_exists`,
      );
    } else {
      result = await pool.query<{ aliases_exists: boolean }>(
        `SELECT to_regclass('aliases') IS NOT NULL AS aliases_exists`,
      );
    }
  } catch (err: unknown) {
    aliasTablePresenceByPool.set(pool, {
      exists: false,
      expiresAt: now + ALIASES_TABLE_MISSING_CACHE_TTL_MS,
    });
    const code = readPgSqlState(err);
    if (code === '42P01' || code === undefined) {
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        if (code === '42P01') {
          throw err;
        }
        bootstrapLogger.warn(
          {
            err,
          },
          '[PgAliasMatcher] failed to resolve alias-table existence; disabling alias overlay for startup probe TTL',
        );
        return false;
      }
      bootstrapLogger.info(
        {
          err,
        },
        '[PgAliasMatcher] alias table existence probe failed — skipping PostgreSQL alias overlay',
      );
      return false;
    }
    throw err;
  } finally {
    timed?.clear();
  }
  const exists = result.rows[0]?.aliases_exists ?? false;
  aliasTablePresenceByPool.set(pool, {
    exists,
    expiresAt: now + ALIASES_TABLE_PRESENCE_CACHE_TTL_MS,
  });
  return exists;
}

function charNgrams(value: string, size: number = 3): readonly string[] {
  if (value.length === 0) {
    return [];
  }
  if (value.length <= size) {
    return [value];
  }

  const grams = new Set<string>();
  for (let i = 0; i <= value.length - size; i++) {
    grams.add(value.slice(i, i + size));
  }
  return Array.from(grams);
}

function charNgramOverlap(a: string, b: string, size: number = 3): number {
  const aGrams = charNgrams(a, size);
  const bGrams = new Set(charNgrams(b, size));
  if (aGrams.length === 0 || bGrams.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) {
      shared++;
    }
  }

  return shared / Math.max(aGrams.length, bGrams.size);
}

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * `true` iff two phonetic key-sets share at least one Double Metaphone
 * code. The empty-set case returns `false`: non-Latin inputs MUST NOT
 * fabricate a phonetic match.
 */
function doubleMetaphoneKeySetsIntersect(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size === 0 || b.size === 0) {
    return false;
  }
  for (const key of a) {
    if (b.has(key)) {
      return true;
    }
  }
  return false;
}

interface QueryVariantCandidate {
  readonly value: string;
  readonly strategy: FuzzyLookupStrategy;
}

interface QueryBoundAliasRow extends AliasRow {
  readonly queryId: number;
}

interface FuzzyAliasRow extends QueryBoundAliasRow {
  readonly lookupStrategy: FuzzyLookupStrategy;
}

interface BatchExactLookupPayload {
  readonly queryId: number;
  readonly exact: readonly string[];
  readonly compact: readonly string[];
  readonly transliterated: readonly string[];
  readonly phonetic: readonly string[];
  readonly doubleMetaphoneKeys: readonly string[];
}

interface BatchFuzzyLookupPayload {
  readonly queryId: number;
  readonly fuzzyGrams: readonly string[];
}

interface MatchPlan {
  readonly views: ReturnType<typeof buildAliasLookupPlan>['views'];
  readonly tokenList: readonly string[];
  readonly compactList: readonly string[];
  readonly transliteratedList: readonly string[];
  readonly phoneticList: readonly string[];
  readonly fuzzyVariants: readonly QueryVariantCandidate[];
  /**
   * Union of Double Metaphone primary+alternate keys across every
   * lookup variant for the query. Empty when no variant produced any
   * Latin-script phonetic signal (e.g. pure-Hangul queries).
   */
  readonly phoneticDoubleMetaphoneKeys: ReadonlySet<string>;
}

type QueryResultQueryId = number | string;

interface QueryBoundAliasRowFromSql extends Omit<QueryBoundAliasRow, 'queryId'> {
  readonly query_id: QueryResultQueryId;
}

type PgAliasMatcherRow = AliasRow | QueryBoundAliasRow | QueryBoundAliasRowFromSql;

function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}

function resolveExactLookupStrategy(
  plan: MatchPlan,
  row: Pick<AliasRow, 'normalized_value' | 'surface_form'>,
): string | undefined {
  const candidateViews = buildAliasLookupPlan(row.normalized_value).views;
  const transliteratedSet = new Set(plan.transliteratedList);
  const compactSet = new Set(plan.compactList);
  const phoneticSet = new Set(plan.phoneticList);
  const exactSet = new Set(plan.tokenList);
  const queryPrefixTerms = buildAliasPrefixTerms([plan.views.strict]).filter((token) => isEligiblePrefixQuery(token));
  const transliteratedPrefixTerms = plan.views.transliterated !== undefined
    ? buildAliasPrefixTerms([plan.views.transliterated]).filter((token) => isEligiblePrefixQuery(token))
    : [];
  const candidatePrefixTerms = buildAliasPrefixTerms([row.surface_form, row.normalized_value]);

  const normalizedLower = row.normalized_value.toLowerCase();
  const compactValue = compactForLookup(row.normalized_value);
  const compactLower = compactForLookup(normalizedLower);
  const phoneticValue = phoneticCompactForLookup(row.normalized_value);

  if (transliteratedSet.has(normalizedLower) || transliteratedSet.has(compactLower)) {
    return 'transliterated_exact';
  }
  if (compactSet.has(compactValue)) {
    return 'compact_exact';
  }
  if (exactSet.has(row.normalized_value)) {
    return 'exact';
  }
  const queryTokens = tokenizeForLookup(plan.views.vintageStripped);
  if (
    queryTokens.length === 1 &&
    queryTokens[0] !== undefined &&
    queryTokens[0].length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH &&
    tokenizeForLookup(candidateViews.vintageStripped).includes(queryTokens[0]) &&
    !isDisallowedWholeLeadingTokenExpansion(plan.views.vintageStripped, candidateViews.vintageStripped)
  ) {
    return 'lexical_exact';
  }
  if (
    transliteratedPrefixTerms.some((term) =>
      candidatePrefixTerms.some((candidateTerm) => matchesAliasPrefixTerm(term, candidateTerm))
    )
  ) {
    return 'transliterated_prefix';
  }
  if (
    queryPrefixTerms.some((term) =>
      candidatePrefixTerms.some((candidateTerm) => matchesAliasPrefixTerm(term, candidateTerm))
    )
  ) {
    return 'prefix_exact';
  }
  // Phonetic promotion uses Double Metaphone (Philips 2000) as the
  // *decision* signal, even though the SQL recall channel still uses the
  // looser compact-vowel-strip skeleton (`phoneticSet`/`phoneticValue`).
  // Either signal is sufficient to anchor the row to the phonetic phase;
  // requiring DM keyset overlap when present keeps precision high
  // without losing the legacy recall path.
  const candidateDmKeys = doubleMetaphoneKeys(row.normalized_value);
  const phoneticSkeletonMatches = phoneticSet.has(phoneticValue);
  const phoneticDoubleMetaphoneMatches = doubleMetaphoneKeySetsIntersect(
    plan.phoneticDoubleMetaphoneKeys,
    candidateDmKeys,
  );
  if (phoneticSkeletonMatches || phoneticDoubleMetaphoneMatches) {
    return isPhoneticAliasSurfaceCompatible(plan.views.punctuationStripped, row.surface_form)
      ? 'phonetic_exact'
      : undefined;
  }
  return undefined;
}

/**
 * Aggregates the four string-similarity signals into a single best score
 * per query variant. The four signals capture orthogonal error modes:
 *  - Damerau-Levenshtein (OSA) similarity → catches single-edit typos
 *    including adjacent transpositions ("Sasicaia" ↔ "Sassicaia"); strictly
 *    ≥ vanilla Levenshtein similarity for any input.
 *  - Jaro-Winkler → rewards prefix agreement, the dominant pattern for
 *    user-typed entity names that share a common producer prefix
 *    (e.g. Bordeaux "Château …" cluster).
 *  - Trigram (3-gram) Jaccard overlap → catches local substring agreement
 *    when ordering / casing differs.
 *  - Bigram (2-gram) Jaccard overlap → catches very short surfaces where
 *    trigram coverage collapses.
 *
 * Surviving the threshold gate requires either the OSA edit distance to
 * be within {@link COMPACT_FUZZY_DISTANCE_RATIO} of length OR an n-gram
 * overlap to clear its dedicated floor. The reported similarity is the
 * max of the four, so the matcher reports the *strongest* signal — which
 * is the right semantic for fuzzy alias lookup (any one of these being
 * strong indicates a plausible match).
 */
function bestFuzzySimilarity(
  queryVariants: readonly QueryVariantCandidate[],
  candidateCompact: string,
  queryDoubleMetaphoneKeys: ReadonlySet<string>,
  candidateDoubleMetaphoneKeys: ReadonlySet<string>,
): { similarity: number; strategy: FuzzyLookupStrategy } | null {
  let best: { similarity: number; strategy: FuzzyLookupStrategy } | null = null;

  for (const queryVariant of queryVariants) {
    const queryCompact = queryVariant.value;
    const maxLen = Math.max(queryCompact.length, candidateCompact.length);
    const maxDistance = Math.max(1, Math.floor(maxLen * COMPACT_FUZZY_DISTANCE_RATIO));
    const damerauDistance = damerauLevenshteinOsa(queryCompact, candidateCompact);
    const trigramOverlap = charNgramOverlap(queryCompact, candidateCompact);
    const bigramOverlap = charNgramOverlap(queryCompact, candidateCompact, 2);

    if (
      damerauDistance > maxDistance &&
      trigramOverlap < MIN_CHAR_NGRAM_OVERLAP &&
      bigramOverlap < MIN_BIGRAM_OVERLAP
    ) {
      continue;
    }

    const damerauSimilarity = editDistanceSimilarity(queryCompact, candidateCompact, damerauDistance);
    const jaroWinkler = jaroWinklerSimilarity(queryCompact, candidateCompact);
    const similarity = Math.max(damerauSimilarity, jaroWinkler, trigramOverlap, bigramOverlap);
    if (best === null || similarity > best.similarity) {
      best = { similarity, strategy: queryVariant.strategy };
    }
  }

  // Double Metaphone fuzzy fallback — gives recall for phonetic
  // variants where compact edit distance / n-gram overlap fall below
  // the thresholds (Sasicaia↔Sassicaia, Margeaux↔Margaux, etc.). Only
  // engages when no lexical fuzzy match was found; never *replaces* a
  // higher-scoring lexical hit because the lexical signal is more
  // discriminative when present.
  if (
    best === null
    && doubleMetaphoneKeySetsIntersect(queryDoubleMetaphoneKeys, candidateDoubleMetaphoneKeys)
  ) {
    best = { similarity: PHONETIC_FUZZY_BASE_SIMILARITY, strategy: 'phonetic_fuzzy' };
  }

  return best;
}

function groupRows<TRow extends AliasRow>(
  rows: readonly TRow[],
  lookupStrategy: string | ((row: TRow) => string | undefined) = 'exact',
): readonly AliasMatchResult[] {
  const byNorm = new Map<
    string,
    {
      surfaceForm: string;
      entityIds: Set<string>;
      confidence: number;
      strategies: Set<string>;
      aliasType: AliasType | undefined;
    }
  >();

  for (const row of rows) {
    const strategyForRow =
      typeof lookupStrategy === 'function' ? lookupStrategy(row) : lookupStrategy;
    if (strategyForRow === undefined) {
      continue;
    }
    const rowAliasType = parseAliasType(row.alias_type);
    const existing = byNorm.get(row.normalized_value);
    if (existing == null) {
      byNorm.set(row.normalized_value, {
        surfaceForm: row.surface_form,
        entityIds: new Set([row.entity_id]),
        confidence: row.confidence,
        strategies: new Set([strategyForRow]),
        aliasType: rowAliasType,
      });
      continue;
    }

    existing.entityIds.add(row.entity_id);
    existing.strategies.add(strategyForRow);
    if (row.confidence > existing.confidence) {
      existing.confidence = row.confidence;
    }
    // Higher-trust alias_type wins on conflict (curated > derived).
    existing.aliasType = pickHigherTrustAliasType(existing.aliasType, rowAliasType);
  }

  const matches: AliasMatchResult[] = [];
  for (const [norm, data] of byNorm) {
    matches.push({
      surfaceForm: data.surfaceForm,
      normalizedForm: norm,
      entityIds: Array.from(data.entityIds).map((id) => createCanonicalEntityId(id)),
      matchConfidence: data.confidence,
      lookupStrategy: Array.from(data.strategies).sort().join('+'),
      ...(data.aliasType !== undefined ? { aliasType: data.aliasType } : {}),
    });
  }

  matches.sort((a, b) => b.matchConfidence - a.matchConfidence);
  return matches;
}

function resolveQueryId(row: PgAliasMatcherRow): number | undefined {
  if ('queryId' in row && typeof row.queryId === 'number') {
    return row.queryId;
  }
  if ('query_id' in row && typeof row.query_id === 'number') {
    return row.query_id;
  }
  if ('query_id' in row && typeof row.query_id === 'bigint') {
    const parsed = Number(row.query_id);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if ('query_id' in row && typeof row.query_id === 'string') {
    const parsed = Number.parseInt(row.query_id, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * PostgreSQL-backed implementation of {@link AliasMatcher}.
 *
 * Tokenises the normalised query into unigrams, bigrams, and the full
 * phrase, then performs a single batch lookup against the aliases table.
 * Results are grouped by normalised_value and sorted by confidence.
 */
export class PgAliasMatcher implements AliasMatcher {
  private activeSnapshotMissingTableUntil = 0;
  private activeSnapshotMissingTableLogged = false;
  private phoneticKeysColumnProbe: Promise<boolean> | undefined;

  constructor(private readonly pool: Pool) {}

  private phoneticKeysColumnEnabled(): Promise<boolean> {
    this.phoneticKeysColumnProbe ??= pgTableHasColumn(this.pool, 'aliases', 'phonetic_keys').catch(
      () => false,
    );
    return this.phoneticKeysColumnProbe;
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) return [];

    const matched = await this.findMatchesBatch([trimmed]);
    return matched.get(trimmed) ?? [];
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const dedupedQueries = this.trimDedupedQueries(normalizedQueries);
    if (dedupedQueries.length === 0) {
      return new Map();
    }

    const activeSnapshotId = await this.resolveActiveSnapshotId();
    if (activeSnapshotId === null) {
      const emptyMatches = new Map<string, readonly AliasMatchResult[]>();
      for (const query of dedupedQueries) {
        emptyMatches.set(query, []);
      }
      return emptyMatches;
    }

    const planByQuery = new Map<string, MatchPlan | null>();
    for (const query of dedupedQueries) {
      planByQuery.set(query, this.buildMatchPlan(query));
    }

    return this.runBatchMatch(planByQuery, activeSnapshotId);
  }

  private async runBatchMatch(
    planByQuery: Map<string, MatchPlan | null>,
    activeSnapshotId: string,
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const matchesByQuery = new Map<string, readonly AliasMatchResult[]>();
    const queryIdByQuery = new Map<string, number>();
    const planByQueryId = new Map<number, MatchPlan>();

    const exactPayload: BatchExactLookupPayload[] = [];
    let nextQueryId = 0;
    for (const [query, plan] of planByQuery.entries()) {
      if (plan === null) {
        matchesByQuery.set(query, []);
        continue;
      }

      const queryId = nextQueryId;
      nextQueryId += 1;
      queryIdByQuery.set(query, queryId);
      planByQueryId.set(queryId, plan);
      matchesByQuery.set(query, []);

      exactPayload.push({
        queryId,
        exact: plan.tokenList,
        compact: plan.compactList,
        transliterated: plan.transliteratedList,
        phonetic: plan.phoneticList,
        doubleMetaphoneKeys: [...plan.phoneticDoubleMetaphoneKeys].sort((left, right) =>
          left.localeCompare(right),
        ),
      });
    }

    const exactRowsByQueryId = new Map<number, readonly AliasMatchResult[]>();
    if (exactPayload.length > 0) {
      const exactPayloadQueryIds = exactPayload.map((payload) => payload.queryId);
      const exactRowsById = new Map<number, QueryBoundAliasRow[]>(
        exactPayload.map((payload) => [payload.queryId, []]),
      );
      const phoneticKeysColumnEnabled = await this.phoneticKeysColumnEnabled();
      const exactRows = await this.queryAliases(
        phoneticKeysColumnEnabled
          ? `SELECT candidate.entity_id,
           candidate.surface_form,
           candidate.normalized_value,
           candidate.confidence,
           candidate.alias_type,
           q.query_id
         FROM unnest($1::int[], $2::text[][], $3::text[][], $4::text[][], $5::text[][], $6::text[][])
              AS q(query_id, exact_values, compact_values, transliterated_values, phonetic_values, dm_keys)
         CROSS JOIN LATERAL (
           SELECT entity_id, surface_form, normalized_value, confidence, alias_type
           FROM aliases
           WHERE search_snapshot_id = $7
             AND (
               normalized_value = ANY(q.exact_values)
               OR regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g') = ANY(q.compact_values)
               OR lower(regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g')) = ANY(q.transliterated_values)
               OR regexp_replace(
                    lower(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(
                              regexp_replace(
                                regexp_replace(
                                  regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g'),
                                  'sch', 'ch', 'g'
                                ),
                                'sh', 'ch', 'g'
                              ),
                              'ph', 'f', 'g'
                            ),
                            'eaux', 'o', 'g'
                          ),
                          'eau', 'o', 'g'
                        ),
                        'aux', 'o', 'g'
                      )
                    ),
                    '[aeiouy]', '', 'g'
                  ) = ANY(q.phonetic_values)
               OR (
                 cardinality(q.dm_keys) > 0
                 AND phonetic_keys && q.dm_keys
               )
             )
             AND is_suppressed = FALSE
           ORDER BY confidence DESC
         ) AS candidate
         ORDER BY q.query_id, confidence DESC`
          : `SELECT candidate.entity_id,
           candidate.surface_form,
           candidate.normalized_value,
           candidate.confidence,
           candidate.alias_type,
           q.query_id
         FROM unnest($1::int[], $2::text[][], $3::text[][], $4::text[][], $5::text[][])
              AS q(query_id, exact_values, compact_values, transliterated_values, phonetic_values)
         CROSS JOIN LATERAL (
           SELECT entity_id, surface_form, normalized_value, confidence, alias_type
           FROM aliases
           WHERE search_snapshot_id = $6
             AND (
               normalized_value = ANY(q.exact_values)
               OR regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g') = ANY(q.compact_values)
               OR lower(regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g')) = ANY(q.transliterated_values)
               OR regexp_replace(
                    lower(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(
                              regexp_replace(
                                regexp_replace(
                                  regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g'),
                                  'sch', 'ch', 'g'
                                ),
                                'sh', 'ch', 'g'
                              ),
                              'ph', 'f', 'g'
                            ),
                            'eaux', 'o', 'g'
                          ),
                          'eau', 'o', 'g'
                        ),
                        'aux', 'o', 'g'
                      )
                    ),
                    '[aeiouy]', '', 'g'
                  ) = ANY(q.phonetic_values)
             )
             AND is_suppressed = FALSE
           ORDER BY confidence DESC
         ) AS candidate
         ORDER BY q.query_id, confidence DESC`,
        phoneticKeysColumnEnabled
          ? [
            exactPayloadQueryIds,
            exactPayload.map((payload) => payload.exact),
            exactPayload.map((payload) => payload.compact),
            exactPayload.map((payload) => payload.transliterated),
            exactPayload.map((payload) => payload.phonetic),
            exactPayload.map((payload) => payload.doubleMetaphoneKeys),
            activeSnapshotId,
          ]
          : [
            exactPayloadQueryIds,
            exactPayload.map((payload) => payload.exact),
            exactPayload.map((payload) => payload.compact),
            exactPayload.map((payload) => payload.transliterated),
            exactPayload.map((payload) => payload.phonetic),
            activeSnapshotId,
          ],
        exactPayloadQueryIds,
      );

      for (const row of exactRows.rows) {
        const targetRows = exactRowsById.get(row.queryId);
        if (targetRows === undefined) {
          continue;
        }
        targetRows.push(row);
      }

      for (const [queryId, rows] of exactRowsById.entries()) {
        const plan = planByQueryId.get(queryId);
        if (plan === undefined || rows.length === 0) {
          continue;
        }
        const grouped = groupRows(rows, (row) => resolveExactLookupStrategy(plan, row));
        if (grouped.length > 0) {
          exactRowsByQueryId.set(queryId, grouped);
        }
      }
    }

    for (const [query, queryId] of queryIdByQuery.entries()) {
      const exactMatch = exactRowsByQueryId.get(queryId);
      if (exactMatch !== undefined && exactMatch.length > 0) {
        matchesByQuery.set(query, exactMatch);
      }
    }

    const fuzzyPayload: BatchFuzzyLookupPayload[] = [];
    const fuzzyQueriesById = new Map<number, readonly AliasMatchResult[]>();
    for (const [, queryId] of queryIdByQuery.entries()) {
      if (exactRowsByQueryId.get(queryId) !== undefined) {
        continue;
      }

      const plan = planByQueryId.get(queryId);
      if (plan === undefined) {
        continue;
      }
      if (plan.fuzzyVariants.length === 0) {
        continue;
      }

      const fuzzyGrams = Array.from(
        new Set(plan.fuzzyVariants.flatMap((variant) => charNgrams(variant.value))),
      ).map(escapeLikePattern);

      fuzzyPayload.push({
        queryId,
        fuzzyGrams,
      });
      fuzzyQueriesById.set(queryId, []);
    }

    if (fuzzyPayload.length > 0) {
      const fuzzyRows = await this.queryAliases(
        `SELECT candidate.entity_id,
           candidate.surface_form,
           candidate.normalized_value,
           candidate.confidence,
           candidate.alias_type,
           q.query_id
         FROM unnest($1::int[], $2::text[][])
              AS q(query_id, fuzzy_grams)
         CROSS JOIN LATERAL (
           SELECT entity_id, surface_form, normalized_value, confidence, alias_type
           FROM aliases
           WHERE search_snapshot_id = $3
             AND is_suppressed = FALSE
             AND EXISTS (
               SELECT 1
               FROM unnest(q.fuzzy_grams) AS gram
               WHERE regexp_replace(normalized_value, '[[:space:][:punct:]]+', '', 'g')
                     LIKE '%' || gram || '%' ESCAPE '\\'
             )
           ORDER BY confidence DESC
           LIMIT $4
         ) AS candidate
         ORDER BY q.query_id, confidence DESC`,
        [
          fuzzyPayload.map((payload) => payload.queryId),
          fuzzyPayload.map((payload) => payload.fuzzyGrams),
          activeSnapshotId,
          MAX_FUZZY_CANDIDATES,
        ],
        fuzzyPayload.map((payload) => payload.queryId),
      );

    const scoredFuzzyRowsByQueryId = new Map<number, FuzzyAliasRow[]>();
      for (const row of fuzzyRows.rows) {
        const plan = planByQueryId.get(row.queryId);
        if (plan === undefined) {
          continue;
        }
        const candidateCompact = compactForLookup(row.normalized_value);
        if (candidateCompact.length === 0) {
          continue;
        }
        const candidateDmKeys = doubleMetaphoneKeys(row.normalized_value);
        const fuzzyMatch = bestFuzzySimilarity(
          plan.fuzzyVariants,
          candidateCompact,
          plan.phoneticDoubleMetaphoneKeys,
          candidateDmKeys,
        );
        if (fuzzyMatch === null) {
          continue;
        }
        const scoredRow: FuzzyAliasRow = {
          ...row,
          confidence: row.confidence * fuzzyMatch.similarity,
          lookupStrategy: fuzzyMatch.strategy,
        };
        const previous = scoredFuzzyRowsByQueryId.get(row.queryId);
        if (previous === undefined) {
          scoredFuzzyRowsByQueryId.set(row.queryId, [scoredRow]);
          continue;
        }
        previous.push(scoredRow);
      }

      for (const [queryId, rows] of scoredFuzzyRowsByQueryId.entries()) {
        if (rows.length === 0) {
          continue;
        }
        const grouped = groupRows<FuzzyAliasRow>(rows, (row) => row.lookupStrategy);
        if (grouped.length > 0) {
          fuzzyQueriesById.set(queryId, grouped);
        }
      }
    }

    for (const [query, queryId] of queryIdByQuery.entries()) {
      if (matchesByQuery.get(query)?.length !== 0) {
        continue;
      }
      const fuzzyMatches = fuzzyQueriesById.get(queryId);
      if (fuzzyMatches !== undefined) {
        matchesByQuery.set(query, fuzzyMatches);
      }
    }

    return matchesByQuery;
  }

  private buildMatchPlan(normalizedQuery: string): MatchPlan | null {
    const lookupPlan = buildAliasSurfaceLookupPlan(normalizedQuery);
    const { views, tokenList, compactList, transliteratedList, phoneticList } = lookupPlan;

    const fuzzyVariants = Array.from(
      new Map<string, QueryVariantCandidate>(
        views.lookupVariants.flatMap((value) => {
          const compactValue = compactForLookup(value);
          if (compactValue.length < MIN_FUZZY_QUERY_LENGTH) {
            return [];
          }

          const strategy: FuzzyLookupStrategy =
            views.phoneticCompact !== undefined && compactValue === views.phoneticCompact
              ? 'phonetic_fuzzy'
              : views.transliterated !== undefined &&
                  (value === views.transliterated ||
                    compactValue === compactForLookup(views.transliterated))
                ? 'transliterated_fuzzy'
                : 'fuzzy_char_ngram';

          return [[compactValue, { value: compactValue, strategy }] as const];
        }),
      ).values(),
    );

    if (
      tokenList.length === 0 &&
      compactList.length === 0 &&
      transliteratedList.length === 0 &&
      phoneticList.length === 0
    ) {
      return null;
    }

    // Union the Double Metaphone keys across every lookup variant.
    // Each variant is a different normalization of the same query, so
    // any phonetic code it produces is a legitimate match signal. Hangul-
    // only variants contribute the empty set and are ignored implicitly.
    const phoneticDoubleMetaphoneKeys = new Set<string>();
    for (const variant of views.lookupVariants) {
      for (const key of doubleMetaphoneKeys(variant)) {
        phoneticDoubleMetaphoneKeys.add(key);
      }
    }

    return {
      views,
      tokenList,
      compactList,
      transliteratedList,
      phoneticList,
      fuzzyVariants,
      phoneticDoubleMetaphoneKeys,
    };
  }

  private async resolveActiveSnapshotId(): Promise<string | null> {
    const now = Date.now();
    if (this.activeSnapshotMissingTableUntil > now) {
      return null;
    }

    try {
      const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
      this.activeSnapshotMissingTableUntil = 0;
      this.activeSnapshotMissingTableLogged = false;
      return activeSnapshotId;
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        throw err;
      }
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw err;
      }
      this.activeSnapshotMissingTableUntil = now + ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS;
      if (!this.activeSnapshotMissingTableLogged) {
        bootstrapLogger.info(
          '[PgAliasMatcher] active_search_snapshot table missing — alias matching disabled until substrate recovers',
        );
        this.activeSnapshotMissingTableLogged = true;
      }
      return null;
    }
  }

  private async queryAliases(
    sql: string,
    params: readonly unknown[],
    fallbackQueryIds: readonly number[] = [],
  ): Promise<{ rows: QueryBoundAliasRow[] }> {
    const now = Date.now();
    const aliasesDisabledUntil = aliasesTableDisabledUntilByPool.get(this.pool);
    if (aliasesDisabledUntil !== undefined && aliasesDisabledUntil > now) {
      return { rows: [] };
    }

    try {
      const result = await this.pool.query<PgAliasMatcherRow>(sql, [...params]);
      const fallbackQueryId =
        fallbackQueryIds.length === 1 ? fallbackQueryIds[0] : undefined;
      return {
        rows: result.rows
          .map((row) => {
            const queryId = resolveQueryId(row);
            if (queryId !== undefined) {
              return { ...row, queryId };
            }
            if (fallbackQueryId !== undefined) {
              return { ...row, queryId: fallbackQueryId };
            }
            return null;
          })
          .filter((row): row is PgAliasMatcherRow & { queryId: number } => row !== null)
          .filter((row): row is QueryBoundAliasRow => typeof row.queryId === 'number'),
      };
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        throw err;
      }
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw err;
      }
      aliasesTableDisabledUntilByPool.set(this.pool, now + ALIASES_TABLE_MISSING_CACHE_TTL_MS);
      if (!aliasesTableDisabledLogByPool.has(this.pool)) {
        bootstrapLogger.info(
          '[PgAliasMatcher] aliases table does not exist yet — alias matching disabled for this request',
        );
        aliasesTableDisabledLogByPool.add(this.pool);
      }
      return { rows: [] };
    }
  }

  private trimDedupedQueries(queries: readonly string[]): readonly string[] {
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
}
