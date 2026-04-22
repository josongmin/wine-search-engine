import type {
  QueryClass,
  ConstraintBundle,
  ConstraintAtom,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import { liftBundleToAtoms } from '../../shared/types/index.js';
import type { QueryPlanV2 } from '../model/query-plan.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
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
import { type AliasMatchResult, type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { type NLMapper } from '../../attribute/service/nl-mapper.js';
import { ConstraintCompiler, type ConstraintCompilerResult } from './constraint-compiler.js';
import type { ConstraintTopologyPlanner } from './constraint-topology-planner.js';
import { hasVintageYear as hasBoundedVintageYear } from '../../shared/utils/vintage.js';
import type { RequestExecutionContext } from '../../shared/request-execution-context.js';
import type { AmbiguousEntityHint } from '../../attribute/model/ambiguous-entity-hint.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import { isDirectEntityResolution, resolveEntity } from '../../attribute/service/entity-resolver.js';
import { QueryNormalizer } from './query-normalizer.js';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  detectQueryIntent,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import { analyzeQueryDecomposition } from './decomposition-detector.js';
import { extractAllPairingConstraints } from './pairing-extractor.js';
import { correctKoreanWineTypos } from './korean-wine-aliases.js';
import {
  hasEntityMetadataKeyword,
  stripExactEntityMetadataSuffix,
} from './exact-entity-metadata-signals.js';
import type { PolicyDecisionRecord, PlannerStage } from '../model/policy-decision-record.js';
import { buildBundleFromAtoms } from './constraint-reasoner.js';
import { buildRetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../retrieval/model/retrieval-objective.js';
import {
  AmbiguityIntentCompiler,
  type AmbiguityIntentCompilerInput,
} from './ambiguity-intent-compiler.js';
import type {
  AmbiguityIntentInterpretation,
  AmbiguityIntentTrace,
} from '../model/ambiguity-intent-interpretation.js';

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

function hasDirectResolvableAttributeEntity(normalizedQuery: string): boolean {
  return parseSpans(normalizedQuery).some((span) => {
    const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
    return isDirectEntityResolution(resolved) && resolved.entityType !== 'wine_type';
  });
}

const KOREAN_NOT_MARKER_PATTERN = '\\s*(?:말고|대신)\\s*';
const ENGLISH_NOT_MARKER_PATTERN = '(?<!\\p{L})(?<!\\p{N})instead\\s+of\\s+';

const EMPTY_FALLBACK_MAPPER: NLMapper = {
  mapPhrase: async () => null,
  mapConstraints: async (phrases: readonly string[]) => ({
    constraints: [],
    constraintExtraction: {
      candidatePhraseCount: phrases.length,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback',
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [],
      fallbackReason: 'nlmapper_exception',
    },
  }),
} as unknown as NLMapper;

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
  private readonly fallbackConstraintCompiler: ConstraintCompiler;

  constructor(
    private readonly ambiguityDict: AmbiguityDictionary,
    private readonly anchorExtractor: AnchorExtractor,
    private readonly expansionBuilder: ExpansionBuilder,
    nlMapper: NLMapper,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
    topologyPlanner?: ConstraintTopologyPlanner,
    private readonly ambiguityIntentCompiler?: AmbiguityIntentCompiler,
  ) {
    this.constraintCompiler = new ConstraintCompiler(
      nlMapper,
      fuzzyMatcher,
      topologyPlanner,
    );
    this.fallbackConstraintCompiler = new ConstraintCompiler(
      EMPTY_FALLBACK_MAPPER,
      fuzzyMatcher,
      topologyPlanner,
    );
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
    const stageTimer = context?.stageTimer;
    // 1. Normalize + Korean typo correction.
    const typoFixed = correctKoreanWineTypos(safeQuery);
    const queryViews = this.queryNormalizer.normalize(typoFixed);
    const normalizedQuery = queryViews.accentless;
    const metadataSafeQuery = hasEntityMetadataKeyword(normalizedQuery)
      ? stripExactEntityMetadataSuffix(typoFixed)
      : typoFixed;
    const metadataSafeQueryViews = this.queryNormalizer.normalize(metadataSafeQuery);
    const plannerSurfaceViews = metadataSafeQuery.trim().length > 0 ? metadataSafeQueryViews : queryViews;
    const plannerSurfaceNormalized = plannerSurfaceViews.accentless;

    // E3: planner policy trace — opt-in only (context.enablePlannerTrace === true).
    // Absent on the hot path to avoid allocation overhead on high-QPS requests.
    // Enable via explain=true request flag or X-Debug-Key header.
    const tracingEnabled = context?.enablePlannerTrace === true;
    const plannerTrace: PolicyDecisionRecord[] = [];

    // 2. Extract anchors.
    stageTimer?.start('planner.anchor_extraction');
    const { anchors, relativeQuery } = await this.anchorExtractor.extractWithRelative(
      plannerSurfaceNormalized,
      plannerSurfaceViews,
    ).finally(() => {
      stageTimer?.end('planner.anchor_extraction');
    });

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
      const fuzzyHits = this.fuzzyMatcher.match(plannerSurfaceNormalized);
      fuzzyExpansions = fuzzyHits.map((h) => h.term);
      const fuzzyLookupTerms = Array.from(
        new Set(
          fuzzyHits
            .map((hit) => hit.term.trim())
            .filter((term) => term.length > 0),
        ),
      );
      const fuzzyMatchMap = fuzzyLookupTerms.length > 0
        ? await (async () => {
          stageTimer?.start('planner.fuzzy_anchor_lookup');
          try {
            return await this.anchorExtractor.lookupForFuzzyTerms(fuzzyLookupTerms);
          } finally {
            stageTimer?.end('planner.fuzzy_anchor_lookup');
          }
        })()
        : new Map<string, readonly AliasMatchResult[]>();

      // Resolve entity IDs for each fuzzy term via the anchor extractor.
      const anchorResults = fuzzyHits.map((hit) => {
        const matches = fuzzyMatchMap.get(hit.term.trim()) ?? [];
        return { hit, matches };
      });

      const heuristicCandidates: AnchorCandidate[] = [];
      for (const result of anchorResults) {
        const { hit, matches } = result;
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
      allAnchors,
      this.anchorExtractor,
      relativeQuery,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'intent_classification',
        { normalizedQuery, anchorCount: allAnchors.length },
        [{ ruleId: 'intent.detected', description: 'Intent detected via detectQueryIntent', inputsMatched: { normalizedQuery }, outcome: intent }],
        [],
        intent,
        1.0,
      ));
    }

    // 4. Determine route.
    const route = this.determineRoute(intent, allAnchors);
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'route_resolution',
        { intent, anchorCount: allAnchors.length },
        [{ ruleId: 'route.resolved', description: 'Route resolved via determineRoute', inputsMatched: { intent, anchorCount: allAnchors.length }, outcome: route }],
        [],
        route,
        1.0,
      ));
    }

    // 5. Determine retrieval mode.
    const retrievalMode = this.determineRetrievalMode(
      intent,
      allAnchors,
      plannerSurfaceNormalized,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'retrieval_mode_selection',
        { intent, anchorCount: allAnchors.length, normalizedQuery },
        [{ ruleId: 'retrieval_mode.resolved', description: 'Mode resolved via determineRetrievalMode', inputsMatched: { intent }, outcome: retrievalMode }],
        [],
        retrievalMode,
        1.0,
      ));
    }

    const queryClassPromise = (async () => {
      stageTimer?.start('planner.query_class');
      try {
        return await this.determineQueryClass(plannerSurfaceNormalized, intent, allAnchors);
      } finally {
        stageTimer?.end('planner.query_class');
      }
    })();

    // 6. Parse constraints (NL + rule-based) and attach food-pairing tags (Epic 12).
    const constraintQuery = this.buildConstraintParsingQuery(
      plannerSurfaceNormalized,
      allAnchors,
      relativeQuery,
      intent,
    );
    const parsedPromise = (async () => {
      stageTimer?.start('planner.constraint_parsing');
      try {
        return await this.parseConstraints(
          constraintQuery,
          intent,
          context?.abortSignal,
        );
      } finally {
        stageTimer?.end('planner.constraint_parsing');
      }
    })();

    const [classifiedQueryClass, parsed] = await Promise.all([
      queryClassPromise,
      parsedPromise,
    ]);
    stageTimer?.start('planner.ambiguity_intent_compilation');
    const ambiguityIntentResult = await this.compileAmbiguityIntent({
      rawQuery: originalQuery,
      normalizedQuery: plannerSurfaceNormalized,
      intent,
      classifiedQueryClass,
      parsed,
      abortSignal: context?.abortSignal,
    }).finally(() => {
      stageTimer?.end('planner.ambiguity_intent_compilation');
    });
    const interpretedAmbiguousHints = applyAmbiguityIntentInterpretation(
      parsed.ambiguousEntityHints,
      ambiguityIntentResult.interpretation,
    );
    const queryClass = this.promoteQueryClassFromConstraintEvidence(
      classifiedQueryClass,
      interpretedAmbiguousHints,
      ambiguityIntentResult.interpretation,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'query_class_classification',
        { normalizedQuery, intent, anchorCount: allAnchors.length },
        [{ ruleId: 'query_class.classified', description: 'Query class classified via determineQueryClass', inputsMatched: { intent }, outcome: queryClass }],
        [],
        queryClass,
        1.0,
      ));
    }

    const mergedConstraints = this.mergePairingIntoBundle(
      buildBundleFromAtoms(parsed.reasonerOutput.survivingAtoms),
      normalizedQuery,
    );
    const mergedConstraintAtoms = liftBundleToAtoms(mergedConstraints);
    const roleTypedAtoms = this.contextualizeConstraintAtoms(
      mergedConstraintAtoms,
      intent,
    );
    const constraints = buildBundleFromAtoms(roleTypedAtoms);
    const retrievalPlan = buildRetrievalPlan(constraints);
    const retrievalObjective = buildRetrievalObjective(constraints);

    // 7. Build expansions.
    const baseExpansions = this.expansionBuilder.build(
      plannerSurfaceNormalized,
      intent,
      allAnchors,
    );

    // Merge fuzzy-match results into lexical expansions.
    // TA4: also surface fuzzy hits as entity hypothesis sources in
    // fuzzyEntityHypotheses, enabling the entity-first dual retrieval path
    // even when exact anchor extraction fails (anchor count === 0).
    const expansions = {
      ...baseExpansions,
      ...(fuzzyExpansions.length > 0
        ? {
            lexical: [...baseExpansions.lexical, ...fuzzyExpansions],
            fuzzyEntityHypotheses: fuzzyExpansions,
          }
        : {}),
      ...(interpretedAmbiguousHints.length > 0
        ? { ambiguousEntityHints: interpretedAmbiguousHints }
        : {}),
      ...(ambiguityIntentResult.interpretation !== undefined
        ? { ambiguityIntentInterpretation: ambiguityIntentResult.interpretation }
        : {}),
    };

    // 8. Compute uncertainty.
    const uncertainty = await this.computeUncertainty(
      normalizedQuery,
      allAnchors,
      constraints,
      intent,
      queryClass,
      retrievalMode,
      plannerSurfaceNormalized,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'uncertainty_estimation',
        { normalizedQuery, anchorCount: allAnchors.length, constraintCount: constraints.hard.length + constraints.soft.length + constraints.inferred.length },
        [{ ruleId: 'uncertainty.computed', description: 'Uncertainty computed via computeUncertainty', inputsMatched: { anchorCount: allAnchors.length }, outcome: String(uncertainty.overall) }],
        [],
        String(uncertainty.overall),
        1.0 - uncertainty.overall,
      ));
    }

    const budget = context?.budget ?? DEFAULT_QUERY_BUDGET;

    // 10. Infer target entity type for result grouping (Epic 8).
    const targetEntityType = this.inferTargetEntityType(
      normalizedQuery,
      allAnchors,
      constraints,
      intent,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'target_entity_inference',
        { normalizedQuery, intent, anchorCount: allAnchors.length },
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
      allAnchors.length >= 2
        ? allAnchors.slice(1).map((a): QueryIntent =>
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
      requires_anchor_evidence: route === 'mixed' && allAnchors.length > 0,
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
      retrievalPlan,
      retrievalObjective,
      // E2-T3: Expose conflict-resolved, provenance-typed atoms for ranker + safety consumers.
      constraintAtoms: roleTypedAtoms,
      // ADR-010 Phase 1a: surface the trivial ConstraintGraph when the
      // compiler emitted one. Field is optional and additive — existing
      // readers remain on `constraintAtoms` / `constraints` until Phase 1b.
      ...(parsed.constraintGraph !== undefined ? { constraintGraph: parsed.constraintGraph } : {}),
      ...(plannerTrace.length > 0 ? { plannerTrace } : {}),
      ...(ambiguityIntentResult.trace.source !== 'not_applicable'
        ? { ambiguityIntentTrace: ambiguityIntentResult.trace }
        : {}),
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
    if (
      (intent === 'entity_exact' || intent === 'entity_fuzzy')
      && hasDirectResolvableAttributeEntity(normalizedQuery)
    ) {
      return 'short_entity';
    }
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

  private promoteQueryClassFromConstraintEvidence(
    classifiedQueryClass: QueryClass,
    ambiguousEntityHints: readonly AmbiguousEntityHint[],
    interpretation?: AmbiguityIntentInterpretation,
  ): QueryClass {
    const queryClassOverride = interpretation?.branchSelections
      .map((selection) => selection.resolvedQueryClass)
      .find((queryClass): queryClass is QueryClass => queryClass !== undefined);
    if (queryClassOverride !== undefined) {
      return queryClassOverride;
    }

    if (classifiedQueryClass === 'ambiguous_short_form') {
      return classifiedQueryClass;
    }

    return ambiguousEntityHints.some((hint) => hint.explorationBranches.length > 1)
      ? 'ambiguous_short_form'
      : classifiedQueryClass;
  }

  private async compileAmbiguityIntent(args: {
    readonly rawQuery: string;
    readonly normalizedQuery: string;
    readonly intent: QueryIntent;
    readonly classifiedQueryClass: QueryClass;
    readonly parsed: ConstraintCompilerResult;
    readonly abortSignal?: AbortSignal | undefined;
  }): Promise<{
    readonly interpretation?: AmbiguityIntentInterpretation | undefined;
    readonly trace: AmbiguityIntentTrace;
  }> {
    if (
      this.ambiguityIntentCompiler === undefined
      || args.parsed.ambiguousEntityHints.length === 0
    ) {
      return {
        trace: {
          source: 'not_applicable',
          latencyMs: null,
          branchSelectionCount: 0,
          selectedBranchCount: 0,
        },
      };
    }

    const compilerInput: AmbiguityIntentCompilerInput = {
      rawQuery: args.rawQuery,
      normalizedQuery: args.normalizedQuery,
      intent: args.intent,
      classifiedQueryClass: args.classifiedQueryClass,
      constraints: {
        hard: args.parsed.bundle.hard,
        soft: args.parsed.bundle.soft,
      },
      ambiguousEntityHints: args.parsed.ambiguousEntityHints,
      abortSignal: args.abortSignal,
    };

    return this.ambiguityIntentCompiler.compile(compilerInput);
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
    try {
      return await this.constraintCompiler.compile(normalizedQuery, abortSignal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return this.fallbackConstraintCompiler.compile(normalizedQuery, abortSignal);
    }
  }

  private contextualizeConstraintAtoms(
    atoms: readonly ConstraintAtom[],
    intent: QueryIntent,
  ): readonly ConstraintAtom[] {
    if (intent !== 'semantic_discovery' && intent !== 'pairing_search') {
      return atoms;
    }

    return atoms.map((atom) => {
      const isPositiveVarietalPrior =
        atom.attribute === 'grape_primary'
        && (atom.operator === '=' || atom.operator === 'in');
      if (!isPositiveVarietalPrior) {
        return atom;
      }
      return {
        ...atom,
        source_tier: 'soft',
        conflict_policy: 'prefer',
        constraint_role: 'prefer',
      };
    });
  }

  private buildConstraintParsingQuery(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
    relativeQuery: AnchorConditionedQuery | null,
    intent: QueryIntent,
  ): string {
    let sanitizedQuery = normalizedQuery;
    const matchedAnchorForms = new Set(
      anchors.flatMap((anchor) => [
        anchor.surfaceForm,
        anchor.normalizedForm,
        ...(anchor.lookupVariants ?? []),
      ].map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)),
    );

    if (relativeQuery !== null) {
      for (const expression of relativeQuery.relativeExpressions) {
        if (expression.operator !== 'not') {
          continue;
        }

        const anchorSurface = expression.anchorSurfaceForm.trim();
        if (anchorSurface.length === 0 || !matchedAnchorForms.has(anchorSurface.toLowerCase())) {
          continue;
        }

        const escapedAnchor = escapeRegex(anchorSurface);
        sanitizedQuery = sanitizedQuery
          .replace(new RegExp(`${escapedAnchor}${KOREAN_NOT_MARKER_PATTERN}`, 'u'), ' ')
          .replace(new RegExp(`${ENGLISH_NOT_MARKER_PATTERN}${escapedAnchor}`, 'iu'), ' ');
      }
    }

    if (this.shouldStripStrongEntityAnchorFromConstraintParsing(intent, anchors)) {
      sanitizedQuery = this.stripDominantAnchorTokens(sanitizedQuery, matchedAnchorForms);
    }

    return sanitizedQuery.replace(/\s+/gu, ' ').trim();
  }

  private shouldStripStrongEntityAnchorFromConstraintParsing(
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): boolean {
    if (intent !== 'entity_exact' && intent !== 'mixed_query') {
      return false;
    }

    const strongAnchors = anchors.filter((anchor) => anchor.confidence >= EXACT_ANCHOR_CONFIDENCE);
    if (strongAnchors.length === 0) {
      return false;
    }

    const uniqueStrongEntityCount = new Set(
      strongAnchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
    ).size;
    return uniqueStrongEntityCount === 1;
  }

  private stripDominantAnchorTokens(
    normalizedQuery: string,
    anchorForms: ReadonlySet<string>,
  ): string {
    const queryTokens = normalizedQuery
      .trim()
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (queryTokens.length === 0) {
      return normalizedQuery;
    }

    const dominantAnchorTokens = this.selectDominantAnchorTokenSequence(queryTokens, anchorForms);
    if (dominantAnchorTokens.length === 0) {
      return normalizedQuery;
    }

    const remainingCounts = new Map<string, number>();
    for (const token of dominantAnchorTokens) {
      remainingCounts.set(token, (remainingCounts.get(token) ?? 0) + 1);
    }

    const retainedTokens: string[] = [];
    for (const token of queryTokens) {
      const count = remainingCounts.get(token) ?? 0;
      if (count > 0) {
        remainingCounts.set(token, count - 1);
        continue;
      }
      retainedTokens.push(token);
    }

    return retainedTokens.join(' ');
  }

  private selectDominantAnchorTokenSequence(
    queryTokens: readonly string[],
    anchorForms: ReadonlySet<string>,
  ): readonly string[] {
    const queryCounts = new Map<string, number>();
    for (const token of queryTokens) {
      queryCounts.set(token, (queryCounts.get(token) ?? 0) + 1);
    }

    let bestTokens: readonly string[] = [];
    for (const form of anchorForms) {
      const tokens = form
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      if (tokens.length === 0 || !this.isTokenMultisetCovered(tokens, queryCounts)) {
        continue;
      }

      if (
        tokens.length > bestTokens.length ||
        (tokens.length === bestTokens.length && form.length > bestTokens.join(' ').length)
      ) {
        bestTokens = tokens;
      }
    }

    return bestTokens;
  }

  private isTokenMultisetCovered(
    candidateTokens: readonly string[],
    queryCounts: ReadonlyMap<string, number>,
  ): boolean {
    const requiredCounts = new Map<string, number>();
    for (const token of candidateTokens) {
      requiredCounts.set(token, (requiredCounts.get(token) ?? 0) + 1);
    }

    for (const [token, requiredCount] of requiredCounts) {
      if ((queryCounts.get(token) ?? 0) < requiredCount) {
        return false;
      }
    }

    return true;
  }

  /**
   * Computes the uncertainty assessment for the query.
   */
  private async computeUncertainty(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
    constraints: ConstraintBundle,
    intent?: QueryIntent,
    queryClass?: QueryClass,
    retrievalMode?: RetrievalMode,
    ambiguityQuerySurface?: string,
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
    const ambiguityTypes = new Set<string>();
    let ambiguitySeverity: QueryUncertainty['ambiguitySeverity'] = 'low';
    const uncertaintyQuerySurface =
      ambiguityQuerySurface !== undefined && ambiguityQuerySurface.trim().length > 0
        ? ambiguityQuerySurface
        : normalizedQuery;
    const convergedExactEntityLookup =
      intent === 'entity_exact'
      && queryClass === 'short_entity'
      && retrievalMode === 'entity_lookup'
      && anchors.length === 1
      && anchors[0] !== undefined
      && anchors[0].confidence >= EXACT_ANCHOR_CONFIDENCE
      && anchors[0].candidateEntityIds.length === 1;

    if (convergedExactEntityLookup) {
      const overall = Math.min(
        1.0,
        Math.max(
          0.0,
          1.0
            - UNCERTAINTY_OVERALL_WEIGHT_PARSER * parserConfidence
            - UNCERTAINTY_OVERALL_WEIGHT_ANCHOR * anchorConfidence
            - UNCERTAINTY_OVERALL_WEIGHT_CONSTRAINT * constraintConfidence,
        ),
      );
      return {
        overall,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity,
        decisionEffect: 'trace_only',
        parserConfidence,
        anchorConfidence,
        constraintConfidence,
      };
    }

    // Check whether the full normalized query is a known ambiguous form.
    const fullQueryInfo =
      await this.ambiguityDict.getAmbiguityInfo(uncertaintyQuerySurface);
    if (fullQueryInfo !== null) {
      for (const type of fullQueryInfo.types) {
        ambiguityTypes.add(type);
      }
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
        ambiguityTypes.add('multiple_candidates');
      }

      // Check ambiguity dictionary.
      const info = await this.ambiguityDict.getAmbiguityInfo(
        anchor.normalizedForm,
      );
      if (info !== null) {
        for (const type of info.types) {
          ambiguityTypes.add(type);
        }
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
      ambiguityTypes.add('low_anchor_confidence');
      if (ambiguitySeverity === 'low') {
        ambiguitySeverity = 'medium';
      }
    }

    const ambiguityTypeList = [...ambiguityTypes];
    const ambiguityDetected = ambiguityTypeList.length > 0;

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
      ambiguityTypes: ambiguityTypeList,
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function applyAmbiguityIntentInterpretation(
  hints: readonly AmbiguousEntityHint[],
  interpretation: AmbiguityIntentInterpretation | undefined,
): readonly AmbiguousEntityHint[] {
  if (interpretation === undefined) {
    return hints;
  }

  return hints.map((hint) => {
    const selection = interpretation.branchSelections.find((entry) =>
      entry.surface === hint.surface
      && entry.entityType === hint.entityType,
    );
    if (selection === undefined || selection.decision !== 'select_branches') {
      return hint;
    }

    const selectedBranchSet = new Set(selection.selectedBranchLabels);
    const explorationBranches = hint.explorationBranches.filter((branch) => selectedBranchSet.has(branch.label));
    if (explorationBranches.length === 0) {
      return hint;
    }

    return {
      ...hint,
      clarifyOptions: hint.clarifyOptions.filter((label) => selectedBranchSet.has(label)),
      lexicalExpansions: uniqueStrings([
        ...hint.lexicalExpansions,
        ...explorationBranches.flatMap((branch) => branch.lexicalExpansions),
      ]),
      semanticExpansions: uniqueStrings([
        ...hint.semanticExpansions,
        ...explorationBranches.flatMap((branch) => branch.semanticExpansions),
      ]),
      explorationBranches,
    };
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
