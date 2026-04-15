/**
 * RFC-020: Offline Constraint Extraction Evaluation Rig
 *
 * Industry pattern (Amazon Alexa NLU, Google Dialogflow, Airbnb Query
 * Understanding): evaluate NLU pipelines with a dedicated offline rig
 * independent from the production agent loop. This isolates measurement
 * noise — any drift here reflects real NL Mapper / ontology changes, not
 * benchmark orchestration variance.
 *
 * Flow:
 *   scenario.query → Planner.parseConstraints() → ConstraintBundle + Trace
 *                                ↓
 *                        scoreSemanticConstraintRecall()
 *                        scoreEntityLinkingAccuracy()
 *                        scoreSlotF1()
 *
 * The rig uses a MINIMAL planner instance (noOp NLMapper) so that the
 * symbolic path (DEFAULT_MAPPINGS) + Entity Resolver + Ontology Expansion
 * + Compositional Inference is exercised without LLM cost or Vespa
 * dependencies. This matches production retrieval behavior since LlmNLMapper
 * is disabled by default (`LLM_QUERY_INTERPRETER=false`).
 */

import { NLMapper } from '../../../src/domain/attribute/service/nl-mapper.js';
import type { ConstraintBundle } from '../../../src/domain/shared/types/index.js';
import type { ConstraintExtractionTrace } from '../../../src/domain/attribute/model/constraint-extraction-trace.js';
import type { MappingTablePort } from '../../../src/domain/attribute/port/mapping-table.port.js';
import { parseSpans, type Span } from '../../../src/domain/attribute/service/span-parser.js';
import type { ResolvedEntity } from '../../../src/domain/attribute/service/entity-resolver.js';
import { QueryNormalizer } from '../../../src/domain/query/service/query-normalizer.js';
import { correctKoreanWineTypos } from '../../../src/domain/query/service/korean-wine-aliases.js';
import { ConstraintCompiler } from '../../../src/domain/query/service/constraint-compiler.js';
import type { ConstraintGraph } from '../../../src/domain/query/model/constraint-graph.js';

/**
 * Minimal no-op mapping table adapter for the offline rig. Returns empty
 * results from the file-backed store so NLMapper falls through entirely to
 * its hand-curated DEFAULT_MAPPINGS (the symbolic backbone).
 */
const NO_OP_MAPPING_TABLE: MappingTablePort = {
  async findMapping(): Promise<null> { return null; },
  async findMappingsByAttribute(): Promise<readonly never[]> { return []; },
  async getCurrentVersion(): Promise<string> { return 'noop-v1.0'; },
};

/** Lazily constructed shared NL mapper for eval — symbolic only. */
let sharedMapper: NLMapper | null = null;
function getSharedMapper(): NLMapper {
  if (sharedMapper === null) {
    sharedMapper = new NLMapper(NO_OP_MAPPING_TABLE);
  }
  return sharedMapper;
}

let sharedNormalizer: QueryNormalizer | null = null;
function getSharedNormalizer(): QueryNormalizer {
  if (sharedNormalizer === null) {
    sharedNormalizer = new QueryNormalizer();
  }
  return sharedNormalizer;
}

/** Result of offline constraint extraction for a single query. */
export interface ExtractionResult {
  readonly bundle: ConstraintBundle;
  readonly spans: readonly Span[];
  readonly resolvedEntities: readonly ResolvedEntity[];
  readonly trace: ConstraintExtractionTrace;
  /**
   * ADR-011 PR2: trivial ConstraintGraph emitted by the compiler.
   * Absent when the `CONSTRAINT_GRAPH_EMIT` flag is off — the graph-aware
   * bench metrics stay `null` in that case (flat path authoritative).
   */
  readonly constraintGraph?: ConstraintGraph | undefined;
}

/**
 * Run the full RFC-019 pipeline (spans → NLMapper → Entity Resolver →
 * Ontology Expansion → Compositional Inference) on a query and return
 * both the constraint bundle and the measured trace.
 *
 * This is the ONLY way to get scorer-side access to the trace — production
 * trace flows through the search-usecase observability logs which are not
 * available in the scenario scoring phase.
 */
export async function runConstraintExtraction(query: string): Promise<ExtractionResult> {
  const mapper = getSharedMapper();
  const normalizer = getSharedNormalizer();
  const normalizedQuery = normalizer.normalize(correctKoreanWineTypos(query)).accentless;
  const spans = parseSpans(normalizedQuery);
  const compiler = new ConstraintCompiler(mapper);
  const compiled = await compiler.compile(normalizedQuery);

  return {
    bundle: compiled.bundle,
    spans,
    resolvedEntities: [...compiled.resolvedEntities],
    // exactOptionalPropertyTypes: only set the key when defined.
    ...(compiled.constraintGraph !== undefined
      ? { constraintGraph: compiled.constraintGraph }
      : {}),
    trace: compiled.constraintExtraction ?? {
      candidatePhraseCount: spans.length,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: compiled.bundle.hard.length === 0 && compiled.bundle.soft.length === 0,
      source: 'fallback',
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [],
    },
  };
}
