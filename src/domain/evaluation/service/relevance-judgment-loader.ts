/**
 * NDJSON loader + query-scoped filter for RelevanceJudgment records.
 *
 * Silver/gold labels are produced by {@link ./llm-relevance-labeler.ts} and
 * persisted as NDJSON — one JSON object per line — under `data/relevance/`.
 *
 * Validation is deliberately permissive (not `.strict()`): silver pipelines
 * may append pipeline metadata fields (e.g. `samples`, `agreement`) that are
 * not part of the core judgment contract but must not fail the loader.
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import {
  RELEVANCE_THRESHOLD_GRADE,
  type RelevanceGrade,
  type RelevanceJudgment,
} from '../model/relevance-judgment.js';

// ── Zod schema ──────────────────────────────────────────────────────────────
//
// NOT .strict() — silver labels may have extra fields (sample count,
// agreement score, tool metadata) attached by the labeling pipeline.

const JudgmentSourceSchema = z.union([
  z.literal('llm_silver'),
  z.literal('human_gold'),
  z.literal('human_audit'),
]);

const RelevanceGradeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const RelevanceJudgmentSchema = z.object({
  queryId: z.string().min(1),
  query: z.string().min(1),
  entityId: z.string().min(1),
  canonicalLabel: z.string(),
  grade: RelevanceGradeSchema,
  confidence: z.number().finite().min(0).max(1),
  source: JudgmentSourceSchema,
  labelerModel: z.string().optional(),
  rationale: z.string().optional(),
  auditedBy: z.string().optional(),
  auditedAt: z.number().int().optional(),
});

/**
 * Load NDJSON judgments from a file. Returns `[]` if the file does not exist
 * rather than throwing — callers often probe for optional gold/audit files.
 * Malformed lines are skipped with a warning log (append-only corpus, one bad
 * line should not nuke the whole dataset).
 */
export async function loadRelevanceJudgments(
  filePath: string,
): Promise<readonly RelevanceJudgment[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const lines = raw.split('\n');
  const out: RelevanceJudgment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bootstrapLogger.warn(
        { file: filePath, lineNumber: i + 1, error: msg },
        'relevance-judgment-loader: skipping malformed JSON line',
      );
      continue;
    }

    const result = RelevanceJudgmentSchema.safeParse(parsedJson);
    if (!result.success) {
      bootstrapLogger.warn(
        { file: filePath, lineNumber: i + 1, issues: result.error.issues },
        'relevance-judgment-loader: skipping line that failed schema validation',
      );
      continue;
    }

    // Build with exactOptionalPropertyTypes: only include optional keys when present.
    const d = result.data;
    const judgment: RelevanceJudgment = {
      queryId: d.queryId,
      query: d.query,
      entityId: d.entityId,
      canonicalLabel: d.canonicalLabel,
      grade: d.grade,
      confidence: d.confidence,
      source: d.source,
      ...(d.labelerModel !== undefined ? { labelerModel: d.labelerModel } : {}),
      ...(d.rationale !== undefined ? { rationale: d.rationale } : {}),
      ...(d.auditedBy !== undefined ? { auditedBy: d.auditedBy } : {}),
      ...(d.auditedAt !== undefined ? { auditedAt: d.auditedAt } : {}),
    };
    out.push(judgment);
  }

  return out;
}

/**
 * Return the set of `entityId`s considered relevant for the given query,
 * using `threshold` (default {@link RELEVANCE_THRESHOLD_GRADE} = 2).
 *
 * An empty set is returned for unknown query IDs — callers can treat this
 * as "no labels available, skip this query in metric computation".
 */
export function filterRelevantIds(
  judgments: readonly RelevanceJudgment[],
  queryId: string,
  threshold: RelevanceGrade = RELEVANCE_THRESHOLD_GRADE,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const j of judgments) {
    if (j.queryId !== queryId) continue;
    if (j.grade >= threshold) out.add(j.entityId);
  }
  return out;
}
