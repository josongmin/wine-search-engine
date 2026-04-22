import type { Pool } from 'pg';
import type { AliasMatcher, AliasMatchResult } from '../../domain/query/service/anchor-extractor.js';
import {
  buildAliasLookupPlan,
  isPhoneticAliasSurfaceCompatible,
} from '../../domain/query/service/alias-lookup-plan.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

const ALIASES_TABLE_PRESENCE_CACHE_TTL_MS = 10_000;
const ALIASES_TABLE_MISSING_CACHE_TTL_MS = 10_000;

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
}

type FuzzyLookupStrategy =
  | 'fuzzy_char_ngram'
  | 'transliterated_fuzzy'
  | 'phonetic_fuzzy';

const MIN_FUZZY_QUERY_LENGTH = 5;
const MAX_FUZZY_CANDIDATES = 200;
const COMPACT_FUZZY_DISTANCE_RATIO = 0.25;
const MIN_CHAR_NGRAM_OVERLAP = 0.45;
const MIN_BIGRAM_OVERLAP = 0.6;
const LATIN_VOWEL_RE = /[aeiouy]/g;
const PHONETIC_NORMALIZATION_RULES: readonly [RegExp, string][] = [
  [/sch/g, 'ch'],
  [/sh/g, 'ch'],
  [/ph/g, 'f'],
  [/eaux/g, 'o'],
  [/eau/g, 'o'],
  [/aux/g, 'o'],
] as const;

interface AliasTablePresenceCacheEntry {
  readonly exists: boolean;
  readonly expiresAt: number;
}

const aliasTablePresenceByPool = new WeakMap<Pool, AliasTablePresenceCacheEntry>();
const aliasesTableDisabledUntilByPool = new WeakMap<Pool, number>();
const aliasesTableDisabledLogByPool = new WeakSet<Pool>();

export async function isAliasTableAvailable(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = aliasTablePresenceByPool.get(pool);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.exists;
  }

  const result = await pool.query<{ aliases_exists: boolean }>(
    `SELECT to_regclass('aliases') IS NOT NULL AS aliases_exists`,
  );
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

function compactForLookup(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function phoneticCompactForLookup(value: string): string {
  let normalized = compactForLookup(value).toLowerCase();
  for (const [pattern, replacement] of PHONETIC_NORMALIZATION_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(LATIN_VOWEL_RE, '');
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
  const transliteratedSet = new Set(plan.transliteratedList);
  const compactSet = new Set(plan.compactList);
  const phoneticSet = new Set(plan.phoneticList);
  const exactSet = new Set(plan.tokenList);

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
  if (phoneticSet.has(phoneticValue)) {
    return isPhoneticAliasSurfaceCompatible(plan.views.punctuationStripped, row.surface_form)
      ? 'phonetic_exact'
      : undefined;
  }
  return 'lexical_exact';
}

function bestFuzzySimilarity(
  queryVariants: readonly QueryVariantCandidate[],
  candidateCompact: string,
): { similarity: number; strategy: FuzzyLookupStrategy } | null {
  let best: { similarity: number; strategy: FuzzyLookupStrategy } | null = null;

  for (const queryVariant of queryVariants) {
    const queryCompact = queryVariant.value;
    const maxLen = Math.max(queryCompact.length, candidateCompact.length);
    const maxDistance = Math.max(1, Math.floor(maxLen * COMPACT_FUZZY_DISTANCE_RATIO));
    const distance = editDistance(queryCompact, candidateCompact);
    const trigramOverlap = charNgramOverlap(queryCompact, candidateCompact);
    const bigramOverlap = charNgramOverlap(queryCompact, candidateCompact, 2);

    if (
      distance > maxDistance &&
      trigramOverlap < MIN_CHAR_NGRAM_OVERLAP &&
      bigramOverlap < MIN_BIGRAM_OVERLAP
    ) {
      continue;
    }

    const editSimilarity = 1 - distance / maxLen;
    const similarity = Math.max(editSimilarity, trigramOverlap, bigramOverlap);
    if (best === null || similarity > best.similarity) {
      best = { similarity, strategy: queryVariant.strategy };
    }
  }

  return best;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

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

  const distance = prev[n];
  if (distance === undefined) {
    throw new Error('levenshtein: result undefined');
  }
  return distance;
}

function groupRows<TRow extends AliasRow>(
  rows: readonly TRow[],
  lookupStrategy: string | ((row: TRow) => string | undefined) = 'exact',
): readonly AliasMatchResult[] {
  const byNorm = new Map<
    string,
    { surfaceForm: string; entityIds: Set<string>; confidence: number; strategies: Set<string> }
  >();

  for (const row of rows) {
    const strategyForRow =
      typeof lookupStrategy === 'function' ? lookupStrategy(row) : lookupStrategy;
    if (strategyForRow === undefined) {
      continue;
    }
    const existing = byNorm.get(row.normalized_value);
    if (existing == null) {
      byNorm.set(row.normalized_value, {
        surfaceForm: row.surface_form,
        entityIds: new Set([row.entity_id]),
        confidence: row.confidence,
        strategies: new Set([strategyForRow]),
      });
      continue;
    }

    existing.entityIds.add(row.entity_id);
    existing.strategies.add(strategyForRow);
    if (row.confidence > existing.confidence) {
      existing.confidence = row.confidence;
    }
  }

  const matches: AliasMatchResult[] = [];
  for (const [norm, data] of byNorm) {
    matches.push({
      surfaceForm: data.surfaceForm,
      normalizedForm: norm,
      entityIds: Array.from(data.entityIds).map((id) => createCanonicalEntityId(id)),
      matchConfidence: data.confidence,
      lookupStrategy: Array.from(data.strategies).sort().join('+'),
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

  constructor(private readonly pool: Pool) {}

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
      });
    }

    const exactRowsByQueryId = new Map<number, readonly AliasMatchResult[]>();
    if (exactPayload.length > 0) {
      const exactPayloadQueryIds = exactPayload.map((payload) => payload.queryId);
      const exactRowsById = new Map<number, QueryBoundAliasRow[]>(
        exactPayload.map((payload) => [payload.queryId, []]),
      );
      const exactRows = await this.queryAliases(
        `SELECT candidate.entity_id,
           candidate.surface_form,
           candidate.normalized_value,
           candidate.confidence,
           q.query_id
         FROM unnest($1::int[], $2::text[][], $3::text[][], $4::text[][], $5::text[][])
              AS q(query_id, exact_values, compact_values, transliterated_values, phonetic_values)
         CROSS JOIN LATERAL (
           SELECT entity_id, surface_form, normalized_value, confidence
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
        [
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
           q.query_id
         FROM unnest($1::int[], $2::text[][])
              AS q(query_id, fuzzy_grams)
         CROSS JOIN LATERAL (
           SELECT entity_id, surface_form, normalized_value, confidence
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
        const fuzzyMatch = bestFuzzySimilarity(plan.fuzzyVariants, candidateCompact);
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
    const lookupPlan = buildAliasLookupPlan(normalizedQuery);
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

    return {
      views,
      tokenList,
      compactList,
      transliteratedList,
      phoneticList,
      fuzzyVariants,
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
