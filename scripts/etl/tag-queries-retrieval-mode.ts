import * as fs from 'fs/promises';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  requireFixtureCorpusPath,
} from '../eval/fixture-corpus-paths.js';

/**
 * Tags golden query set with retrieval_mode field.
 * Maps query_class + query content → RetrievalMode.
 *
 * Pure classifier (`determineRetrievalMode`) + record-level helpers
 * (`tagQueryRecord`, `tagQueryRecords`) are exported for unit testing under
 * `test/regression/tag-queries-retrieval-mode.regression.test.ts`. The CLI
 * entry (streaming JSONL transform) is gated behind the entrypoint check at
 * the bottom of the file so importing this module never executes I/O.
 *
 * RFC: v0.1 Epic 7, complete requirements.
 */

// ---------------------------------------------------------------------------
// Named constants — exported SSoT for the retrieval-mode tagging contract.
// Rule 15 (no magic strings/numbers): every enum value and behavioral knob
// lives here.
// ---------------------------------------------------------------------------

/** Canonical enumeration of retrieval modes emitted by this tagger. */
export const RETRIEVAL_MODES = [
  'entity_lookup',
  'entity_resolution',
  'attribute_search',
  'constraint_filter',
  'producer_browse',
  'region_browse',
  'compare_candidates',
  'recommendation',
  'similar_items',
  'no_match_detection',
] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * Schema version written onto every tagged record. Downstream consumers
 * branch on this version when the tagging contract changes.
 */
export const TAG_QUERIES_SCHEMA_VERSION = '1';

// Query-class tokens recognized by the classifier (kept as named constants so
// callers can grep for "which query_class strings does the tagger understand?").
const QUERY_CLASS_COMPARISON = 'comparison_query';
const QUERY_CLASS_AMBIGUOUS_SHORT_FORM = 'ambiguous_short_form';
const QUERY_CLASS_ANCHORED_SIMILARITY = 'anchored_similarity';
const QUERY_CLASS_SEMANTIC_PREFERENCE = 'semantic_preference';
const QUERY_CLASS_PURE_CONSTRAINT = 'pure_constraint';
const QUERY_CLASS_EXACT_ENTITY = 'exact_entity';
const QUERY_CLASS_SHORT_ENTITY = 'short_entity';
const QUERY_CLASS_UNKNOWN = 'unknown';

// Lexical hints (lowercased). Patterns intentionally avoid `\b` for safety on
// non-ASCII inputs (CLAUDE.md test discipline rule 8): we anchor on ASCII-only
// terms here, and the upstream `query_class` carries Korean-aware signals.
const COMPARISON_RE = /(?:^|\s)vs(?:\s|$)|versus|compare/;
const SIMILARITY_RE = /(?:^|\s)like(?:\s|$)|similar|wines like|wine like/;
const PRODUCER_NAME_RE = /^[a-z\s&'-]+$/;
const PRODUCER_HINT_RE = /domaine|winery|vineyard/;
const REGION_RE = /(?:^|\s)(?:region|appellation|bordeaux|burgundy|napa|tuscany|rioja)(?:\s|$)/;
const RECOMMENDATION_RE = /(?:^|\s)(?:pair|food|occasion|dinner|lunch|celebr|aperit)/;
const CONSTRAINT_PREFIX_RE = /^(?:red|white|rose|sparkling|dry|sweet|under|cheap|budget)/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GoldenQueryDecisionLabels {
  expected_decision_status: string;
  expected_entity_id: string;
  ambiguity_expected: boolean;
  requires_abstain: boolean;
}

export interface GoldenQuery {
  qid: string;
  query: string;
  query_class: string;
  scenario?: string;
  language?: string;
  retrieval_labels?: {
    relevant: Array<{ entity_id: string; grade: number }>;
  };
  decision_labels?: GoldenQueryDecisionLabels;
  leakage_keys?: Record<string, unknown>;
  annotation_tier?: string;
  annotated_by?: string[];
  release_gate_eligible?: boolean;
  created_at?: string;
  retrieval_mode?: RetrievalMode;
  schema_version?: string;
}

export interface TaggedGoldenQuery extends GoldenQuery {
  retrieval_mode: RetrievalMode;
  schema_version: string;
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

/**
 * Determines retrieval mode from query class and query surface.
 *
 * Pure function — no I/O, no clock, no RNG. Same input → same output (the
 * regression suite asserts this 5x).
 */
export function determineRetrievalMode(
  queryClass: string,
  query: string,
  ambiguityExpected: boolean,
): RetrievalMode {
  const q = (query ?? '').toLowerCase();

  // Comparison queries
  if (queryClass === QUERY_CLASS_COMPARISON || COMPARISON_RE.test(q)) {
    return 'compare_candidates';
  }

  // Ambiguous short form → need disambiguation
  if (queryClass === QUERY_CLASS_AMBIGUOUS_SHORT_FORM || ambiguityExpected) {
    return 'entity_resolution';
  }

  // Anchored similarity / "wines like X"
  if (queryClass === QUERY_CLASS_ANCHORED_SIMILARITY || SIMILARITY_RE.test(q)) {
    return 'similar_items';
  }

  // Producer browse: producer name only, or producer-specific patterns
  if (
    PRODUCER_NAME_RE.test(q) &&
    (q.includes(' & ') || PRODUCER_HINT_RE.test(q))
  ) {
    return 'producer_browse';
  }

  // Region browse: region/appellation keywords
  if (REGION_RE.test(q)) {
    return 'region_browse';
  }

  // Pairing/recommendation queries
  if (queryClass === QUERY_CLASS_SEMANTIC_PREFERENCE || RECOMMENDATION_RE.test(q)) {
    return 'recommendation';
  }

  // Pure constraint filtering (no entity, just attributes)
  if (queryClass === QUERY_CLASS_PURE_CONSTRAINT || CONSTRAINT_PREFIX_RE.test(q)) {
    return 'constraint_filter';
  }

  // Generic entity lookup (default for exact_entity, short_entity)
  if (
    queryClass === QUERY_CLASS_EXACT_ENTITY ||
    queryClass === QUERY_CLASS_SHORT_ENTITY ||
    queryClass === QUERY_CLASS_UNKNOWN
  ) {
    return 'entity_lookup';
  }

  // Fallback: attribute search (hybrid)
  return 'attribute_search';
}

// ---------------------------------------------------------------------------
// Record-level helpers
// ---------------------------------------------------------------------------

/**
 * Returns a NEW record with `retrieval_mode` and `schema_version` set.
 * Robust against missing `decision_labels` (treated as `ambiguity_expected:false`).
 */
export function tagQueryRecord(record: GoldenQuery): TaggedGoldenQuery {
  const ambiguity = record.decision_labels?.ambiguity_expected ?? false;
  const mode = determineRetrievalMode(record.query_class ?? '', record.query ?? '', ambiguity);
  return {
    ...record,
    retrieval_mode: mode,
    schema_version: TAG_QUERIES_SCHEMA_VERSION,
  };
}

/**
 * Batch wrapper — N records in, N records out, order preserved by input order.
 */
export function tagQueryRecords(records: readonly GoldenQuery[]): TaggedGoldenQuery[] {
  return records.map(tagQueryRecord);
}

// ---------------------------------------------------------------------------
// CLI: streaming JSONL transform
// ---------------------------------------------------------------------------

/**
 * Stream-processes JSONL file, adding retrieval_mode + schema_version to each
 * record. Malformed lines are logged and skipped — no throw.
 */
async function tagQueriesWithRetrievalMode(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = await fs.open(inputPath, 'r');
  const output = await fs.open(outputPath, 'w');

  const rl = readline.createInterface({
    input: input.createReadStream(),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  let successCount = 0;
  let errorCount = 0;

  for await (const line of rl) {
    lineNum++;

    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('record is not an object');
      }
      const tagged = tagQueryRecord(parsed as GoldenQuery);
      await output.write(`${JSON.stringify(tagged)}\n`);
      successCount++;
    } catch (error) {
      console.error(`Error processing line ${lineNum}:`, error);
      errorCount++;
    }
  }

  await input.close();
  await output.close();

  console.log(`✓ Tagged ${successCount} queries (${errorCount} errors)`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2]
    ?? requireFixtureCorpusPath(
      OFFLINE_EVAL_SILVER_CORPUS,
      'tag-queries-retrieval-mode default input resolution',
    );
  const outputPath = process.argv[3]
    ?? resolveDataPath('data/golden-queries-silver-tagged.jsonl');

  console.log(`Tagging queries: ${inputPath} → ${outputPath}`);
  await tagQueriesWithRetrievalMode(inputPath, outputPath);
  console.log(`✓ Wrote derived tagged artifact to ${outputPath}`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
