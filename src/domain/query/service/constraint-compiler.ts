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

export interface ConstraintCompilerResult {
  readonly bundle: ConstraintBundle;
  readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
  readonly retrievalPlan: RetrievalPlan;
  readonly resolvedEntities: readonly ResolvedEntity[];
}

// SOFT_CONSTRAINT_ATTRIBUTES is imported from SSoT: ../../shared/constants/constraint-attributes.js
const MAX_UNRESOLVED_SPAN_SAMPLE_COUNT = 5;

export class ConstraintCompiler {
  constructor(
    private readonly nlMapper: NLMapper,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
  ) {}

  async compile(
    normalizedQuery: string,
    abortSignal?: AbortSignal,
  ): Promise<ConstraintCompilerResult> {
    const spans = parseSpans(normalizedQuery);
    const candidatePhrases = spans.map((s) => s.text);

    let mapped: Awaited<ReturnType<NLMapper['mapConstraints']>>;
    try {
      mapped = await this.nlMapper.mapConstraints(
        candidatePhrases,
        abortSignal !== undefined ? { abortSignal } : undefined,
      );
    } catch (err: unknown) {
      // NLMapper failure must not crash the query. Degrade to empty mapping
      // so entity resolver, ontology expansion, and regex fallback still fire.
      bootstrapLogger.warn({ err: err instanceof Error ? err.message : String(err) }, '[constraint-compiler] NLMapper.mapConstraints failed — degrading to empty mapping');
      mapped = {
        constraints: [],
        constraintExtraction: {
          candidatePhraseCount: candidatePhrases.length,
          candidateSpanCount: spans.length,
          ruleTableHitCount: 0,
          llmHitCount: 0,
          llmSkippedCount: 0,
          fallbackTriggered: true,
          source: 'fallback' as const,
          fallbackReason: 'nlmapper_exception',
          llmLatencyMs: null,
          phraseCacheHits: 0,
          phraseCacheNegativeSkipped: 0,
          phraseCacheMisses: 0,
          missedPhrases: candidatePhrases,
        },
      };
    }
    const matched = mapped.constraints;
    const mapperTrace = mapped.constraintExtraction;

    const hard: ConstraintBundle['hard'][number][] = [];
    const soft: ConstraintBundle['soft'][number][] = [];

    for (const constraint of matched) {
      const isLlmSourced =
        (constraint.mapping_version?.startsWith('llm-') ?? false)
        || constraint.source_phrase.startsWith('llm_linker(');
      if (isLlmSourced || SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
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

    const retrievalPlan = buildRetrievalPlan(finalBundle);
    const constraintExtraction = buildConstraintExtractionTrace({
      baseTrace: mapperTrace,
      spans,
      matched,
      resolvedEntityCount: resolvedEntities.length,
      finalBundle,
      ontologyAddedCount: countBundleConstraints(expanded) - countBundleConstraints(baseBundle),
      compositionalAddedCount: countBundleConstraints(finalBundle) - countBundleConstraints(expanded),
      tier6ConstraintCount,
      unresolvedSpanCount: countUnresolvedSpans(spans, coveredPhrases, resolvedNonOverlap),
      unresolvedSpanSamples: collectUnresolvedSpanSamples(spans, coveredPhrases, resolvedNonOverlap),
    });

    return {
      bundle: finalBundle,
      ...(constraintExtraction !== undefined ? { constraintExtraction } : {}),
      retrievalPlan,
      resolvedEntities,
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
    hard.push(constraint);
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
