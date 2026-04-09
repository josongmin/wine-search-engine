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
import type { ConstraintBundle, NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
import type { ConstraintExtractionTrace } from '../../../src/domain/attribute/model/constraint-extraction-trace.js';
import type { MappingTablePort } from '../../../src/domain/attribute/port/mapping-table.port.js';
import { parseSpans, resolveOverlaps, type Span } from '../../../src/domain/attribute/service/span-parser.js';
import { resolveEntity, type ResolvedEntity } from '../../../src/domain/attribute/service/entity-resolver.js';
import { expandWithOntology } from '../../../src/domain/attribute/service/ontology-expansion.js';
import { applyCompositionalInference } from '../../../src/domain/attribute/service/compositional-inference.js';
import { extractRuleBasedConstraints } from '../../../src/domain/query/service/rule-based-constraint-extractor.js';

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

/** Result of offline constraint extraction for a single query. */
export interface ExtractionResult {
  readonly bundle: ConstraintBundle;
  readonly spans: readonly Span[];
  readonly resolvedEntities: readonly ResolvedEntity[];
  readonly trace: ConstraintExtractionTrace;
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

  // Stage 1: Span parsing (RFC-019 Phase 1/4)
  const spans = parseSpans(query);
  const candidatePhrases = spans.map((s) => s.text);

  // Stage 2a: NLMapper symbolic lookup
  const mapped = await mapper.mapConstraints(candidatePhrases);
  const matched = mapped.constraints;
  const mapperTrace = mapped.constraintExtraction;

  const hard: NormalizedConstraint[] = [];
  const soft: NormalizedConstraint[] = [];
  const SOFT_ATTRIBUTES: ReadonlySet<string> = new Set([
    'body', 'sweetness', 'acidity', 'tannin', 'style', 'price_band', 'occasion',
  ]);

  for (const c of matched) {
    if (SOFT_ATTRIBUTES.has(c.attribute)) soft.push(c);
    else hard.push(c);
  }

  // Stage 2b: Entity Resolver for uncovered spans (RFC-019 Phase 2)
  const coveredPhrases = new Set(matched.map((c) => c.source_phrase.toLowerCase()));
  const resolverCandidates: { span: Span; resolved: ResolvedEntity | null }[] = [];
  for (const span of spans) {
    if (coveredPhrases.has(span.text)) {
      resolverCandidates.push({ span, resolved: null });
    } else {
      resolverCandidates.push({ span, resolved: resolveEntity(span.text) });
    }
  }
  const resolvedNonOverlap = resolveOverlaps(resolverCandidates)
    .filter((e): e is { span: Span; resolved: ResolvedEntity } => e.resolved !== null);

  const resolvedEntities: ResolvedEntity[] = [];
  for (const { resolved } of resolvedNonOverlap) {
    resolvedEntities.push(resolved);
    const constraint: NormalizedConstraint = {
      attribute: resolved.entityType,
      operator: '=',
      value: resolved.canonicalValue,
      source_phrase: `entity_resolver(${resolved.matchedSurface})`,
      confidence: resolved.confidence,
      mapping_version: 'entity-resolver-v1.0',
    };
    if (SOFT_ATTRIBUTES.has(resolved.entityType)) soft.push(constraint);
    else hard.push(constraint);
  }

  // Stage 3+5: Ontology + Compositional
  let baseBundle: ConstraintBundle;
  let expanded: ConstraintBundle;
  let finalBundle: ConstraintBundle;

  if (hard.length === 0 && soft.length === 0) {
    // Tier 6 sole-extraction: Tier 1+2 produced 0 constraints, so Tier 6
    // regex extractor is the sole contributor (NOT a "fallback" — it's
    // the last tier of the deterministic cascade pipeline).
    const regexExtracted = extractRuleBasedConstraints(query);
    expanded = expandWithOntology(regexExtracted);
    finalBundle = applyCompositionalInference(expanded);
    baseBundle = regexExtracted;
  } else {
    baseBundle = { hard, soft, inferred: [] };
    expanded = expandWithOntology(baseBundle);
    finalBundle = applyCompositionalInference(expanded);
  }

  // Build trace (matches planner.ts buildPlannerConstraintExtractionTrace)
  const trace: ConstraintExtractionTrace = {
    candidatePhraseCount: candidatePhrases.length,
    candidateSpanCount: spans.length,
    ruleTableHitCount: mapperTrace?.ruleTableHitCount ?? 0,
    llmHitCount: 0,
    llmSkippedCount: 0,
    source: mapperTrace?.source ?? 'fallback',
    llmLatencyMs: null,
    phraseCacheHits: 0,
    phraseCacheNegativeSkipped: 0,
    phraseCacheMisses: 0,
    resolvedEntityCount: resolvedEntities.length,
    directHardConstraintCount: hard.length,
    ontologyExpandedConstraintCount: countBundle(expanded) - countBundle(baseBundle),
    compositionalInferenceCount: countBundle(finalBundle) - countBundle(expanded),
    phrasesByTier: {
      tier1_default_mapping: mapperTrace?.ruleTableHitCount ?? 0,
      tier2_entity_resolver: resolvedEntities.length,
      tier3_ontology_expansion: countBundle(expanded) - countBundle(baseBundle),
      tier4_compositional_inference: countBundle(finalBundle) - countBundle(expanded),
      tier5_llm_linker: 0,
      tier6_regex_fallback: hard.length === 0 && soft.length === 0 ? countBundle(baseBundle) : 0,
      unmapped: spans.filter((s) => !coveredPhrases.has(s.text) && !resolverCandidates.some((rc) => rc.span === s && rc.resolved !== null)).length,
    },
    missedPhrases: mapperTrace?.missedPhrases ?? [],
  };

  return {
    bundle: finalBundle,
    spans,
    resolvedEntities,
    trace,
  };
}

function countBundle(b: ConstraintBundle): number {
  return b.hard.length + b.soft.length + b.inferred.length;
}
