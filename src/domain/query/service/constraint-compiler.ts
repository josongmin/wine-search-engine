import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import type { NLMapper } from '../../attribute/service/nl-mapper.js';
import { parseSpans, resolveOverlaps, type Span } from '../../attribute/service/span-parser.js';
import { resolveEntity, type ResolvedEntity } from '../../attribute/service/entity-resolver.js';
import type { FuzzyMatcherPort } from '../port/fuzzy-matcher.port.js';
import { expandWithOntology } from '../../attribute/service/ontology-expansion.js';
import {
  applyCompositionalInference,
  inferComparisonImpliedWineType,
} from '../../attribute/service/compositional-inference.js';
import { buildRetrievalPlan, type RetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';
import { extractRuleBasedConstraints } from './rule-based-constraint-extractor.js';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { ConstraintReasoner, type ConstraintReasonerOutput } from './constraint-reasoner.js';
import { buildTrivialGraphFromAtoms } from './build-trivial-graph-from-atoms.js';
import { isConstraintGraphEmitEnabled } from './constraint-graph-flags.js';
import type { ConstraintGraph } from '../model/constraint-graph.js';
import type { ConstraintTopologyPlanner } from './constraint-topology-planner.js';
import { isTopologyIntentGateOpen } from './constraint-topology-planner.js';
import { mergeTopologyIntoTrivial } from './merge-topology-into-trivial.js';
import type { QueryDecompositionHint } from '../model/query-decomposition.js';

export interface ConstraintCompilerResult {
  readonly bundle: ConstraintBundle;
  readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
  readonly retrievalPlan: RetrievalPlan;
  readonly resolvedEntities: readonly ResolvedEntity[];
  /**
   * E2-T2: ConstraintReasoner output — conflict-resolved atoms + pairwise relations.
   *
   * `resolvedBundle` is the conflict-resolved version of `bundle`; retrieval plan
   * and ranker MUST prefer this over the raw bundle when present.
   */
  readonly reasonerOutput: ConstraintReasonerOutput;
  /**
   * ADR-010 Phase 1a: ConstraintGraph — super-structure over
   * `reasonerOutput.atoms`. Phase 1a emits a trivial graph (one AND root
   * over every atom); downstream readers remain on atoms/bundle until
   * Phase 1b migrates them.
   *
   * Absent when the feature flag `CONSTRAINT_GRAPH_EMIT` is off. Field is
   * additive — existing consumers never read it and are unaffected.
   */
  readonly constraintGraph?: ConstraintGraph | undefined;
}

/**
 * ADR-010 Phase 1a feature flag. Default on; set to literal string 'false'
 * to suppress graph emission at the compiler seam (rollback).
 *
 * The helper itself lives in `./constraint-graph-flags.ts` so Phase 1b.4
 * (graph regeneration on constraint relaxation) can share the same
 * on/off semantics without a second inline `process.env` read — see
 * Rule 30 in `CLAUDE.md`.
 */

/**
 * ADR-012 Phase 1b.2 feature flag. Default OFF; set to literal 'true' to
 * enable LLM topology planner. When off (or when the planner is not
 * injected, e.g. no `ChatLlmPort` at composition root), the compiler
 * falls through to the deterministic trivial graph.
 */
function isConstraintGraphTopologyLlmEnabled(): boolean {
  return process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'] === 'true';
}

// SOFT_CONSTRAINT_ATTRIBUTES is imported from SSoT: ../../shared/constants/constraint-attributes.js
const MAX_UNRESOLVED_SPAN_SAMPLE_COUNT = 5;

const CONSTRAINT_REASONER = new ConstraintReasoner();

export class ConstraintCompiler {
  constructor(
    private readonly nlMapper: NLMapper,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
    private readonly topologyPlanner?: ConstraintTopologyPlanner | undefined,
  ) {}

  async compile(
    normalizedQuery: string,
    abortSignal?: AbortSignal,
    decompositionHint?: QueryDecompositionHint,
  ): Promise<ConstraintCompilerResult> {
    const spans = parseSpans(normalizedQuery);
    const candidatePhrases = spans.map((s) => s.text);

    const mapped = await this.nlMapper.mapConstraints(
      candidatePhrases,
      abortSignal !== undefined ? { abortSignal } : undefined,
    ).catch((err: unknown) => {
      // NLMapper failure: return empty constraints so Tier 6 rule-based
      // extraction and entity resolver can still run. The query proceeds
      // with reduced precision rather than aborting entirely.
      bootstrapLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[constraint-compiler] NLMapper.mapConstraints failed — falling back to Tier 6 rules only',
      );
      return {
        constraints: [],
        constraintExtraction: {
          candidatePhraseCount: candidatePhrases.length,
          ruleTableHitCount: 0,
          llmHitCount: 0,
          llmSkippedCount: 0,
          fallbackTriggered: true,
          source: 'fallback' as const,
          llmLatencyMs: null,
          phraseCacheHits: 0,
          phraseCacheNegativeSkipped: 0,
          phraseCacheMisses: 0,
          missedPhrases: [...candidatePhrases],
          fallbackReason: 'nlmapper_exception' as const,
        },
      };
    });
    const matched = mapped.constraints;
    const mapperTrace = mapped.constraintExtraction;

    const hard: ConstraintBundle['hard'][number][] = [];
    const soft: ConstraintBundle['soft'][number][] = [];

    for (const constraint of matched) {
      const isLlmSourced =
        (constraint.mapping_version?.startsWith('llm-') ?? false)
        || constraint.source_phrase.startsWith('llm_linker(');
      // Negation operators (exclude, not_in) are always hard regardless of attribute
      // because they produce Vespa NOT-clauses. Must be checked before SOFT_CONSTRAINT_ATTRIBUTES.
      const isNegationOperator = constraint.operator === 'exclude' || constraint.operator === 'not_in';
      if (!isNegationOperator && (isLlmSourced || SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute))) {
        soft.push(constraint);
      } else {
        hard.push(constraint);
      }
    }

    const coveredPhrases = new Set(matched.map((c) => c.source_phrase.toLowerCase()));
    const matchedAttributesByPhrase = new Map<string, Set<string>>();
    for (const constraint of matched) {
      const key = constraint.source_phrase.toLowerCase();
      const existing = matchedAttributesByPhrase.get(key) ?? new Set<string>();
      existing.add(constraint.attribute);
      matchedAttributesByPhrase.set(key, existing);
    }

    const resolverCandidates: {
      span: Span;
      resolved: { entity: ResolvedEntity; kind: 'primary' | 'shadow' } | null;
    }[] = [];
    for (const span of spans) {
      const preferredEntity = resolveEntity(span.text, { preferEntityOverStyle: true }, this.fuzzyMatcher);
      if (!coveredPhrases.has(span.text)) {
        resolverCandidates.push({
          span,
          resolved: preferredEntity !== null
            ? { entity: preferredEntity, kind: 'primary' }
            : null,
        });
        continue;
      }
      const coveredAttributes = matchedAttributesByPhrase.get(span.text) ?? new Set<string>();
      if (
        preferredEntity !== null
        && preferredEntity.entityType !== 'wine_type'
        && !coveredAttributes.has(preferredEntity.entityType)
      ) {
        resolverCandidates.push({
          span,
          resolved: { entity: preferredEntity, kind: 'shadow' },
        });
      } else {
        resolverCandidates.push({ span, resolved: null });
      }
    }

    const resolvedNonOverlap = resolveOverlaps(resolverCandidates)
      .filter((e): e is {
        span: Span;
        resolved: { entity: ResolvedEntity; kind: 'primary' | 'shadow' };
      } => e.resolved !== null);

    const resolvedEntities: ResolvedEntity[] = [];
    for (const { resolved } of resolvedNonOverlap) {
      resolvedEntities.push(resolved.entity);
      const constraint = {
        attribute: resolved.entity.entityType,
        operator: '=' as const,
        value: resolved.entity.canonicalValue,
        source_phrase: resolved.kind === 'shadow'
          ? `entity_shadow(${resolved.entity.matchedSurface})`
          : `entity_resolver(${resolved.entity.matchedSurface})`,
        confidence: resolved.entity.confidence,
        mapping_version: 'entity-resolver-v1.0',
      };
      if (SOFT_CONSTRAINT_ATTRIBUTES.has(resolved.entity.entityType)) {
        soft.push(constraint);
      } else {
        hard.push(constraint);
      }
    }

    const tier12Empty = hard.length === 0 && soft.length === 0;
    const tier6Bundle = extractRuleBasedConstraints(normalizedQuery);
    const tier6ConstraintCount = mergeConstraintBundleIntoLists(
      tier6Bundle,
      hard,
      soft,
    );

    let baseBundle: ConstraintBundle;
    let expanded: ConstraintBundle;
    let finalBundle: ConstraintBundle;

    if (tier12Empty) {
      const ontologyExpanded = expandWithOntology(tier6Bundle);
      expanded = ontologyExpanded;
      finalBundle = applyCompositionalInference(
        ontologyExpanded,
        { impliedWineType: inferComparisonImpliedWineType(ontologyExpanded, normalizedQuery) },
      );
      baseBundle = tier6Bundle;
    } else {
      baseBundle = { hard, soft, inferred: [] };
      expanded = expandWithOntology(baseBundle);
      finalBundle = applyCompositionalInference(
        expanded,
        { impliedWineType: inferComparisonImpliedWineType(expanded, normalizedQuery) },
      );
    }

    // E2-T2: Run ConstraintReasoner after Tier 6 (Wave 2 design: Tier 6 → Reasoner →
    // buildRetrievalPlan). The resolvedBundle is conflict-resolved and deduplicated;
    // retrieval plan, ranker, and query plan consumers MUST use it over the raw finalBundle.
    const reasonerOutput = CONSTRAINT_REASONER.reason(finalBundle);
    const effectiveBundle = reasonerOutput.resolvedBundle;

    const retrievalPlan = buildRetrievalPlan(effectiveBundle);
    const constraintExtraction = buildConstraintExtractionTrace({
      baseTrace: mapperTrace,
      spans,
      matched,
      resolvedEntityCount: resolvedEntities.length,
      finalBundle: effectiveBundle,
      ontologyAddedCount: countBundleConstraints(expanded) - countBundleConstraints(baseBundle),
      compositionalAddedCount: countBundleConstraints(finalBundle) - countBundleConstraints(expanded),
      tier6ConstraintCount,
      unresolvedSpanCount: countUnresolvedSpans(spans, coveredPhrases, resolvedNonOverlap),
      unresolvedSpanSamples: collectUnresolvedSpanSamples(spans, coveredPhrases, resolvedNonOverlap),
    });

    // ADR-010 Phase 1a: deterministic projection from reasoner atoms into
    // a trivial ConstraintGraph. Additive — no existing reader consumes
    // this field in Phase 1a. The flag lets ops disable emission without
    // a code change if the projector ever needs to be bypassed.
    //
    // ADR-012 Phase 1b.2: when `CONSTRAINT_GRAPH_TOPOLOGY_LLM` is on AND
    // a topology planner was injected AND the intent gate opens, we ask
    // the LLM for AND/OR/XOR/subquery topology on top of the trivial
    // projection. Any failure (null planner return, merge collision,
    // schema rejection) falls back to the trivial graph byte-for-byte.
    let constraintGraph: ConstraintGraph | undefined;
    if (isConstraintGraphEmitEnabled()) {
      // ADR-014 post-hotfix: build the graph from **surviving** atoms, not
      // the raw list. The pre-resolution atoms include constraints the
      // reasoner dropped (contradiction / redundancy / overshadow). If we
      // leak those into the graph's hard-tier subgraph the ranker's graph
      // hard-gate will reject candidates that the flat `effectiveBundle`
      // path would accept — golden-set regression on Italian wines
      // (`Masi Amarone`, `Barolo Monfortino`) traced this exact leak.
      const trivial = buildTrivialGraphFromAtoms(reasonerOutput.survivingAtoms);
      constraintGraph = trivial;

      if (
        isConstraintGraphTopologyLlmEnabled() &&
        this.topologyPlanner !== undefined &&
        isTopologyIntentGateOpen({
          normalizedQuery,
          ...(decompositionHint !== undefined ? { decompositionHint } : {}),
        })
      ) {
        const slotIds = trivial.nodes
          .filter((n) => n.kind === 'slot')
          .map((n) => n.nodeId);
        const topology = await this.topologyPlanner.plan({
          atoms: reasonerOutput.survivingAtoms,
          normalizedQuery,
          slotIds,
          ...(decompositionHint !== undefined ? { decompositionHint } : {}),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        });
        if (topology !== null) {
          const merged = mergeTopologyIntoTrivial(trivial, topology);
          if (merged !== null) {
            constraintGraph = merged;
          }
        }
      }
    }

    return {
      bundle: effectiveBundle,
      ...(constraintExtraction !== undefined ? { constraintExtraction } : {}),
      retrievalPlan,
      resolvedEntities,
      reasonerOutput,
      ...(constraintGraph !== undefined ? { constraintGraph } : {}),
    };
  }
}

function countBundleConstraints(bundle: ConstraintBundle): number {
  return bundle.hard.length + bundle.soft.length + bundle.inferred.length;
}

function constraintKey(constraint: NormalizedConstraint): string {
  // canonicalJsonStringify sorts object keys so range constraints
  // ({min,max} vs {max,min}) produce the same dedup key. (Bugbash Round 18)
  return `${constraint.attribute}|${constraint.operator}|${canonicalJsonStringify(constraint.value)}`;
}

/**
 * Merges a ConstraintBundle into the running hard/soft lists, deduplicating by
 * constraint key.
 *
 * W6-P1-3 (split-brain fix): incoming bundle.hard constraints are re-classified
 * using the SOFT_CONSTRAINT_ATTRIBUTES SSoT before insertion. The only exception
 * are `operator: 'exclude'` or `operator: 'not_in'` — negation operators are always
 * hard constraints regardless of attribute, because they produce Vespa NOT-clauses.
 *
 * Without this re-classification, rule-based-constraint-extractor.ts (which does
 * not import SOFT_CONSTRAINT_ATTRIBUTES) could place a `style` constraint in
 * bundle.hard, and it would land in the hard list — contradicting the SSoT that
 * classifies `style` as soft.
 */
function mergeConstraintBundleIntoLists(
  bundle: ConstraintBundle,
  hard: ConstraintBundle['hard'][number][],
  soft: ConstraintBundle['soft'][number][],
): number {
  const existing = new Set<string>([
    ...hard.map(constraintKey),
    ...soft.map(constraintKey),
  ]);
  let added = 0;
  for (const constraint of bundle.hard) {
    const key = constraintKey(constraint);
    if (existing.has(key)) continue;
    existing.add(key);
    // Re-classify: exclude and not_in operators are always hard (they produce NOT-clauses).
    // All other hard constraints are re-checked against SOFT_CONSTRAINT_ATTRIBUTES SSoT.
    const isNegationOperator = constraint.operator === 'exclude' || constraint.operator === 'not_in';
    if (!isNegationOperator && SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
      soft.push(constraint);
    } else {
      hard.push(constraint);
    }
    added++;
  }
  for (const constraint of bundle.soft) {
    const key = constraintKey(constraint);
    if (existing.has(key)) continue;
    existing.add(key);
    soft.push(constraint);
    added++;
  }
  return added;
}

function collectUnresolvedSpanSamples(
  spans: readonly Span[],
  coveredPhrases: ReadonlySet<string>,
  resolved: readonly {
    span: Span;
    resolved: { entity: ResolvedEntity; kind: 'primary' | 'shadow' };
  }[],
): readonly string[] {
  const resolvedKeys = new Set(resolved.map((entry) => spanKey(entry.span)));
  const samples: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    if (coveredPhrases.has(span.text) || resolvedKeys.has(spanKey(span)) || seen.has(span.text)) {
      continue;
    }
    seen.add(span.text);
    samples.push(span.text);
    if (samples.length >= MAX_UNRESOLVED_SPAN_SAMPLE_COUNT) {
      break;
    }
  }
  return samples;
}

function countUnresolvedSpans(
  spans: readonly Span[],
  coveredPhrases: ReadonlySet<string>,
  resolved: readonly {
    span: Span;
    resolved: { entity: ResolvedEntity; kind: 'primary' | 'shadow' };
  }[],
): number {
  const resolvedKeys = new Set(resolved.map((entry) => spanKey(entry.span)));
  let count = 0;
  for (const span of spans) {
    if (!coveredPhrases.has(span.text) && !resolvedKeys.has(spanKey(span))) {
      count++;
    }
  }
  return count;
}

function spanKey(span: Span): string {
  return `${span.startChar}:${span.endChar}:${span.text}`;
}

function uniqueCoveredCategories(bundle: ConstraintBundle): readonly string[] {
  const categories = new Set<string>();
  for (const constraint of [...bundle.hard, ...bundle.soft, ...bundle.inferred]) {
    categories.add(constraint.attribute);
  }
  return [...categories].sort((left, right) => left.localeCompare(right));
}

function buildConstraintExtractionTrace(args: {
  readonly baseTrace?: ConstraintExtractionTrace | undefined;
  readonly spans: readonly Span[];
  readonly matched: readonly NormalizedConstraint[];
  readonly resolvedEntityCount: number;
  readonly finalBundle: ConstraintBundle;
  readonly ontologyAddedCount: number;
  readonly compositionalAddedCount: number;
  readonly tier6ConstraintCount: number;
  readonly unresolvedSpanCount: number;
  readonly unresolvedSpanSamples: readonly string[];
}): ConstraintExtractionTrace | undefined {
  const {
    baseTrace,
    spans,
    matched,
    resolvedEntityCount,
    finalBundle,
    ontologyAddedCount,
    compositionalAddedCount,
    tier6ConstraintCount,
    unresolvedSpanCount,
    unresolvedSpanSamples,
  } = args;
  if (baseTrace === undefined) {
    return undefined;
  }

  const llmLinkedEntityCount = baseTrace.llmLinkedEntityCount ?? 0;
  const source: ConstraintExtractionTrace['source'] =
    resolvedEntityCount > 0 && (baseTrace.llmHitCount > 0 || llmLinkedEntityCount > 0)
      ? 'resolver_plus_llm'
      : resolvedEntityCount > 0
        ? 'resolver'
        : baseTrace.source;

  return {
    ...baseTrace,
    source,
    candidateSpanCount: spans.length,
    resolvedEntityCount,
    directHardConstraintCount: matched.filter((constraint) =>
      !SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)).length + resolvedEntityCount,
    ontologyExpandedConstraintCount: ontologyAddedCount,
    compositionalInferenceCount: compositionalAddedCount,
    phrasesByTier: {
      tier1_default_mapping: baseTrace.ruleTableHitCount,
      tier2_entity_resolver: resolvedEntityCount,
      tier3_ontology_expansion: ontologyAddedCount,
      tier4_compositional_inference: compositionalAddedCount,
      tier5_llm_linker: llmLinkedEntityCount,
      tier6_regex_fallback: tier6ConstraintCount,
      unmapped: unresolvedSpanCount,
    },
    categoriesCovered: uniqueCoveredCategories(finalBundle),
    unresolvedSpanSamples,
  };
}
