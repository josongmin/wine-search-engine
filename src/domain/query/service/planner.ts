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
import { STYLE_SENSORY_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../model/threshold-profile.js';
import type { AmbiguityDictionary } from '../port/ambiguity-dictionary.port.js';
import type { FuzzyMatcherPort } from '../port/fuzzy-matcher.port.js';
import { type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { type NLMapper } from '../../attribute/service/nl-mapper.js';
import { ConstraintCompiler, type ConstraintCompilerResult } from './constraint-compiler.js';
import { hasVintageYear as hasBoundedVintageYear } from '../../shared/utils/vintage.js';
import type { RequestExecutionContext } from '../../shared/request-execution-context.js';
import { QueryNormalizer } from './query-normalizer.js';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  detectQueryIntent,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import { analyzeQueryDecomposition } from './decomposition-detector.js';
import { extractAllPairingConstraints } from './pairing-extractor.js';
import { correctKoreanWineTypos } from './korean-wine-aliases.js';
import type { PolicyDecisionRecord, PlannerStage } from '../model/policy-decision-record.js';

/** Current planner version. */
const PLANNER_VERSION = '1.0.0';

/**
 * TA2-T2: Minimum confidence floor for planner_heuristic anchors.
 * Fuzzy matches at maximum edit distance would otherwise get confidence 0;
 * clamp to this floor so they still contribute signal to the resolver.
 */
const FUZZY_ANCHOR_CONFIDENCE_FLOOR = 0.5;

/**
 * TA2-T2: Confidence penalty per unit of edit distance for planner_heuristic anchors.
 * A fuzzy hit with editDistance=1 → confidence × 0.9 (10% discount).
 * A fuzzy hit with editDistance=5 → confidence × 0.5 (clamped at floor).
 */
const FUZZY_ANCHOR_EDIT_DISTANCE_PENALTY = 0.1;

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

// Vintage detection delegates to the vintage SSoT
// (`@domain/shared/utils/vintage`).

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
  /**
   * E3: Enable planner policy trace (QueryPlanV2.plannerTrace).
   *
   * Opt-in only — trace allocation is non-trivial for high-QPS hot paths.
   * Set to true when the request carries an explain=true flag or a debug
   * header. Absent / false → plannerTrace is omitted from the plan.
   */
  readonly enablePlannerTrace?: boolean | undefined;
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
  private readonly constraintCompiler: ConstraintCompiler;

  constructor(
    private readonly ambiguityDict: AmbiguityDictionary,
    private readonly anchorExtractor: AnchorExtractor,
    private readonly expansionBuilder: ExpansionBuilder,
    nlMapper: NLMapper,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
  ) {
    this.constraintCompiler = new ConstraintCompiler(nlMapper, fuzzyMatcher);
  }

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
    return this.materializeQueryPlan(safeQuery, query, context);
  }

  /**
   * Runs normalization, routing, constraint parsing, expansions, and uncertainty
   * for a length-capped query surface.
   *
   * @param safeQuery - Possibly truncated query string for NLP/regex work.
   * @param originalQuery - Full client query for diagnostics and raw plan fields.
   */
  private async materializeQueryPlan(
    safeQuery: string,
    originalQuery: string,
    context?: PlannerContext,
  ): Promise<QueryPlanV2> {
    // 1. Normalize + Korean typo correction.
    const typoFixed = correctKoreanWineTypos(safeQuery);
    const queryViews = this.queryNormalizer.normalize(typoFixed);
    const normalizedQuery = queryViews.accentless;

    // E3: planner policy trace — opt-in only (context.enablePlannerTrace === true).
    // Absent on the hot path to avoid allocation overhead on high-QPS requests.
    // Enable via explain=true request flag or X-Debug-Key header.
    const tracingEnabled = context?.enablePlannerTrace === true;
    const plannerTrace: PolicyDecisionRecord[] = [];

    // 2. Extract anchors.
    const anchors = await this.anchorExtractor.extract(normalizedQuery, queryViews);

    // 2b. Fuzzy-match fallback: when anchor extraction finds nothing, try
    //     approximate matching against the known-term index.
    //
    //     TA2-T2: fuzzy hits are promoted to AnchorCandidates with
    //     source: 'planner_heuristic' so the resolver can score them on the
    //     entity-similarity path instead of treating the query as purely semantic.
    //     Each fuzzy term is re-looked up via the aliasMatcher to get entity IDs.
    let fuzzyExpansions: readonly string[] = [];
    let fuzzyAnchors: readonly AnchorCandidate[] = [];
    if (anchors.length === 0 && this.fuzzyMatcher !== undefined) {
      const fuzzyHits = this.fuzzyMatcher.match(normalizedQuery);
      fuzzyExpansions = fuzzyHits.map((h) => h.term);

      // Resolve entity IDs for each fuzzy term via the anchor extractor.
      // Use allSettled to avoid a single lookup failure blocking all others.
      const anchorResults = await Promise.allSettled(
        fuzzyHits.map(async (hit) => {
          const matches = await this.anchorExtractor.lookupForFuzzyTerm(hit.term);
          return { hit, matches };
        }),
      );

      const heuristicCandidates: AnchorCandidate[] = [];
      for (const result of anchorResults) {
        if (result.status !== 'fulfilled') continue;
        const { hit, matches } = result.value;
        for (const match of matches) {
          if (match.entityIds.length === 0) continue;
          heuristicCandidates.push({
            surfaceForm: match.surfaceForm,
            normalizedForm: match.normalizedForm,
            candidateEntityIds: match.entityIds,
            lookupVariants: [hit.term],
            lookupStrategies: ['fuzzy_char_ngram'],
            // Confidence discounted by edit distance: further edit distance → lower confidence.
            // Floor at FUZZY_ANCHOR_CONFIDENCE_FLOOR so deep edits still contribute signal.
            confidence: match.matchConfidence * Math.max(
              FUZZY_ANCHOR_CONFIDENCE_FLOOR,
              1 - hit.editDistance * FUZZY_ANCHOR_EDIT_DISTANCE_PENALTY,
            ),
            source: 'planner_heuristic' as const,
          });
        }
      }
      fuzzyAnchors = heuristicCandidates;
    }

    // Merge planner_heuristic anchors into the anchor list.
    // These carry lower confidence than exact alias anchors but provide entity
    // ID resolution that pure lexical expansions cannot supply.
    const allAnchors: readonly AnchorCandidate[] =
      fuzzyAnchors.length > 0 ? [...anchors, ...fuzzyAnchors] : anchors;

    // 3. Detect intent.
    const intent = detectQueryIntent(
      normalizedQuery,
      anchors,
      this.anchorExtractor,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'intent_classification',
        { normalizedQuery, anchorCount: anchors.length },
        [{ ruleId: 'intent.detected', description: 'Intent detected via detectQueryIntent', inputsMatched: { normalizedQuery }, outcome: intent }],
        [],
        intent,
        1.0,
      ));
    }

    // 4. Determine route.
    const route = this.determineRoute(intent, anchors);
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'route_resolution',
        { intent, anchorCount: anchors.length },
        [{ ruleId: 'route.resolved', description: 'Route resolved via determineRoute', inputsMatched: { intent, anchorCount: anchors.length }, outcome: route }],
        [],
        route,
        1.0,
      ));
    }

    // 5. Determine retrieval mode.
    const retrievalMode = this.determineRetrievalMode(
      intent,
      anchors,
      normalizedQuery,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'retrieval_mode_selection',
        { intent, anchorCount: anchors.length, normalizedQuery },
        [{ ruleId: 'retrieval_mode.resolved', description: 'Mode resolved via determineRetrievalMode', inputsMatched: { intent }, outcome: retrievalMode }],
        [],
        retrievalMode,
        1.0,
      ));
    }

    // 6. Determine query class.
    const queryClass = await this.determineQueryClass(
      normalizedQuery,
      intent,
      anchors,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'query_class_classification',
        { normalizedQuery, intent, anchorCount: anchors.length },
        [{ ruleId: 'query_class.classified', description: 'Query class classified via determineQueryClass', inputsMatched: { intent }, outcome: queryClass }],
        [],
        queryClass,
        1.0,
      ));
    }

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
    // TA4: also surface fuzzy hits as entity hypothesis sources in
    // fuzzyEntityHypotheses, enabling the entity-first dual retrieval path
    // even when exact anchor extraction fails (anchor count === 0).
    const expansions =
      fuzzyExpansions.length > 0
        ? {
            ...baseExpansions,
            lexical: [...baseExpansions.lexical, ...fuzzyExpansions],
            fuzzyEntityHypotheses: fuzzyExpansions,
          }
        : baseExpansions;

    // 8. Compute uncertainty.
    const uncertainty = await this.computeUncertainty(
      normalizedQuery,
      anchors,
      constraints,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'uncertainty_estimation',
        { normalizedQuery, anchorCount: anchors.length, constraintCount: constraints.hard.length + constraints.soft.length + constraints.inferred.length },
        [{ ruleId: 'uncertainty.computed', description: 'Uncertainty computed via computeUncertainty', inputsMatched: { anchorCount: anchors.length }, outcome: String(uncertainty.overall) }],
        [],
        String(uncertainty.overall),
        1.0 - uncertainty.overall,
      ));
    }

    const budget = context?.budget ?? DEFAULT_QUERY_BUDGET;

    // 10. Infer target entity type for result grouping (Epic 8).
    const targetEntityType = this.inferTargetEntityType(
      normalizedQuery,
      anchors,
      constraints,
      intent,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'target_entity_inference',
        { normalizedQuery, intent, anchorCount: anchors.length },
        targetEntityType != null
          ? [{ ruleId: 'target_entity.inferred', description: 'Target entity type inferred', inputsMatched: { intent }, outcome: targetEntityType }]
          : [],
        targetEntityType == null
          ? [{ ruleId: 'target_entity.none', description: 'No target entity type could be inferred', failedCondition: 'No matching entity type signals' }]
          : [],
        targetEntityType ?? 'none',
        targetEntityType != null ? 1.0 : 0.0,
      ));
    }

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
    const decompositionHint = analyzeQueryDecomposition(originalQuery).hint;

    return {
      rawQuery: originalQuery,
      normalizedQuery,
      normalizedQueryViews: queryViews,
      intent,
      ...(secondaryIntents !== undefined && { secondaryIntents }),
      suggestedRoute: route,
      suggestedRetrievalMode: retrievalMode,
      queryClass,
      // TA2-T2: Include planner_heuristic anchors from fuzzy-match fallback.
      // allAnchors = exact alias anchors + fuzzy heuristic anchors (when present).
      anchors: allAnchors,
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
      retrievalPlan: parsed.retrievalPlan,
      // E2-T3: Expose conflict-resolved ConstraintAtoms from reasoner for ranker + safety consumers.
      constraintAtoms: parsed.reasonerOutput.atoms,
      ...(plannerTrace.length > 0 ? { plannerTrace } : {}),
    };
  }

  /**
   * Determines the query route based on intent and anchors.
   *
   * RCA5-02 fix: `mixed_query` without any anchor must route to `'hybrid'`,
   * not `'mixed'`. The `'mixed'` route requires an anchor to perform the
   * anchor-similarity pass; without one, the execution layer falls through to
   * a plain hybrid search anyway, but the plan advertises 'mixed' — causing
   * route/mode mismatch where mode='attribute_search' but route='mixed'.
   * Aligning route to 'hybrid' when no anchor is present makes the plan
   * internally consistent: `determineRetrievalMode` already maps
   * `mixed_query + !hasAnyAnchor → 'attribute_search'` (hybrid strategy).
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
        // Only route to 'mixed' when an anchor exists — 'mixed' requires anchor
        // evidence for the similarity pass (RFC-005 §3.3, RCA5-02).
        return anchors.some((a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE)
          ? 'mixed'
          : 'hybrid';
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
    // Guard: "".split(/\s+/) returns [''] (length 1, not 0); trim+filter removes empty tokens.
    const tokenCount = normalizedQuery.trim().length === 0
      ? 0
      : normalizedQuery.trim().split(/\s+/).length;
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
    _intent: QueryIntent,
    abortSignal?: AbortSignal,
  ): Promise<ConstraintCompilerResult> {
    return this.constraintCompiler.compile(normalizedQuery, abortSignal);
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
    // Guard: "".split(/\s+/) → [''] (length 1); use trimmed token count to avoid
    // inflating confidence for empty/whitespace-only queries.
    const tokenCount = normalizedQuery.trim().length === 0
      ? 0
      : normalizedQuery.trim().split(/\s+/).length;
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

    // Constraint confidence: average confidence across ALL extracted constraints.
    // BUG-P2 fix: was `totalConstraints > 0` but then only averaged hard constraints.
    // If 0 hard constraints but N soft constraints exist, hard.length=0 caused division
    // by Max(1,0)=1 → 0/1=0 confidence, or neutral for total=0. Both wrong.
    // Correct: average across hard+soft+inferred so queries with only soft constraints
    // (e.g. "떫은 와인" — style only) get meaningful confidence, not neutral.
    const allConstraints = [
      ...constraints.hard,
      ...constraints.soft,
      ...constraints.inferred,
    ];
    const constraintConfidence =
      allConstraints.length > 0
        ? Math.min(
            1.0,
            allConstraints.reduce((s, c) => s + c.confidence, 0) / allConstraints.length,
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
      constraints.soft.every((c) => STYLE_SENSORY_ATTRIBUTES.has(c.attribute));

    // If semantic discovery or facet search with only style constraints → 'style'
    if (
      (intent === 'semantic_discovery' || intent === 'facet_search') &&
      hasOnlyStyleConstraints &&
      anchors.length === 0
    ) {
      return 'style';
    }

    // Check for explicit vintage year in query (e.g., "Margaux 2015").
    const hasVintageYearInQuery = hasBoundedVintageYear(normalizedQuery);

    // If anchor and vintage year present → wine
    if (anchors.length > 0 && hasVintageYearInQuery) {
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
    if (anchors.length > 0 && !hasVintageYearInQuery) {
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

/** Build a PolicyDecisionRecord for a planner decision stage. */
function buildDecisionRecord(
  stage: PlannerStage,
  inputFacts: Record<string, unknown>,
  rulesEvaluated: PolicyDecisionRecord['rulesEvaluated'],
  rejectedBranches: PolicyDecisionRecord['rejectedBranches'],
  decision: string,
  confidence: number,
  durationMs?: number,
): PolicyDecisionRecord {
  return {
    stage,
    inputFacts,
    rulesEvaluated,
    rejectedBranches,
    decision,
    confidence,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
