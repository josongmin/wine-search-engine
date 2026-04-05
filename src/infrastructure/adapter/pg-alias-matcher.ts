import type { Pool } from 'pg';
import type { AliasMatcher, AliasMatchResult } from '../../domain/query/service/anchor-extractor.js';
import { createEntityId } from '../../domain/shared/types/index.js';

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
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

    // Build candidate lookup tokens: full phrase + individual words + bigrams
    const words = trimmed.split(/\s+/);
    const tokens = new Set<string>();

    tokens.add(trimmed);
    for (const w of words) {
      if (w.length >= 2) tokens.add(w);
    }
    for (let i = 0; i < words.length - 1; i++) {
      const w0 = words[i];
      const w1 = words[i + 1];
      if (w0 !== undefined && w1 !== undefined) {
        tokens.add(`${w0} ${w1}`);
      }
    }

    const tokenList = Array.from(tokens);

    const result = await this.pool.query<AliasRow>(
      `SELECT entity_id, surface_form, normalized_value, confidence
       FROM aliases
       WHERE normalized_value = ANY($1) AND is_suppressed = FALSE
       ORDER BY confidence DESC`,
      [tokenList],
    );

    // Group by normalized_value — merge entity IDs and track max confidence
    const byNorm = new Map<
      string,
      { surfaceForm: string; entityIds: Set<string>; confidence: number }
    >();

    for (const row of result.rows) {
      const key = row.normalized_value;
      const existing = byNorm.get(key);
      if (existing == null) {
        byNorm.set(key, {
          surfaceForm: row.surface_form,
          entityIds: new Set([row.entity_id]),
          confidence: row.confidence,
        });
      } else {
        existing.entityIds.add(row.entity_id);
        if (row.confidence > existing.confidence) {
          existing.confidence = row.confidence;
        }
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
}
