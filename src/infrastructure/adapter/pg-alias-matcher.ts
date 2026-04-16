import type { Pool } from 'pg';
import type { AliasMatcher, AliasMatchResult } from '../../domain/query/service/anchor-extractor.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

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

interface FuzzyAliasRow extends AliasRow {
  readonly lookupStrategy: FuzzyLookupStrategy;
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
  lookupStrategy: string | ((row: TRow) => string) = 'exact',
): readonly AliasMatchResult[] {
  const byNorm = new Map<
    string,
    { surfaceForm: string; entityIds: Set<string>; confidence: number; strategies: Set<string> }
  >();

  for (const row of rows) {
    const existing = byNorm.get(row.normalized_value);
    const strategyForRow =
      typeof lookupStrategy === 'function' ? lookupStrategy(row) : lookupStrategy;
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

    // T-010/W2: pre-flight the pointer resolve so a missing `active_search_snapshot`
    // table (fresh dev DB, unit-test mock pool without the pointer row) degrades
    // to the same "no aliases available" behavior as a missing aliases table.
    // A present-but-empty pointer table is still a hard error (publish never ran).
    const canUseSnapshotBackedLookup = await this.canUseSnapshotBackedLookup();
    if (!canUseSnapshotBackedLookup) {
      return [];
    }

    const views = buildNormalizedQueryViews(trimmed);

    // Build candidate lookup tokens: full phrase + individual words + bigrams
    const words = views.punctuationStripped.split(/\s+/).filter(Boolean);
    const tokens = new Set<string>();
    const compactTokens = new Set<string>();
    const transliteratedTokens = new Set<string>();
    const phoneticTokens = new Set<string>();

    for (const value of views.lookupVariants) {
      if (value.length > 0) {
        tokens.add(value);
        if (value !== views.compact) {
          compactTokens.add(value.replace(/[^\p{L}\p{N}]+/gu, ''));
        }
      }
    }
    if (views.compact.length > 0) {
      compactTokens.add(views.compact);
    }
    if (views.transliterated !== undefined && views.transliterated.length > 0) {
      transliteratedTokens.add(views.transliterated);
      transliteratedTokens.add(compactForLookup(views.transliterated));
    }
    if (views.phoneticCompact !== undefined && views.phoneticCompact.length > 0) {
      phoneticTokens.add(views.phoneticCompact);
    }
    for (const w of words) {
      if (w.length >= 2) {
        tokens.add(w);
        compactTokens.add(w.replace(/\s+/g, ''));
      }
    }
    for (let i = 0; i < words.length - 1; i++) {
      const w0 = words[i];
      const w1 = words[i + 1];
      if (w0 !== undefined && w1 !== undefined) {
        const bigram = `${w0} ${w1}`;
        tokens.add(bigram);
        compactTokens.add(bigram.replace(/\s+/g, ''));
      }
    }

    const tokenList = Array.from(tokens);
    const compactList = Array.from(compactTokens).filter((token) => token.length > 0);
    const transliteratedList = Array.from(transliteratedTokens).filter((token) => token.length > 0);
    const phoneticList = Array.from(phoneticTokens).filter((token) => token.length > 0);

    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
    const result = await this.queryAliases(
      `SELECT entity_id, surface_form, normalized_value, confidence
       FROM aliases
       WHERE search_snapshot_id = $5
         AND (
           normalized_value = ANY($1)
           OR regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g') = ANY($2)
           OR lower(regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g')) = ANY($3)
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
              ) = ANY($4)
         ) AND is_suppressed = FALSE
       ORDER BY confidence DESC`,
      [tokenList, compactList, transliteratedList, phoneticList, activeSnapshotId],
    );

    if (result.rows.length > 0) {
      const transliteratedSet = new Set(transliteratedList);
      const phoneticSet = new Set(phoneticList);
      const exactSet = new Set(tokenList);
      const compactSet = new Set(compactList);
      return groupRows(result.rows, (row) => {
        const normalizedValue = row.normalized_value.toLowerCase();
        const compactValue = compactForLookup(normalizedValue);
        const phoneticValue = phoneticCompactForLookup(normalizedValue);
        if (
          transliteratedSet.has(normalizedValue) ||
          transliteratedSet.has(compactValue)
        ) {
          return 'transliterated_exact';
        }
        if (compactSet.has(compactValue)) {
          return 'compact_exact';
        }
        if (exactSet.has(normalizedValue)) {
          return 'exact';
        }
        if (phoneticSet.has(phoneticValue)) {
          return 'phonetic_exact';
        }
        return 'lexical_exact';
      });
    }

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

    if (fuzzyVariants.length === 0) {
      return [];
    }

    const fuzzyGrams = Array.from(
      new Set(fuzzyVariants.flatMap((variant) => charNgrams(variant.value))),
    ).map((gram) => gram.replace(/[%_\\]/g, '\\$&'));

    // activeSnapshotId already resolved above; reuse within same method scope.
    const fuzzyCandidates = await this.queryAliases(
      `SELECT entity_id, surface_form, normalized_value, confidence
       FROM aliases
       WHERE search_snapshot_id = $3
         AND is_suppressed = FALSE
         AND EXISTS (
           SELECT 1
           FROM unnest($1::text[]) AS gram
           WHERE regexp_replace(normalized_value, '[[:space:][:punct:]]+', '', 'g')
                 LIKE '%' || gram || '%'
         )
       ORDER BY confidence DESC
       LIMIT $2`,
      [fuzzyGrams, MAX_FUZZY_CANDIDATES, activeSnapshotId],
    );

    const fuzzyRows: FuzzyAliasRow[] = fuzzyCandidates.rows
      .map((row) => {
        const candidateCompact = compactForLookup(row.normalized_value);
        if (candidateCompact.length === 0) {
          return null;
        }

        const fuzzyMatch = bestFuzzySimilarity(fuzzyVariants, candidateCompact);
        if (fuzzyMatch === null) {
          return null;
        }

        return {
          ...row,
          confidence: row.confidence * fuzzyMatch.similarity,
          lookupStrategy: fuzzyMatch.strategy,
        };
      })
      .filter((row): row is FuzzyAliasRow => row !== null);

    return groupRows<FuzzyAliasRow>(fuzzyRows, (row) => row.lookupStrategy);
  }

  private async queryAliases(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: AliasRow[] }> {
    try {
      return await this.pool.query<AliasRow>(sql, [...params]);
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        throw err;
      }
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw err;
      }
      bootstrapLogger.info(
        '[PgAliasMatcher] aliases table does not exist yet — alias matching disabled for this request',
      );
      return { rows: [] };
    }
  }

  private async canUseSnapshotBackedLookup(): Promise<boolean> {
    const now = Date.now();
    if (this.activeSnapshotMissingTableUntil > now) {
      return false;
    }

    try {
      await resolveActiveSnapshot(this.pool);
      this.activeSnapshotMissingTableUntil = 0;
      this.activeSnapshotMissingTableLogged = false;
      return true;
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
      return false;
    }
  }
}
