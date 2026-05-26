/**
 * Loads evaluation cases from golden queries into the eval_cases table.
 *
 * Epic 3: Eval Metrics Baseline
 * Maps golden queries → EvalCase with auto-labels and slice tags
 *
 * RFC-009: Complete evaluation framework integration
 */

import * as fs from 'fs/promises';
import * as readline from 'readline';
import { Pool } from 'pg';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  requireFixtureCorpusPath,
} from '../eval/fixture-corpus-paths.js';
import { isSourceRecordStylePublicEntityId } from '../../src/domain/shared/constants/public-entity-id-namespace.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import {
  hasLegacyEvalExpectedEntityId,
  resolveLegacyEvalExpectedEntityIds,
  type LegacyEvalExpectedEntityIdRef,
} from '../../src/infrastructure/adapter/eval-expected-entity-id-resolution.js';

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
  leakage_keys?: Record<string, unknown>;
  annotation_tier: string;
  annotated_by: string[];
  release_gate_eligible: boolean;
  created_at: string;
  retrieval_mode?: string;
}

type LabelTier = 'gold' | 'silver' | 'bronze';

interface CliArgs {
  readonly inputPath: string;
  readonly connectionString: string;
  readonly snapshotId?: string;
  readonly runtimeStatePath: string;
}

/**
 * Maps annotation_tier to label tier, per RFC-009 §4.
 *
 * - 'bronze' → bronze tier (single auto-label)
 * - 'silver' → silver tier (2+ sources)
 * - 'gold' → gold tier (3+ high-agreement)
 */
function mapAnnotationTierToLabelTier(annotationTier: string, annotatedBy: string[]): LabelTier {
  if (annotationTier === 'gold' || (annotatedBy.length >= 3 && annotationTier !== 'bronze')) {
    return 'gold';
  }
  if (annotatedBy.length >= 2) {
    return 'silver';
  }
  return 'bronze';
}

/**
 * Creates slice tags for this case, per RFC-009 §5.
 *
 * Slices enable per-segment analysis:
 * - query_class: exact_entity, ambiguous_short_form, etc.
 * - retrieval_mode: entity_lookup, recommendation, etc.
 * - scenario: A, B, C (train/val/test splits)
 * - language: en, ko, etc.
 */
function createSliceTags(gq: GoldenQuery): readonly string[] {
  const tags: string[] = [];

  // Query class slice
  tags.push(`class:${gq.query_class}`);

  // Retrieval mode slice
  if (gq.retrieval_mode) {
    tags.push(`mode:${gq.retrieval_mode}`);
  }

  // Scenario slice (train/val/test)
  tags.push(`scenario:${gq.scenario}`);

  // Language slice
  if (gq.language !== 'en') {
    tags.push(`lang:${gq.language}`);
  }

  // Ambiguity slice
  if (gq.decision_labels.ambiguity_expected) {
    tags.push('ambiguous');
  }

  return tags;
}

/**
 * Converts a golden query to an EvalCase.
 */
function goldenQueryToEvalCase(gq: GoldenQuery): {
  case_id: string;
  query: string;
  query_class: string;
  expected_entity_id: string | null;
  expected_status: string;
  label_tier: LabelTier;
  annotator_agreement: number | null;
  slice_tags: string[];
  created_at: Date;
} {
  const labelTier = mapAnnotationTierToLabelTier(gq.annotation_tier, gq.annotated_by);

  // For bronze-tier auto-labels, assume 0.7 agreement (auto-labeled)
  // For silver-tier (2+ sources), assume 0.75
  // For gold-tier (3+ sources), assume 0.85
  const agreementByTier: Record<LabelTier, number> = {
    bronze: 0.70,
    silver: 0.75,
    gold: 0.85,
  };

  return {
    case_id: gq.qid,
    query: gq.query,
    query_class: gq.query_class,
    expected_entity_id: gq.decision_labels.expected_entity_id || null,
    expected_status: gq.decision_labels.expected_decision_status,
    label_tier: labelTier,
    annotator_agreement: agreementByTier[labelTier],
    slice_tags: [...createSliceTags(gq)],
    created_at: new Date(gq.created_at),
  };
}

/**
 * Loads evaluation cases from golden queries JSONL file into PostgreSQL.
 */
async function loadEvalCases(
  inputPath: string,
  connectionString: string,
  options: {
    readonly snapshotId?: string;
    readonly runtimeStatePath: string;
  },
): Promise<void> {
  const pool = new Pool({ connectionString });

  try {
    // Ensure eval_cases table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS eval_cases (
        case_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        query_class TEXT NOT NULL,
        expected_entity_id TEXT,
        expected_status TEXT NOT NULL,
        label_tier TEXT NOT NULL,
        annotator_agreement DECIMAL(3, 2),
        slice_tags TEXT[] NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL
      )
    `);

    // Stream-process golden queries
    const input = await fs.open(inputPath, 'r');
    const rl = readline.createInterface({
      input: input.createReadStream(),
      crlfDelay: Infinity,
    });

    let lineNum = 0;
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];
    const parsedCases: Array<ReturnType<typeof goldenQueryToEvalCase>> = [];
    const legacyRefs: LegacyEvalExpectedEntityIdRef[] = [];

    for await (const line of rl) {
      lineNum++;

      if (!line.trim()) {
        continue;
      }

      try {
        const gq: GoldenQuery = JSON.parse(line);
        const evalCase = goldenQueryToEvalCase(gq);
        parsedCases.push(evalCase);
        if (evalCase.expected_entity_id != null && isSourceRecordStylePublicEntityId(evalCase.expected_entity_id)) {
          legacyRefs.push({
            caseId: evalCase.case_id,
            expectedEntityId: evalCase.expected_entity_id,
          });
        }
      } catch (error) {
        errorCount++;
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Line ${lineNum}: ${msg}`);
      }
    }

    await input.close();

    const effectiveSnapshotId = hasLegacyEvalExpectedEntityId(legacyRefs)
      ? (
        options.snapshotId
        ?? (await loadSearchSnapshotRuntimeState(options.runtimeStatePath)).snapshotId
      )
      : undefined;
    const resolvedLegacyIds = effectiveSnapshotId == null
      ? new Map<string, string>()
      : await resolveLegacyEvalExpectedEntityIds(pool, effectiveSnapshotId, legacyRefs);

    for (const evalCase of parsedCases) {
      const expectedEntityId = evalCase.expected_entity_id == null
        ? null
        : isSourceRecordStylePublicEntityId(evalCase.expected_entity_id)
          ? (resolvedLegacyIds.get(evalCase.expected_entity_id) ?? null)
          : evalCase.expected_entity_id;

      await pool.query(
        `INSERT INTO eval_cases (
          case_id, query, query_class, expected_entity_id, expected_status,
          label_tier, annotator_agreement, slice_tags, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (case_id) DO NOTHING`,
        [
          evalCase.case_id,
          evalCase.query,
          evalCase.query_class,
          expectedEntityId,
          evalCase.expected_status,
          evalCase.label_tier,
          evalCase.annotator_agreement,
          evalCase.slice_tags,
          evalCase.created_at,
        ],
      );
      successCount++;
    }

    // Summary
    console.log(`✓ Loaded ${successCount} eval cases into eval_cases table`);
    console.log(`  Label tier distribution:`);

    const tierCounts = await pool.query<{ label_tier: string; count: string }>(
      `SELECT label_tier, COUNT(*) as count FROM eval_cases GROUP BY label_tier ORDER BY label_tier`,
    );
    for (const row of tierCounts.rows) {
      console.log(`    ${row.label_tier}: ${row.count}`);
    }

    const sliceExample = await pool.query<{ slice_tags: string[] }>(
      `SELECT DISTINCT slice_tags FROM eval_cases LIMIT 3`,
    );
    console.log(`  Example slice tags:`);
    for (const row of sliceExample.rows) {
      console.log(`    ${row.slice_tags.join(', ')}`);
    }

    if (errorCount > 0) {
      console.log(`⚠️ ${errorCount} errors encountered:`);
      errors.slice(0, 5).forEach((e) => console.log(`   ${e}`));
      if (errors.length > 5) {
        console.log(`   ... and ${errors.length - 5} more`);
      }
    }
  } finally {
    await pool.end();
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  let inputPath = requireFixtureCorpusPath(
    OFFLINE_EVAL_SILVER_CORPUS,
    'load-eval-cases default input resolution',
  );
  let connectionString = process.env.DATABASE_URL || 'postgresql://localhost/wine-search';
  let snapshotId: string | undefined;
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      inputPath = argv[index + 1] ?? inputPath;
      index += 1;
    } else if (arg === '--connection-string') {
      connectionString = argv[index + 1] ?? connectionString;
      index += 1;
    } else if (arg === '--snapshot-id') {
      snapshotId = argv[index + 1] ?? snapshotId;
      index += 1;
    } else if (arg === '--runtime-state-path') {
      runtimeStatePath = argv[index + 1] ?? runtimeStatePath;
      index += 1;
    }
  }

  return {
    inputPath,
    connectionString,
    snapshotId,
    runtimeStatePath,
  };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Loading eval cases from: ${args.inputPath}`);
  console.log(`Database: ${args.connectionString.replace(/:.+@/, ':***@')}`);
  if (args.snapshotId != null) {
    console.log(`Snapshot: ${args.snapshotId}`);
  }

  await loadEvalCases(args.inputPath, args.connectionString, {
    snapshotId: args.snapshotId,
    runtimeStatePath: args.runtimeStatePath,
  });
  console.log('✓ Eval baseline loaded');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
