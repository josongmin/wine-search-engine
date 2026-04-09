import type {
  QueryClass,
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import type { QueryPlanV2 } from '../model/query-plan.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { QueryUncertainty } from '../model/query-uncertainty.js';
import type { SessionContext } from '../model/session-context.js';
import type { QueryBudget } from '../model/query-budget.js';
import type { QueryTargetType } from '../model/query-target-type.js';
import { DEFAULT_QUERY_BUDGET } from '../model/query-budget.js';
import { MAX_QUERY_LENGTH } from '../../shared/constants.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../model/threshold-profile.js';
import type { AmbiguityDictionary } from '../port/ambiguity-dictionary.port.js';
import type { FuzzyMatcherPort } from '../port/fuzzy-matcher.port.js';
import { type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { type NLMapper } from '../../attribute/service/nl-mapper.js';
import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import { parseSpans, resolveOverlaps, type Span } from '../../attribute/service/span-parser.js';
import { expandWithOntology } from '../../attribute/service/ontology-expansion.js';
import {
  applyCompositionalInference,
  inferComparisonImpliedWineType,
} from '../../attribute/service/compositional-inference.js';
import { resolveEntity, type ResolvedEntity } from '../../attribute/service/entity-resolver.js';
import type { RequestExecutionContext } from '../../shared/request-execution-context.js';
import { QueryNormalizer } from './query-normalizer.js';
import { extractRuleBasedConstraints } from './rule-based-constraint-extractor.js';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  detectQueryIntent,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import { analyzeQueryDecomposition } from './decomposition-detector.js';
import { extractAllPairingConstraints } from './pairing-extractor.js';
import { correctKoreanWineTypos } from './korean-wine-aliases.js';

/** Current planner version. */
const PLANNER_VERSION = '1.0.0';

/** Current policy rule version. */
const POLICY_RULE_VERSION = '1.0.0';

/** Short-query ambiguity: anchor confidence must exceed this when multiple candidates exist. */
const SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD = 0.8;
/** Confidence assigned to taxonomy-derived pairing soft constraints. */
const PAIRING_SOFT_CONSTRAINT_CONFIDENCE = 0.88;
/** Parser confidence floor in uncertainty (weak prior). */
const UNCERTAINTY_PARSER_CONFIDENCE_FLOOR = 0.5;
/** Parser confidence reduction per whitespace token. */
const UNCERTAINTY_PARSER_CONFIDENCE_PER_TOKEN_PENALTY = 0.05;
/** Constraint confidence when no hard constraints are present. */
const UNCERTAINTY_CONSTRAINT_CONFIDENCE_NEUTRAL = 0.5;
/** Below this aggregate anchor confidence, flag low_anchor_confidence ambiguity. */
const UNCERTAINTY_LOW_ANCHOR_CONFIDENCE_THRESHOLD = 0.6;
const UNCERTAINTY_OVERALL_WEIGHT_PARSER = 0.3;
const UNCERTAINTY_OVERALL_WEIGHT_ANCHOR = 0.4;
const UNCERTAINTY_OVERALL_WEIGHT_CONSTRAINT = 0.3;
/** Added to overall uncertainty when any ambiguity markers fire. */
const UNCERTAINTY_AMBIGUITY_OVERALL_BUMP = 0.15;
/** Overall uncertainty at or above this triggers raise_threshold decision effect. */
const UNCERTAINTY_RAISE_THRESHOLD_OVERALL = 0.6;

/** Vintage year pattern to detect explicit vintage specification. */
const VINTAGE_YEAR_PATTERN = /(?<!\p{L})(?<!\p{N})(19|20)\d{2}(?!\p{L})(?!\p{N})/u;

/** Producer catalog browse: "Château X best wines" (Epic 7, golden `producer_browse`). */
const PRODUCER_BROWSE_QUERY_PATTERN = /(?<!\p{L})(?<!\p{N})(?:best|top|great|famous)\s+wines(?!\p{L})(?!\p{N})/iu;

/** Region path: hierarchical "A / B / C" (Epic 7, golden `region_browse`). */
function regionHierarchySlashCount(normalizedQuery: string): number {
  return (normalizedQuery.match(/\//g) ?? []).length;
}

/** Region/location keywords for geographic entity detection. */
const REGION_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:napa|sonoma|bordeaux|burgundy|tuscany|champagne)(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})(?:valley|region|appellation|aoc|doc|doca|côtes|côte)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:나파|샤블리|보르도|투지|롱글로|토스카나)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])(?:지역|지방|아펠라시옹|지역명)(?=$|[^\p{L}\p{N}])/u,
] as const;

const SOFT_CONSTRAINT_ATTRIBUTES = new Set([
  'body', 'sweetness', 'acidity', 'tannin', 'style',
  'price_band', 'occasion',
]);

/** Cap on span text samples for unresolved-span diagnostics (keeps mapper trace compact). */
const MAX_UNRESOLVED_SPAN_SAMPLE_COUNT = 5;

/**
 * Context passed to the planner alongside the raw query.
 */
export interface PlannerContext extends RequestExecutionContext {
  /** Locale hint for language-aware processing. */
  readonly locale?: string | undefined;
  /** Session context for multi-turn reformulation detection. */
  readonly session?: SessionContext | undefined;
  /** Resource budget override. */
  readonly budget?: QueryBudget | undefined;
}

/**
 * The main query planner service.
 *
 * Orchestrates query normalization, anchor extraction, intent detection,
 * routing, constraint parsing, expansion building, uncertainty assessment,
 * and policy compilation into a single immutable {@link QueryPlanV2}.
 *
 * Deterministic: the same input query, planner version, and policy rule
 * version always produce the same plan.
 */
export class Planner {
  private readonly queryNormalizer = new QueryNormalizer();

  constructor(
    private readonly ambiguityDict: AmbiguityDictionary,
    private readonly anchorExtractor: AnchorExtractor,
    private readonly expansionBuilder: ExpansionBuilder,
    private readonly nlMapper: NLMapper,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
  ) {}

  /**
   * Plans a query by executing the full planning pipeline.
   *
   * Pipeline stages:
   * 1. Normalize query.
   * 2. Extract anchors.
   * 3. Detect intent.
   * 4. Determine route.
   * 5. Determine retrieval mode (RFC-017 §8.3).
   * 6. Determine query class.
   * 7. Parse constraints (NLMapper + {@link extractRuleBasedConstraints}).
   * 8. Build expansions.
   * 9. Compute uncertainty.
   * 10. Compile policy.
   *
   * @param query - The raw user query string.
   * @param context - Optional planner context (locale, session, budget).
   * @returns An immutable query plan.
   */
  async plan(query: string, context?: PlannerContext): Promise<QueryPlanV2> {
    // Defense-in-depth: cap query length to prevent ReDoS in downstream regex extractors.
    // Aligned with HTTP-layer MAX_QUERY_LENGTH so the planner never receives larger.
    const safeQuery = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;

    // 1. Normalize + Korean typo correction.
    const typoFixed = correctKoreanWineTypos(safeQuery);
    const queryViews = this.queryNormalizer.normalize(typoFixed);
    const normalizedQuery = queryViews.accentless;

    // 2. Extract anchors.
    const anchors = await this.anchorExtractor.extract(normalizedQuery, queryViews);

    // 2b. Fuzzy-match fallback: when anchor extraction finds nothing, try
    //     approximate matching against the known-term index.
    let fuzzyExpansions: readonly string[] = [];
    if (anchors.length === 0 && this.fuzzyMatcher !== undefined) {
      const fuzzyHits = this.fuzzyMatcher.match(normalizedQuery);
      fuzzyExpansions = fuzzyHits.map((h) => h.term);
    }

    // 3. Detect intent.
    const intent = detectQueryIntent(
      normalizedQuery,
      anchors,
      this.anchorExtractor,
    );

    // 4. Determine route.
    const route = this.determineRoute(intent, anchors);

    // 5. Determine retrieval mode.
    const retrievalMode = this.determineRetrievalMode(
      intent,
      anchors,
      normalizedQuery,
    );

    // 6. Determine query class.
    const queryClass = await this.determineQueryClass(
      normalizedQuery,
      intent,
      anchors,
    );

    // 6. Parse constraints (NL + rule-based) and attach food-pairing tags (Epic 12).
    const parsed = await this.parseConstraints(normalizedQuery, intent, context?.abortSignal);
    const constraints = this.mergePairingIntoBundle(
      parsed.bundle,
      normalizedQuery,
    );

    // 7. Build expansions.
    const baseExpansions = this.expansionBuilder.build(
      normalizedQuery,
      intent,
      anchors,
    );

    // Merge fuzzy-match results into lexical expansions.
    const expansions =
      fuzzyExpansions.length > 0
        ? {
            ...baseExpansions,
            lexical: [...baseExpansions.lexical, ...fuzzyExpansions],
          }
        : baseExpansions;

    // 8. Compute uncertainty.
    const uncertainty = await this.computeUncertainty(
      normalizedQuery,
      anchors,
      constraints,
    );

    const budget = context?.budget ?? DEFAULT_QUERY_BUDGET;

    // 10. Infer target entity type for result grouping (Epic 8).
    const targetEntityType = this.inferTargetEntityType(
      normalizedQuery,
      anchors,
      constraints,
      intent,
    );

    // Derive secondary intents from the 2nd+ anchor candidates.
    const secondaryIntents =
      anchors.length >= 2
        ? anchors.slice(1).map((a): QueryIntent =>
            a.confidence >= EXACT_ANCHOR_CONFIDENCE
              ? 'entity_exact'
              : 'entity_fuzzy',
          )
        : undefined;

    // RFC-005 §3.1, RFC-016 §2: surface what evidence/sealing the Admission
    // Gate needs for this query so it can close the resolved boundary correctly.
    const admission_context = {
      requires_identity_seal:
        intent === 'entity_exact' ||
        intent === 'entity_fuzzy' ||
        intent === 'comparison_search' ||
        intent === 'mixed_query',
      requires_constraint_evidence: constraints.hard.length > 0,
      requires_anchor_evidence: route === 'mixed' && anchors.length > 0,
    };
    const decompositionHint = analyzeQueryDecomposition(query).hint;

    return {
      rawQuery: query,
      normalizedQuery,
      normalizedQueryViews: queryViews,
      intent,
      ...(secondaryIntents !== undefined && { secondaryIntents }),
      suggestedRoute: route,
      suggestedRetrievalMode: retrievalMode,
      queryClass,
      anchors,
      constraints,
      expansions,
      uncertainty,
      plannerVersion: PLANNER_VERSION,
      policyRuleVersion: POLICY_RULE_VERSION,
      thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
      admission_context,
      ...(context?.session !== undefined && { sessionContext: context.session }),
      queryBudget: budget,
      ...(decompositionHint.strategy !== 'none' ? { decompositionHint } : {}),
      ...(targetEntityType !== undefined && { targetEntityType }),
      ...(parsed.constraintExtraction !== undefined
        ? { constraintExtraction: parsed.constraintExtraction }
        : {}),
    };
  }

  /**
   * Determines the query route based on intent and anchors.
   */
  private determineRoute(
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): QueryRoute {
    switch (intent) {
      case 'entity_exact':
        return 'entity';
      case 'entity_fuzzy':
        return anchors.length > 0 ? 'entity' : 'hybrid';
      case 'comparison_search':
        return 'entity';
      case 'mixed_query':
        return 'mixed';
      case 'facet_search':
      case 'semantic_discovery':
      case 'pairing_search':
      case 'budget_search':
        return 'hybrid';
    }
  }

  /**
   * Determines the fine-grained retrieval mode based on intent, anchors, and query surface.
   * RFC-017 §8.3: maps intent + context to a specific retrieval strategy.
   *
   * Mode selection logic (from Epic 7):
   *  - entity_exact → entity_lookup
   *  - entity_fuzzy + multiple_candidates → entity_resolution
   *  - comparison_search → compare_candidates
   *  - mixed_query + anchor → similar_items
   *  - pairing_search → recommendation
   *  - facet_search/budget_search (no anchor) → constraint_filter
   *  - semantic_discovery/generic anchor search → attribute_search
   *  - entity_exact|mixed_query + strong anchor + "best wines" → producer_browse
   *  - facet/semantic/budget + region path (≥2 '/') → region_browse
   */
  private determineRetrievalMode(
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
    normalizedQuery: string,
  ): RetrievalMode {
    const hasStrongAnchor = anchors.some(
      (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
    );
    const hasAnyAnchor = anchors.some(
      (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
    );
    const hasMultipleCandidates = anchors.some(
      (a) => a.candidateEntityIds.length > 1,
    );

    // Comparison search: multiple anchors or explicit comparison intent
    if (intent === 'comparison_search') {
      return 'compare_candidates';
    }

    // Producer catalog browse ("Domaine X best wines", Epic 7)
    if (
      (intent === 'entity_exact' || intent === 'mixed_query') &&
      hasStrongAnchor &&
      PRODUCER_BROWSE_QUERY_PATTERN.test(normalizedQuery)
    ) {
      return 'producer_browse';
    }

    // Region / appellation hierarchy path ("… / Napa Valley / …", Epic 7 + golden)
    if (
      (intent === 'facet_search' ||
        intent === 'semantic_discovery' ||
        intent === 'budget_search') &&
      regionHierarchySlashCount(normalizedQuery) >= 2
    ) {
      return 'region_browse';
    }

    // Ambiguous entity: single anchor with multiple candidate entities
    if (intent === 'entity_fuzzy' && hasMultipleCandidates) {
      return 'entity_resolution';
    }

    // Strong single entity lookup (exact match)
    if (intent === 'entity_exact' && hasStrongAnchor) {
      return 'entity_lookup';
    }

    // Similar items: mixed query with an anchor
    if (intent === 'mixed_query' && hasAnyAnchor) {
      return 'similar_items';
    }

    // Pairing-based recommendation
    if (intent === 'pairing_search') {
      return 'recommendation';
    }

    // Pure constraint filtering (no entity involved)
    if (
      (intent === 'facet_search' || intent === 'budget_search') &&
      !hasAnyAnchor
    ) {
      return 'constraint_filter';
    }

    // Semantic discovery and generic searches
    if (intent === 'semantic_discovery') {
      return 'attribute_search';
    }

    // Default: attribute search (hybrid vector + constraints)
    return 'attribute_search';
  }

  /**
   * Determines the query class based on intent, anchors, and ambiguity.
   */
  private async determineQueryClass(
    normalizedQuery: string,
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): Promise<QueryClass> {
    // Check whether the full normalized query is itself a known ambiguous form.
    const fullQueryAmbiguous =
      await this.ambiguityDict.isKnownAmbiguous(normalizedQuery);
    if (fullQueryAmbiguous) {
      return 'ambiguous_short_form';
    }

    // Check for known ambiguous terms.
    for (const anchor of anchors) {
      const isAmbiguous = await this.ambiguityDict.isKnownAmbiguous(
        anchor.normalizedForm,
      );
      if (isAmbiguous) {
        return 'ambiguous_short_form';
      }
    }

    // Short queries (1-2 tokens) with an anchor -> short_entity.
    const tokenCount = normalizedQuery.split(/\s+/).length;
    if (tokenCount <= 2 && anchors.length > 0) {
      // Multiple candidate entities for a short query -> ambiguous.
      const totalCandidates = anchors.reduce(
        (sum, a) => sum + a.candidateEntityIds.length,
        0,
      );
      if (
        totalCandidates > 1
        && anchors.some((a) => a.confidence < SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD)
      ) {
        return 'ambiguous_short_form';
      }
      return 'short_entity';
    }

    switch (intent) {
      case 'entity_exact':
      case 'entity_fuzzy':
        return 'short_entity';
      case 'comparison_search':
        return 'comparison_query';
      case 'mixed_query':
        return 'anchored_similarity';
      case 'facet_search':
      case 'budget_search':
        return 'pure_constraint';
      case 'semantic_discovery':
      case 'pairing_search':
        return 'semantic_preference';
      default:
        return 'unknown';
    }
  }

  /**
   * Attributes whose constraints are treated as soft (preference-level).
   *
   * NL-phrase-derived wine sensory attributes (body, sweetness, acidity, tannin,
   * style) are soft because they express user preferences from natural language.
   * Hard constraints are reserved for explicit API-level mandatory filters.
   * price_band and occasion are also soft — they guide ranking rather than
   * absolutely excluding candidates.
   */
  private static readonly SOFT_ATTRIBUTES = SOFT_CONSTRAINT_ATTRIBUTES;

  /**
  /**
   * Parses constraints from the normalized query by scanning for known
   * natural-language phrases via the NLMapper.
   *
   * Generates token n-grams (up to {@link MAX_NGRAM_TOKENS} tokens) from the
   * query and probes each against the mapping table. Matched constraints are
   * classified as hard (body, sweetness, etc.) or soft (price_band, occasion).
   */
  /**
   * Adds soft `pairing` constraints from the pairing taxonomy when the query
   * mentions foods or occasions (e.g. salmon → pairing tag for retrieval).
   */
  private mergePairingIntoBundle(
    bundle: ConstraintBundle,
    normalizedQuery: string,
  ): ConstraintBundle {
    const tags = extractAllPairingConstraints(normalizedQuery);
    if (tags.length === 0) {
      return bundle;
    }
    const extraSoft: NormalizedConstraint[] = tags.map((tag) => ({
      attribute: 'pairing',
      operator: 'in',
      value: [tag],
      source_phrase: normalizedQuery,
      confidence: PAIRING_SOFT_CONSTRAINT_CONFIDENCE,
    }));
    return {
      hard: bundle.hard,
      soft: [...bundle.soft, ...extraSoft],
      inferred: bundle.inferred,
    };
  }

  private async parseConstraints(
    normalizedQuery: string,
    intent: QueryIntent,
    abortSignal?: AbortSignal,
  ): Promise<{
    readonly bundle: ConstraintBundle;
    readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
  }> {
    // RFC-019 Stage 1: Span-based parsing (replaces naive n-gram loop).
    // Preserves character positions for downstream overlap resolution.
    const spans = parseSpans(normalizedQuery);
    const candidatePhrases = spans.map((s) => s.text);

    const mapped = await this.nlMapper.mapConstraints(
      candidatePhrases,
      abortSignal !== undefined ? { abortSignal } : undefined,
    );
    const matched = mapped.constraints;
    const mapperTrace = mapped.constraintExtraction;

    const hard: ConstraintBundle['hard'][number][] = [];
    const soft: ConstraintBundle['soft'][number][] = [];

    for (const constraint of matched) {
      const isLlmSourced =
        (constraint.mapping_version?.startsWith('llm-') ?? false)
        || constraint.source_phrase.startsWith('llm_linker(');
      if (isLlmSourced || Planner.SOFT_ATTRIBUTES.has(constraint.attribute)) {
        soft.push(constraint);
      } else {
        hard.push(constraint);
      }
    }

    // RFC-019 Tier 2: Entity Resolver — augments Tier 1 (NLMapper) by resolving
    // spans that symbolic lookup didn't cover. Part of the 6-tier deterministic
    // cascade pipeline, NOT a fallback. Resolves aliases via the unified
    // canonical registry. Applied only to spans NOT already covered by a
    // NLMapper hit, preventing double-counting.
    //
    // Longest-match priority: resolveOverlaps ensures "cabernet sauvignon"
    // wins over both "cabernet" and "sauvignon" when all three match.
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
      const preferredEntity = resolveEntity(span.text, { preferEntityOverStyle: true });
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

    let resolvedEntityCount = 0;

    for (const { resolved } of resolvedNonOverlap) {
      resolvedEntityCount++;
      const constraint = {
        attribute: resolved.entity.entityType,
        operator: '=' as const,
        value: resolved.entity.canonicalValue,
        source_phrase: resolved.kind === 'shadow'
          ? `entity_shadow(${resolved.entity.matchedSurface})`
          : `entity_resolver(${resolved.entity.matchedSurface})`,
        confidence: resolved.entity.confidence,
        mapping_version: `entity-resolver-v1.0`,
      };
      if (Planner.SOFT_ATTRIBUTES.has(resolved.entity.entityType)) {
        soft.push(constraint);
      } else {
        hard.push(constraint);
      }
    }

    const tier12Empty = hard.length === 0 && soft.length === 0;
    // Tier 6: regex/rule extractor contributes numeric, exclusion, and fallback
    // constraints even when Tier 1/2 already found entity constraints.
    const tier6Bundle = extractRuleBasedConstraints(normalizedQuery);
    const tier6AddedCount = mergeConstraintBundleIntoLists(
      tier6Bundle,
      hard,
      soft,
    );

    // If all earlier tiers still produced zero constraints, Tier 6 is the sole
    // contributor and must still flow through ontology + composition.
    if (tier12Empty) {
      // RFC-019 Stage 3+5: Apply ontology expansion and compositional inference
      // on the Tier 6 bundle too, so inferred constraints are populated
      // consistently across all paths.
      const ontologyExpanded = expandWithOntology(tier6Bundle);
      const expanded = applyCompositionalInference(
        ontologyExpanded,
        { impliedWineType: inferComparisonImpliedWineType(ontologyExpanded, normalizedQuery) },
      );
      const constraintExtraction = buildPlannerConstraintExtractionTrace({
        baseTrace: mapperTrace,
        spans,
        matched,
        resolvedEntityCount,
        finalBundle: expanded,
        ontologyAddedCount:
          countBundleConstraints(ontologyExpanded) - countBundleConstraints(tier6Bundle),
        compositionalAddedCount:
          countBundleConstraints(expanded) - countBundleConstraints(ontologyExpanded),
        tier6ConstraintCount: tier6AddedCount,
        unresolvedSpanCount: countUnresolvedSpans(spans, coveredPhrases, resolvedNonOverlap),
        unresolvedSpanSamples: collectUnresolvedSpanSamples(spans, coveredPhrases, resolvedNonOverlap),
      });
      return {
        bundle: expanded,
        ...(constraintExtraction !== undefined ? { constraintExtraction } : {}),
      };
    }

    // RFC-019 Stage 3: Ontology expansion — derive soft/inferred constraints
    // from region/appellation ancestors (e.g. region=Pauillac → country=France).
    const baseBundle: ConstraintBundle = { hard, soft, inferred: [] };
    const expanded = expandWithOntology(baseBundle);

    // RFC-019 Stage 5: Compositional inference — apply composition rules
    // (region + wine_type → structure prior) to populate inferred bundle.
    const finalBundle = applyCompositionalInference(
      expanded,
      {
        impliedWineType:
          intent === 'comparison_search'
            ? inferComparisonImpliedWineType(expanded, normalizedQuery)
            : undefined,
      },
    );
    const constraintExtraction = buildPlannerConstraintExtractionTrace({
      baseTrace: mapperTrace,
      spans,
      matched,
      resolvedEntityCount,
      finalBundle,
      ontologyAddedCount: countBundleConstraints(expanded) - countBundleConstraints(baseBundle),
      compositionalAddedCount: countBundleConstraints(finalBundle) - countBundleConstraints(expanded),
      tier6ConstraintCount: tier6AddedCount,
      unresolvedSpanCount: countUnresolvedSpans(spans, coveredPhrases, resolvedNonOverlap),
      unresolvedSpanSamples: collectUnresolvedSpanSamples(spans, coveredPhrases, resolvedNonOverlap),
    });

    return {
      bundle: finalBundle,
      ...(constraintExtraction !== undefined ? { constraintExtraction } : {}),
    };
  }

  /**
   * Computes the uncertainty assessment for the query.
   */
  private async computeUncertainty(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
    constraints: ConstraintBundle,
  ): Promise<QueryUncertainty> {
    // Parser confidence: higher for shorter, cleaner queries.
    const tokenCount = normalizedQuery.split(/\s+/).length;
    const parserConfidence = Math.max(
      UNCERTAINTY_PARSER_CONFIDENCE_FLOOR,
      Math.min(
        1.0,
        1.0 - tokenCount * UNCERTAINTY_PARSER_CONFIDENCE_PER_TOKEN_PENALTY,
      ),
    );

    // Anchor confidence: max anchor confidence, or 0 if no anchors.
    // Loop instead of Math.max(...spread) to avoid stack overflow on large anchor sets.
    let anchorConfidence = 0;
    for (const a of anchors) {
      if (a.confidence > anchorConfidence) anchorConfidence = a.confidence;
    }

    // Constraint confidence: based on number of extracted constraints.
    const totalConstraints =
      constraints.hard.length + constraints.soft.length + constraints.inferred.length;
    const constraintConfidence =
      totalConstraints > 0
        ? Math.min(
            1.0,
            constraints.hard.reduce((s, c) => s + c.confidence, 0) /
              Math.max(1, constraints.hard.length),
          )
        : UNCERTAINTY_CONSTRAINT_CONFIDENCE_NEUTRAL;

    // Detect ambiguity from anchors and dictionary.
    const ambiguityTypes: string[] = [];
    let ambiguitySeverity: QueryUncertainty['ambiguitySeverity'] = 'low';

    // Check whether the full normalized query is a known ambiguous form.
    const fullQueryInfo =
      await this.ambiguityDict.getAmbiguityInfo(normalizedQuery);
    if (fullQueryInfo !== null) {
      ambiguityTypes.push(...fullQueryInfo.types);
      // Escalate severity: high always wins; medium wins unless already high.
      const currentSeverity: string = ambiguitySeverity;
      if (
        fullQueryInfo.severity === 'high' ||
        (fullQueryInfo.severity === 'medium' && currentSeverity !== 'high')
      ) {
        ambiguitySeverity = fullQueryInfo.severity;
      }
    }

    for (const anchor of anchors) {
      // Multiple candidate entities -> ambiguous.
      if (anchor.candidateEntityIds.length > 1) {
        ambiguityTypes.push('multiple_candidates');
      }

      // Check ambiguity dictionary.
      const info = await this.ambiguityDict.getAmbiguityInfo(
        anchor.normalizedForm,
      );
      if (info !== null) {
        ambiguityTypes.push(...info.types);
        if (
          info.severity === 'high' ||
          (info.severity === 'medium' && ambiguitySeverity !== 'high')
        ) {
          ambiguitySeverity = info.severity;
        }
      }
    }

    // Low anchor confidence with anchors present -> ambiguity.
    if (anchors.length > 0 && anchorConfidence < UNCERTAINTY_LOW_ANCHOR_CONFIDENCE_THRESHOLD) {
      ambiguityTypes.push('low_anchor_confidence');
      if (ambiguitySeverity === 'low') {
        ambiguitySeverity = 'medium';
      }
    }

    const ambiguityDetected = ambiguityTypes.length > 0;

    // Overall uncertainty: weighted combination.
    const overall = Math.min(
      1.0,
      Math.max(
        0.0,
        1.0
          - UNCERTAINTY_OVERALL_WEIGHT_PARSER * parserConfidence
          - UNCERTAINTY_OVERALL_WEIGHT_ANCHOR * anchorConfidence
          - UNCERTAINTY_OVERALL_WEIGHT_CONSTRAINT * constraintConfidence
          + (ambiguityDetected ? UNCERTAINTY_AMBIGUITY_OVERALL_BUMP : 0),
      ),
    );

    // Decision effect based on severity.
    let decisionEffect: QueryUncertainty['decisionEffect'];
    if (ambiguitySeverity === 'high') {
      decisionEffect = 'force_clarify';
    } else if (ambiguitySeverity === 'medium' || overall >= UNCERTAINTY_RAISE_THRESHOLD_OVERALL) {
      decisionEffect = 'raise_threshold';
    } else if (ambiguityDetected) {
      decisionEffect = 'trace_only';
    } else {
      decisionEffect = 'trace_only';
    }

    return {
      overall,
      ambiguityDetected,
      ambiguityTypes,
      ambiguitySeverity,
      decisionEffect,
      parserConfidence,
      anchorConfidence,
      constraintConfidence,
    };
  }

  /**
   * Infers the target entity type that the query targets (Epic 8).
   *
   * Inference rules (in priority order):
   * 1. If intent is 'facet_search' or 'semantic_discovery' with only style constraints → 'style'
   * 2. If anchor present and explicit vintage year in query → 'wine'
   * 3. If anchor present and no vintage, no wine-specific terms → likely 'producer'
   * 4. If region keywords present → 'region'
   * 5. Otherwise → 'unknown' (let retrieval strategy decide)
   *
   * Returns undefined to signal "no clear target type detected" (applies default strategy).
   */
  private inferTargetEntityType(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
    constraints: ConstraintBundle,
    intent: QueryIntent,
  ): QueryTargetType | undefined {
    // Check for style-only constraints (no hard constraints about wine type or vintage).
    const hasOnlyStyleConstraints =
      constraints.hard.length === 0 &&
      constraints.soft.every((c) =>
        ['body', 'sweetness', 'acidity', 'tannin', 'style'].includes(c.attribute),
      );

    // If semantic discovery or facet search with only style constraints → 'style'
    if (
      (intent === 'semantic_discovery' || intent === 'facet_search') &&
      hasOnlyStyleConstraints &&
      anchors.length === 0
    ) {
      return 'style';
    }

    // Check for explicit vintage year in query (e.g., "Margaux 2015").
    const hasVintageYear = VINTAGE_YEAR_PATTERN.test(normalizedQuery);

    // If anchor and vintage year present → wine
    if (anchors.length > 0 && hasVintageYear) {
      return 'wine';
    }

    // Check for region keywords.
    const hasRegionKeyword = REGION_KEYWORDS.some((re) =>
      re.test(normalizedQuery),
    );
    if (hasRegionKeyword) {
      return 'region';
    }

    // If anchor but no vintage, no wine-specific terms → likely producer.
    // This covers queries like "안티노리" (Antinori) where we want producer set, not wine set.
    if (anchors.length > 0 && !hasVintageYear) {
      // Check for explicit wine type constraint (which would indicate wine query).
      const hasWineTypeConstraint = constraints.hard.some(
        (c) => c.attribute === 'wine_type',
      );
      if (!hasWineTypeConstraint) {
        return 'producer';
      }
    }

    // No clear signal detected.
    return undefined;
  }
}

function countBundleConstraints(bundle: ConstraintBundle): number {
  return bundle.hard.length + bundle.soft.length + bundle.inferred.length;
}

function constraintKey(constraint: NormalizedConstraint): string {
  return `${constraint.attribute}|${constraint.operator}|${JSON.stringify(constraint.value)}`;
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
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    hard.push(constraint);
    added++;
  }
  for (const constraint of bundle.soft) {
    const key = constraintKey(constraint);
    if (existing.has(key)) {
      continue;
    }
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

function buildPlannerConstraintExtractionTrace(args: {
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
