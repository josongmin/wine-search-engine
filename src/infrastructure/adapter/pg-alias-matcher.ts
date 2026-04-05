import type { Pool } from 'pg';
import type { AliasMatcher, AliasMatchResult } from '../../domain/query/service/anchor-extractor.js';
import { createEntityId } from '../../domain/shared/types/index.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
}

const MIN_FUZZY_QUERY_LENGTH = 5;
const MAX_FUZZY_CANDIDATES = 200;
const COMPACT_FUZZY_DISTANCE_RATIO = 0.25;
const MIN_CHAR_NGRAM_OVERLAP = 0.45;
const MIN_BIGRAM_OVERLAP = 0.6;

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

function bestFuzzySimilarity(
  queryVariants: readonly string[],
  candidateCompact: string,
): number | null {
  let best: number | null = null;

  for (const queryCompact of queryVariants) {
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
    if (best === null || similarity > best) {
      best = similarity;
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

function groupRows(rows: readonly AliasRow[]): readonly AliasMatchResult[] {
  const byNorm = new Map<
    string,
    { surfaceForm: string; entityIds: Set<string>; confidence: number }
  >();

  for (const row of rows) {
    const existing = byNorm.get(row.normalized_value);
    if (existing == null) {
      byNorm.set(row.normalized_value, {
        surfaceForm: row.surface_form,
        entityIds: new Set([row.entity_id]),
        confidence: row.confidence,
      });
      continue;
    }

    existing.entityIds.add(row.entity_id);
    if (row.confidence > existing.confidence) {
      existing.confidence = row.confidence;
    }
  }

  const matches: AliasMatchResult[] = [];
  for (const [norm, data] of byNorm) {
    matches.push({
      surfaceForm: data.surfaceForm,
      normalizedForm: norm,
      entityIds: Array.from(data.entityIds).map(createEntityId),
      matchConfidence: data.confidence,
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
  constructor(private readonly pool: Pool) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) return [];

    const views = buildNormalizedQueryViews(trimmed);

    // Build candidate lookup tokens: full phrase + individual words + bigrams
    const words = views.punctuationStripped.split(/\s+/).filter(Boolean);
    const tokens = new Set<string>();
    const compactTokens = new Set<string>();

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

    const result = await this.pool.query<AliasRow>(
      `SELECT entity_id, surface_form, normalized_value, confidence
       FROM aliases
       WHERE (
         normalized_value = ANY($1)
         OR regexp_replace(normalized_value, '[^[:alnum:]]', '', 'g') = ANY($2)
       ) AND is_suppressed = FALSE
       ORDER BY confidence DESC`,
      [tokenList, compactList],
    );

    if (result.rows.length > 0) {
      return groupRows(result.rows);
    }

    const fuzzyVariants = Array.from(
      new Set(
        views.lookupVariants
          .map((value) => compactForLookup(value))
          .filter((value) => value.length >= MIN_FUZZY_QUERY_LENGTH),
      ),
    );

    if (fuzzyVariants.length === 0) {
      return [];
    }

    const fuzzyGrams = Array.from(
      new Set(fuzzyVariants.flatMap((value) => charNgrams(value))),
    );

    const fuzzyCandidates = await this.pool.query<AliasRow>(
      `SELECT entity_id, surface_form, normalized_value, confidence
       FROM aliases
       WHERE is_suppressed = FALSE
         AND EXISTS (
           SELECT 1
           FROM unnest($1::text[]) AS gram
           WHERE regexp_replace(normalized_value, '[[:space:][:punct:]]+', '', 'g')
                 LIKE '%' || gram || '%'
         )
       ORDER BY confidence DESC
       LIMIT ${MAX_FUZZY_CANDIDATES}`,
      [fuzzyGrams],
    );

    const fuzzyRows = fuzzyCandidates.rows
      .map((row) => {
        const candidateCompact = compactForLookup(row.normalized_value);
        if (candidateCompact.length === 0) {
          return null;
        }

        const similarity = bestFuzzySimilarity(fuzzyVariants, candidateCompact);
        if (similarity === null) {
          return null;
        }

        return {
          ...row,
          confidence: row.confidence * similarity,
        };
      })
      .filter((row): row is AliasRow => row !== null);

    return groupRows(fuzzyRows);
  }
}
