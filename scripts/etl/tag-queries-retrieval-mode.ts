import * as fs from 'fs/promises';
import * as readline from 'readline';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  requireFixtureCorpusPath,
} from '../eval/fixture-corpus-paths.js';

/**
 * Tags golden query set with retrieval_mode field.
 * Maps query_class + query content → RetrievalMode
 *
 * RFC: v0.1 Epic 7, complete requirements
 */

type RetrievalMode =
  | 'entity_lookup'
  | 'entity_resolution'
  | 'attribute_search'
  | 'constraint_filter'
  | 'producer_browse'
  | 'region_browse'
  | 'compare_candidates'
  | 'recommendation'
  | 'similar_items'
  | 'no_match_detection';

interface GoldenQuery {
  qid: string;
  query: string;
  query_class: string;
  scenario: string;
  language: string;
  retrieval_labels: {
    relevant: Array<{
      entity_id: string;
      grade: number;
    }>;
  };
  decision_labels: {
    expected_decision_status: string;
    expected_entity_id: string;
    ambiguity_expected: boolean;
    requires_abstain: boolean;
  };
  leakage_keys: Record<string, unknown>;
  annotation_tier: string;
  annotated_by: string[];
  release_gate_eligible: boolean;
  created_at: string;
  retrieval_mode?: RetrievalMode;
}

/**
 * Determines retrieval mode from query class and query surface.
 */
function determineRetrievalMode(
  queryClass: string,
  query: string,
  ambiguityExpected: boolean,
): RetrievalMode {
  const q = query.toLowerCase();

  // Comparison queries
  if (queryClass === 'comparison_query' || /\bvs\b|\bversus\b|\bcompare/.test(q)) {
    return 'compare_candidates';
  }

  // Ambiguous short form → need disambiguation
  if (queryClass === 'ambiguous_short_form' || ambiguityExpected) {
    return 'entity_resolution';
  }

  // Anchored similarity / mixed queries
  if (
    queryClass === 'anchored_similarity' ||
    /\blike\b|\bsimilar|wines like|wine like/.test(q)
  ) {
    return 'similar_items';
  }

  // Producer browse: producer name only, or producer-specific patterns
  if (
    /^[a-z\s&'-]+$/.test(q) &&
    (q.includes(' & ') || /domaine|winery|vineyard/.test(q))
  ) {
    return 'producer_browse';
  }

  // Region browse: region/appellation keywords
  if (/\b(?:region|appellation|bordeaux|burgundy|napa|tuscany|rioja)\b/.test(q)) {
    return 'region_browse';
  }

  // Pairing/recommendation queries
  if (
    queryClass === 'semantic_preference' ||
    /\b(?:pair|food|occasion|dinner|lunch|celebr|aperit)\b/.test(q)
  ) {
    return 'recommendation';
  }

  // Pure constraint filtering (no entity, just attributes)
  if (
    queryClass === 'pure_constraint' ||
    /^(?:red|white|rose|sparkling|dry|sweet|under|cheap|budget)/.test(q)
  ) {
    return 'constraint_filter';
  }

  // Generic entity lookup (default for exact_entity, short_entity)
  if (
    queryClass === 'exact_entity' ||
    queryClass === 'short_entity' ||
    queryClass === 'unknown'
  ) {
    return 'entity_lookup';
  }

  // Fallback: attribute search (hybrid)
  return 'attribute_search';
}

/**
 * Stream-processes JSONL file, adding retrieval_mode to each record.
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
      const query: GoldenQuery = JSON.parse(line);

      // Determine and add retrieval_mode
      const mode = determineRetrievalMode(
        query.query_class,
        query.query,
        query.decision_labels.ambiguity_expected,
      );

      query.retrieval_mode = mode;

      await output.write(`${JSON.stringify(query)}\n`);
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

main().catch(console.error);
