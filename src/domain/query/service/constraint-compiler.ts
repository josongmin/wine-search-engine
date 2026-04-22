import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import type { AmbiguousEntityHint } from '../../attribute/model/ambiguous-entity-hint.js';
import type { NLMapper } from '../../attribute/service/nl-mapper.js';
import { parseSpans, resolveOverlaps, type Span } from '../../attribute/service/span-parser.js';
import {
  isDirectEntityResolution,
  resolveEntity,
  type ResolvedEntity,
} from '../../attribute/service/entity-resolver.js';
import type { FuzzyMatcherPort } from '../port/fuzzy-matcher.port.js';
import { expandWithOntology } from '../../attribute/service/ontology-expansion.js';
import { REGION_PARENTS } from '../../evaluation/service/wine-ontology.js';
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
import { DeterministicTopologyDetector } from './deterministic-topology-detector.js';
import type { QueryDecompositionHint } from '../model/query-decomposition.js';
import { extractAllPairingConstraints, type PairingTag } from './pairing-extractor.js';

export interface ConstraintCompilerResult {
  readonly bundle: ConstraintBundle;
  readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
  readonly retrievalPlan: RetrievalPlan;
  readonly resolvedEntities: readonly ResolvedEntity[];
  readonly ambiguousEntityHints: readonly AmbiguousEntityHint[];
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
 * falls through to the deterministic detector (F1) or the trivial graph.
 */
function isConstraintGraphTopologyLlmEnabled(): boolean {
  return process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'] === 'true';
}

/**
 * Wave F1 feature flag. Default ON; set to literal 'false' to disable
 * the deterministic pattern-based topology detector. Priority chain:
 * LLM (if enabled) > deterministic (this flag, default on) > trivial.
 */
function isConstraintGraphTopologyDeterministicEnabled(): boolean {
  return process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'] !== 'false';
}

// SOFT_CONSTRAINT_ATTRIBUTES is imported from SSoT: ../../shared/constants/constraint-attributes.js
const MAX_UNRESOLVED_SPAN_SAMPLE_COUNT = 5;

const CONSTRAINT_REASONER = new ConstraintReasoner();
/** Wave F1: single shared deterministic detector — stateless, safe to reuse. */
const DETERMINISTIC_TOPOLOGY_DETECTOR = new DeterministicTopologyDetector();
const PAIRING_OBJECTIVE_MAPPING_VERSION = 'pairing-objective-v1.0';
const PAIRING_OBJECTIVE_CONFIDENCE = 0.9;
const SPICY_FOOD_STYLE_VALUES = ['off_dry', 'sweet'] as const;
const WHITE_FISH_WINE_TYPE_VALUES = ['white', 'sparkling', 'rosé'] as const;

function foldOntologyKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

function isOntologyAppellationValue(value: string): boolean {
  const foldedValue = foldOntologyKey(value);
  return [...REGION_PARENTS.keys()].some((key) => foldOntologyKey(key) === foldedValue);
}

function canPromoteResolvedEntityToConstraint(entity: ResolvedEntity): boolean {
  if (entity.entityType !== 'appellation') {
    return true;
  }
  return isOntologyAppellationValue(entity.canonicalValue);
}

function spanContains(container: Span, candidate: Span): boolean {
  return (
    container.startChar <= candidate.startChar
    && container.endChar >= candidate.endChar
    && (container.startChar !== candidate.startChar || container.endChar !== candidate.endChar)
  );
}

function buildIdentityOnlyShieldSpans(
  spans: readonly Span[],
  fuzzyMatcher: FuzzyMatcherPort | undefined,
): readonly Span[] {
  return spans.filter((span) => {
    const resolved = resolveEntity(span.text, { preferEntityOverStyle: true }, fuzzyMatcher);
    return isDirectEntityResolution(resolved) && !canPromoteResolvedEntityToConstraint(resolved);
  });
}

function constraintSourceIsShieldedByIdentityOnlySpan(
  constraint: NormalizedConstraint,
  spans: readonly Span[],
  identityOnlyShieldSpans: readonly Span[],
): boolean {
  const source = constraint.source_phrase.trim().toLowerCase();
  if (source.length === 0 || identityOnlyShieldSpans.length === 0) {
    return false;
  }
  return spans
    .filter((span) => span.text === source)
    .some((span) => identityOnlyShieldSpans.some((shield) => spanContains(shield, span)));
}

function stripIdentityOnlyShadowConstraints(
  constraints: readonly NormalizedConstraint[],
  spans: readonly Span[],
  identityOnlyShieldSpans: readonly Span[],
): readonly NormalizedConstraint[] {
  return constraints.filter((constraint) =>
    !constraintSourceIsShieldedByIdentityOnlySpan(constraint, spans, identityOnlyShieldSpans),
  );
}

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
    );
    const identityOnlyShieldSpans = buildIdentityOnlyShieldSpans(spans, this.fuzzyMatcher);
    const matched = stripIdentityOnlyShadowConstraints(
      mapped.constraints,
      spans,
      identityOnlyShieldSpans,
    );
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
    const coveredSpans = spans.filter((span) => coveredPhrases.has(span.text));
    const matchedAttributesByPhrase = new Map<string, Set<string>>();
    for (const constraint of matched) {
      const key = constraint.source_phrase.toLowerCase();
      const existing = matchedAttributesByPhrase.get(key) ?? new Set<string>();
      existing.add(constraint.attribute);
      matchedAttributesByPhrase.set(key, existing);
    }

    type ResolverResolution =
      | { entity: ResolvedEntity; kind: 'primary' | 'shadow' | 'covered' }
      | { hint: AmbiguousEntityHint; kind: 'ambiguous_hint' };
    const resolverCandidates: {
      span: Span;
      resolved: ResolverResolution | null;
    }[] = [];
    for (const span of spans) {
      const preferredEntity = resolveEntity(span.text, { preferEntityOverStyle: true }, this.fuzzyMatcher);
      const ambiguousEntity =
        preferredEntity !== null
        && preferredEntity !== undefined
        && preferredEntity.ambiguityHint !== undefined
          ? preferredEntity
          : null;
      if (!coveredPhrases.has(span.text)) {
        let resolved: ResolverResolution | null = null;
        if (isDirectEntityResolution(preferredEntity)) {
          resolved = { entity: preferredEntity, kind: 'primary' };
        } else if (ambiguousEntity !== null) {
          resolved = { hint: ambiguousEntity.ambiguityHint!, kind: 'ambiguous_hint' };
        }
        resolverCandidates.push({
          span,
          resolved,
        });
        continue;
      }
      const coveredAttributes = matchedAttributesByPhrase.get(span.text) ?? new Set<string>();
      if (
        isDirectEntityResolution(preferredEntity)
        && preferredEntity.entityType !== 'wine_type'
        && !coveredAttributes.has(preferredEntity.entityType)
      ) {
        resolverCandidates.push({
          span,
          resolved: { entity: preferredEntity, kind: 'shadow' },
        });
      } else if (
        isDirectEntityResolution(preferredEntity)
        && coveredAttributes.has(preferredEntity.entityType)
      ) {
        resolverCandidates.push({
          span,
          resolved: { entity: preferredEntity, kind: 'covered' },
        });
      } else {
        resolverCandidates.push({ span, resolved: null });
      }
    }

    const resolvedNonOverlap = resolveOverlaps(resolverCandidates)
      .filter((e): e is {
        span: Span;
        resolved: ResolverResolution;
      } => e.resolved !== null);

    const resolvedEntities: ResolvedEntity[] = [];
    const ambiguousEntityHints: AmbiguousEntityHint[] = [];
    let promotedResolvedEntityConstraintCount = 0;
    for (const { span, resolved } of resolvedNonOverlap) {
      if (resolved.kind === 'ambiguous_hint') {
        if (isShieldedByCoveredSpan(span, coveredSpans)) {
          continue;
        }
        ambiguousEntityHints.push(resolved.hint);
        continue;
      }
      resolvedEntities.push(resolved.entity);
      if (resolved.kind === 'covered') {
        continue;
      }
      if (!canPromoteResolvedEntityToConstraint(resolved.entity)) {
        continue;
      }
      promotedResolvedEntityConstraintCount += 1;
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
    // Tier 6 receives the ORIGINAL query — predicate normalization is handled
    // by the NL mapper's phrase-level variant lookup (korean-predicate-variants.ts),
    // NOT by query-level transformation. Applying normalizeQueryPredicates to the
    // full query breaks negation markers: "말고" (postpositional negation) gets
    // transformed to "말은" (meaningless) by the "고→은" suffix rule, preventing
    // NEGATION_SUBJECT_AFTER from matching.
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
      finalBundle = applyPairingObjectiveInference(finalBundle, normalizedQuery);
      baseBundle = tier6Bundle;
    } else {
      baseBundle = { hard, soft, inferred: [] };
      expanded = expandWithOntology(baseBundle);
      finalBundle = applyCompositionalInference(
        expanded,
        { impliedWineType: inferComparisonImpliedWineType(expanded, normalizedQuery) },
      );
      finalBundle = applyPairingObjectiveInference(finalBundle, normalizedQuery);
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
      promotedResolvedEntityConstraintCount,
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

      // Priority chain: LLM (if enabled + planner injected + intent gate) >
      // deterministic (F1, default on) > trivial (already assigned above).
      const slotIds = trivial.nodes
        .filter((n) => n.kind === 'slot')
        .map((n) => n.nodeId);

      let topologyHandled = false;
      if (
        isConstraintGraphTopologyLlmEnabled() &&
        this.topologyPlanner !== undefined &&
        isTopologyIntentGateOpen({
          normalizedQuery,
          ...(decompositionHint !== undefined ? { decompositionHint } : {}),
        })
      ) {
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
            topologyHandled = true;
          }
        }
      }

      // Wave F1: deterministic pattern-based topology detector. Runs when
      // the LLM path did not produce a usable graph (either disabled, not
      // injected, intent gate closed, LLM returned null, or merge failed).
      // Stateless + pure — safe to call on every compile.
      if (!topologyHandled && isConstraintGraphTopologyDeterministicEnabled()) {
        const detected = DETERMINISTIC_TOPOLOGY_DETECTOR.detect({
          atoms: reasonerOutput.survivingAtoms,
          normalizedQuery,
          slotIds,
          ...(decompositionHint !== undefined ? { decompositionHint } : {}),
        });
        if (detected !== null) {
          const merged = mergeTopologyIntoTrivial(trivial, detected);
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
      ambiguousEntityHints,
      reasonerOutput,
      ...(constraintGraph !== undefined ? { constraintGraph } : {}),
    };
  }
}

function isShieldedByCoveredSpan(
  candidate: Span,
  coveredSpans: readonly Span[],
): boolean {
  return coveredSpans.some((coveredSpan) =>
    spansOverlap(candidate, coveredSpan)
    && spanLength(coveredSpan) > spanLength(candidate),
  );
}

function spansOverlap(left: Span, right: Span): boolean {
  return left.startChar < right.endChar && right.startChar < left.endChar;
}

function spanLength(span: Span): number {
  return span.endChar - span.startChar;
}

function countBundleConstraints(bundle: ConstraintBundle): number {
  return bundle.hard.length + bundle.soft.length + bundle.inferred.length;
}

function constraintKey(constraint: NormalizedConstraint): string {
  // canonicalJsonStringify sorts object keys so range constraints
  // ({min,max} vs {max,min}) produce the same dedup key. (Bugbash Round 18)
  return `${constraint.attribute}|${constraint.operator}|${canonicalJsonStringify(constraint.value)}`;
}

function applyPairingObjectiveInference(
  bundle: ConstraintBundle,
  normalizedQuery: string,
): ConstraintBundle {
  const inferred = inferPairingObjectiveConstraints(normalizedQuery);
  if (inferred.length === 0) {
    return bundle;
  }

  const existing = new Set<string>([
    ...bundle.hard.map(constraintKey),
    ...bundle.soft.map(constraintKey),
    ...bundle.inferred.map(constraintKey),
  ]);
  const mergedInferred: NormalizedConstraint[] = [...bundle.inferred];
  for (const constraint of inferred) {
    const key = constraintKey(constraint);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    mergedInferred.push(constraint);
  }

  return {
    hard: bundle.hard,
    soft: bundle.soft,
    inferred: mergedInferred,
  };
}

function inferPairingObjectiveConstraints(normalizedQuery: string): readonly NormalizedConstraint[] {
  const constraints: NormalizedConstraint[] = [];
  for (const tag of extractAllPairingConstraints(normalizedQuery)) {
    const inferred = pairingTagToObjectiveConstraint(tag);
    if (inferred !== null) {
      constraints.push(inferred);
    }
  }
  return constraints;
}

function pairingTagToObjectiveConstraint(tag: PairingTag): NormalizedConstraint | null {
  if (tag === 'spicy_food') {
    return {
      attribute: 'style',
      operator: 'in',
      value: SPICY_FOOD_STYLE_VALUES,
      source_phrase: `pairing_objective(${tag})`,
      confidence: PAIRING_OBJECTIVE_CONFIDENCE,
      mapping_version: PAIRING_OBJECTIVE_MAPPING_VERSION,
    };
  }

  if (tag === 'white_fish') {
    return {
      attribute: 'wine_type',
      operator: 'in',
      value: WHITE_FISH_WINE_TYPE_VALUES,
      source_phrase: `pairing_objective(${tag})`,
      confidence: PAIRING_OBJECTIVE_CONFIDENCE,
      mapping_version: PAIRING_OBJECTIVE_MAPPING_VERSION,
    };
  }

  return null;
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
    resolved: unknown;
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
    resolved: unknown;
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
  readonly promotedResolvedEntityConstraintCount: number;
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
    promotedResolvedEntityConstraintCount,
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
      !SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)).length + promotedResolvedEntityConstraintCount,
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
