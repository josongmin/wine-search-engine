import type {
  QueryClass,
  ConstraintBundle,
  ConstraintAtom,
} from '../../shared/types/index.js';
import { liftBundleToAtoms } from '../../shared/types/index.js';
import type { QueryPlanV2 } from '../model/query-plan.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import { isExploratoryRetrievalMode } from '../model/retrieval-mode-classification.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import type { QueryUncertainty } from '../model/query-uncertainty.js';
import type { SessionContext } from '../model/session-context.js';
import type { QueryBudget } from '../model/query-budget.js';
import { DEFAULT_QUERY_BUDGET } from '../model/query-budget.js';
import { MAX_QUERY_LENGTH } from '../../shared/constants.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../model/threshold-profile.js';
import type {
  AmbiguityDictionary,
  AmbiguityInfo,
} from '../port/ambiguity-dictionary.port.js';
import type { FuzzyMatcherPort } from '../port/fuzzy-matcher.port.js';
import { type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { type NLMapper } from '../../attribute/service/nl-mapper.js';
import { ConstraintCompiler, type ConstraintCompilerResult } from './constraint-compiler.js';
import type { ConstraintTopologyPlanner } from './constraint-topology-planner.js';
import { hasVintageYear as hasBoundedVintageYear } from '../../shared/utils/vintage.js';
import type { RequestExecutionContext } from '../../shared/request-execution-context.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import { QueryNormalizer } from './query-normalizer.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';
import {
  detectQueryIntent,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import { analyzeQueryDecomposition } from './decomposition-detector.js';
import {
  hasEntityMetadataKeyword,
  hasExactEntityLookupKeyword,
  stripExactEntityLookupSuffix,
} from './exact-entity-metadata-signals.js';
import { isGenericWineNounToken } from './short-entity-surface.js';
import type { PolicyDecisionRecord } from '../model/policy-decision-record.js';
import { buildBundleFromAtoms, ConstraintReasoner } from './constraint-reasoner.js';
import { buildRetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../retrieval/model/retrieval-objective.js';
import {
  type AmbiguityIntentCompiler,
  type AmbiguityIntentCompilerInput,
} from './ambiguity-intent-compiler.js';
import type {
  AmbiguityIntentInterpretation,
  AmbiguityIntentTrace,
} from '../model/ambiguity-intent-interpretation.js';
import { splitLookupStrategies } from './anchor-extractor.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import {
  PLANNER_VERSION,
  POLICY_RULE_VERSION,
  CONSTRAINT_SHAPED_ANCHOR_ATTRIBUTES,
  GENERIC_ANCHOR_SOURCE_ATTRIBUTES,
  GENERIC_LOOKUP_VARIANT_SINGLE_SUPPORT_MAX,
  GENERIC_CONSTRAINT_SURFACE_TRUSTED_ALIAS_TYPES,
  SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD,
  UNCERTAINTY_PARSER_CONFIDENCE_FLOOR,
  UNCERTAINTY_PARSER_CONFIDENCE_PER_TOKEN_PENALTY,
  UNCERTAINTY_CONSTRAINT_CONFIDENCE_NEUTRAL,
  UNCERTAINTY_LOW_ANCHOR_CONFIDENCE_THRESHOLD,
  UNCERTAINTY_OVERALL_WEIGHT_PARSER,
  UNCERTAINTY_OVERALL_WEIGHT_ANCHOR,
  UNCERTAINTY_OVERALL_WEIGHT_CONSTRAINT,
  UNCERTAINTY_AMBIGUITY_OVERALL_BUMP,
  UNCERTAINTY_RAISE_THRESHOLD_OVERALL,
  KNOWN_AMBIGUOUS_SURFACE_TYPE,
  KOREAN_NOT_MARKER_PATTERN,
  ENGLISH_NOT_MARKER_PATTERN,
  KOREAN_SIMILARITY_MARKER_PATTERN,
  ENGLISH_SIMILARITY_MARKER_PATTERN,
  EMPTY_FALLBACK_MAPPER,
} from './planner-constants.js';
import {
  hasDirectResolvableAttributeEntity,
  isAbortError,
  applyAmbiguityIntentInterpretation,
  escapeRegex,
  buildDecisionRecord,
} from './planner-helpers.js';
import {
  anchorUsesExactLikeLookup,
  promoteQueryClassFromConstraintEvidence,
  mergePairingIntoBundle,
  promoteIntentFromParsedConstraints,
  promoteIntentForVintageBearingSpecificSkuLookup,
  shouldApplyFuzzyAnchorFallback,
  shouldTreatSemanticDiscoveryAsShortEntitySurface,
  computeFuzzyFallbackConfidence,
  deriveExplicitNoMatchOverride,
  contextualizeConstraintAtoms,
  shouldStripStrongEntityAnchorFromConstraintParsing,
  stripDominantAnchorTokens,
} from './planner-pure-logic.js';
import {
  determineRoute,
  determineRetrievalMode,
  inferTargetEntityType,
} from './planner-routing.js';
import { hasRawQueryExactSafeSingletonAliasWitness } from './exact-safe-anchor-witness.js';

const log = bootstrapLogger.child({ component: 'Planner' });
const EMPTY_CONSTRAINT_REASONER = new ConstraintReasoner();

/**
 * Re-export the public short-query ambiguity threshold from the constants
 * SSoT so existing import paths (`@domain/query/service/planner.js`) stay
 * intact for external consumers (e.g. search-usecase-resolver-candidates).
 */
export { SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD };

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
  /**
   * RFC-021 T-PSA-03: lock the execution onto the hybrid discovery route.
   *
   * Set by the public primitive search routes
   * (`/v1/search/{hybrid,semantic,lexical}`), whose retrieval lane is selected
   * by URL path. When true, {@link determineRoute} / {@link determineRetrievalMode}
   * still compile constraints but MUST NOT promote the request onto the entity
   * or mixed/anchor-similarity lanes — the path-selected lane stays authoritative
   * end-to-end. Absent / false → full planner routing (unchanged).
   */
  readonly lockDiscoveryLane?: boolean | undefined;
}

interface PlannerOptions {
  /**
   * Lookup-authority optimization. When the raw query already carries a
   * collision-free exact-safe singleton alias witness, skip generic
   * constraint compilation and keep the planner on the entity-resolution lane.
   */
  readonly skipConstraintParsingOnExactSafeWitness?: boolean | undefined;
  /**
   * Lookup-authority optimization. Constraint parsing in entity lookup should
   * not pay LazyFuzzyMatcher warmup cost for short OOV surfaces; anchor recall
   * already owns fuzzy entity discovery. This flag disables only the
   * constraint-compiler's fuzzy entity linking, not planner fuzzy fallback.
   */
  readonly disableConstraintCompilerFuzzyMatcher?: boolean | undefined;
  /**
   * Lookup-authority optimization. If the raw normalized query is already a
   * persisted ambiguous short form and there is no exact-safe singleton
   * witness, skip planner fuzzy fallback entirely.
   */
  readonly skipFuzzyFallbackOnKnownAmbiguousSurface?: boolean | undefined;
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
    private readonly options: PlannerOptions = {},
  ) {
    const constraintCompilerFuzzyMatcher =
      this.options.disableConstraintCompilerFuzzyMatcher === true
        ? undefined
        : fuzzyMatcher;
    this.constraintCompiler = new ConstraintCompiler(
      nlMapper,
      constraintCompilerFuzzyMatcher,
      topologyPlanner,
    );
    this.fallbackConstraintCompiler = new ConstraintCompiler(
      EMPTY_FALLBACK_MAPPER,
      constraintCompilerFuzzyMatcher,
      topologyPlanner,
    );
  }

  private normalizeConstraintShapedSurface(value: string): string {
    return this.queryNormalizer.normalize(value).strict.trim();
  }

  private suppressConstraintShapedLexicalAnchors(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
    atoms: readonly ConstraintAtom[],
    relativeQuery: AnchorConditionedQuery | null,
  ): readonly AnchorCandidate[] {
    const genericConstraintSurfaces = this.buildGenericConstraintSurfaces(
      normalizedQuery,
      atoms,
      relativeQuery,
    );
    const variantSupportCount = this.buildLookupVariantSupportCount(anchors);

    return anchors.filter((anchor) => {
      const lookupVariants = (anchor.lookupVariants ?? [])
        .map((variant) => this.normalizeConstraintShapedSurface(variant))
        .filter((variant) => variant.length > 0);
      if (lookupVariants.length === 0) {
        return true;
      }

      const allVariantsAreGenericWineNouns = lookupVariants.every((variant) =>
        isGenericWineNounToken(variant),
      );
      if (allVariantsAreGenericWineNouns) {
        return false;
      }

      const allVariantsAreGenericConstraintSurfaces = lookupVariants.every((variant) =>
        genericConstraintSurfaces.has(variant),
      );
      if (!allVariantsAreGenericConstraintSurfaces) {
        return true;
      }

      const distinctEntityIds = new Set(anchor.candidateEntityIds.map(String));
      const aliasTypeTrustedForConstraintSurface =
        anchor.aliasType !== undefined
        && GENERIC_CONSTRAINT_SURFACE_TRUSTED_ALIAS_TYPES.has(anchor.aliasType);

      if (genericConstraintSurfaces.size === 0) {
        return true;
      }

      if (distinctEntityIds.size > 1) {
        return false;
      }

      if (!aliasTypeTrustedForConstraintSurface) {
        return false;
      }

      if (!anchorUsesExactLikeLookup(anchor)) {
        return relativeQuery !== null;
      }

      return lookupVariants.some((variant) => {
        const supportCount = variantSupportCount.get(variant) ?? 0;
        return supportCount <= GENERIC_LOOKUP_VARIANT_SINGLE_SUPPORT_MAX && variant.length > 1;
      });
    });
  }

  private buildGenericConstraintSurfaces(
    normalizedQuery: string,
    atoms: readonly ConstraintAtom[],
    relativeQuery: AnchorConditionedQuery | null,
  ): ReadonlySet<string> {
    const surfaces = new Set<string>();
    const relevantAtoms = atoms.filter((atom) => GENERIC_ANCHOR_SOURCE_ATTRIBUTES.has(atom.attribute));
    for (const atom of relevantAtoms) {
      this.addGenericSurfacePhrase(surfaces, atom.source_phrase);
    }

    if (relativeQuery !== null) {
      return surfaces;
    }

    const distinctConstraintAttributes = new Set(
      relevantAtoms
        .filter((atom) => CONSTRAINT_SHAPED_ANCHOR_ATTRIBUTES.has(atom.attribute))
        .map((atom) => atom.attribute),
    );
    const shouldWidenToComparableSurfaces =
      relevantAtoms.some((atom) => atom.source_tier !== 'hard')
      || distinctConstraintAttributes.size >= 2;
    if (!shouldWidenToComparableSurfaces) {
      return surfaces;
    }

    for (const atom of relevantAtoms) {
      this.addGenericSurfaceComparableValue(surfaces, atom);
    }

    this.addGenericSurfacePhrase(surfaces, normalizedQuery);

    return surfaces;
  }

  private addGenericSurfacePhrase(
    surfaces: Set<string>,
    value: string,
  ): void {
    const normalized = this.normalizeConstraintShapedSurface(value);
    if (normalized.length === 0) {
      return;
    }
    surfaces.add(normalized);
    for (const span of parseSpans(normalized)) {
      if (span.text.length > 0) {
        surfaces.add(span.text);
      }
    }
  }

  private addGenericSurfaceComparableValue(
    surfaces: Set<string>,
    atom: ConstraintAtom,
  ): void {
    if (typeof atom.value === 'string') {
      this.addGenericSurfacePhrase(surfaces, atom.value);
      return;
    }
    if (Array.isArray(atom.value)) {
      for (const value of atom.value) {
        this.addGenericSurfacePhrase(surfaces, String(value));
      }
    }
  }

  private buildLookupVariantSupportCount(
    anchors: readonly AnchorCandidate[],
  ): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const anchor of anchors) {
      for (const variant of anchor.lookupVariants ?? []) {
        const normalized = this.normalizeConstraintShapedSurface(variant);
        if (normalized.length === 0) {
          continue;
        }
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
    return counts;
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
    // 1. Normalize. QueryNormalizer itself preserves raw exact-safe surfaces
    // while also emitting typo-corrected lookup variants; the planner must not
    // destructively pre-rewrite the raw surface before that stage.
    const queryViews = this.queryNormalizer.normalize(safeQuery);
    const normalizedQuery = queryViews.accentless;
    const exactLookupSafeQuery = hasExactEntityLookupKeyword(normalizedQuery)
      ? stripExactEntityLookupSuffix(safeQuery)
      : safeQuery;
    const exactLookupSafeQueryViews = this.queryNormalizer.normalize(exactLookupSafeQuery);
    const exactLookupSafeNormalized = exactLookupSafeQueryViews.accentless;
    const shouldUseExactLookupSurface =
      exactLookupSafeQuery.trim().length > 0
      && exactLookupSafeQuery !== safeQuery
      && (
        hasEntityMetadataKeyword(normalizedQuery)
        || hasBoundedVintageYear(exactLookupSafeNormalized)
        || hasDirectResolvableAttributeEntity(exactLookupSafeNormalized)
      );
    const plannerSurfaceViews = shouldUseExactLookupSurface ? exactLookupSafeQueryViews : queryViews;
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
      stageTimer,
    ).finally(() => {
      stageTimer?.end('planner.anchor_extraction');
    });

    let fuzzyExpansions: readonly string[] = [];
    let fuzzyAnchors: readonly AnchorCandidate[] = [];
    let allAnchors: readonly AnchorCandidate[] = anchors;

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
    const lockDiscoveryLane = context?.lockDiscoveryLane === true;
    const route = determineRoute(intent, allAnchors, lockDiscoveryLane);
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
    const retrievalMode = determineRetrievalMode(
      intent,
      allAnchors,
      plannerSurfaceNormalized,
      lockDiscoveryLane,
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
        return await this.determineQueryClass(originalQuery, plannerSurfaceNormalized, intent, allAnchors);
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
    const rawQueryHasExactSafeSingletonWitness = hasRawQueryExactSafeSingletonAliasWitness(
      originalQuery,
      plannerSurfaceNormalized,
      allAnchors,
    );
    const shouldSkipConstraintParsing =
      this.options.skipConstraintParsingOnExactSafeWitness === true
      && relativeQuery === null
      && rawQueryHasExactSafeSingletonWitness;
    const parsedPromise = (async () => {
      if (shouldSkipConstraintParsing) {
        return this.buildEmptyConstraintCompilerResult();
      }
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

    const [initialClassifiedQueryClass, parsed] = await Promise.all([
      queryClassPromise,
      parsedPromise,
    ]);
    stageTimer?.start('planner.ambiguity_intent_compilation');
    const ambiguityIntentResult = await this.compileAmbiguityIntent({
      rawQuery: originalQuery,
      normalizedQuery: plannerSurfaceNormalized,
      intent,
      classifiedQueryClass: initialClassifiedQueryClass,
      parsed,
      abortSignal: context?.abortSignal,
    }).finally(() => {
      stageTimer?.end('planner.ambiguity_intent_compilation');
    });
    const interpretedAmbiguousHints = applyAmbiguityIntentInterpretation(
      parsed.ambiguousEntityHints,
      ambiguityIntentResult.interpretation,
    );
    const mergedConstraints = mergePairingIntoBundle(
      buildBundleFromAtoms(parsed.reasonerOutput.survivingAtoms),
      normalizedQuery,
    );
    const parsedIntent = promoteIntentFromParsedConstraints(
      intent,
      mergedConstraints,
      allAnchors,
    );
    const shouldSkipFuzzyFallbackForKnownAmbiguousSurface =
      this.options.skipFuzzyFallbackOnKnownAmbiguousSurface === true
      && !rawQueryHasExactSafeSingletonWitness
      && await this.ambiguityDict.isKnownAmbiguous(
        plannerSurfaceNormalized,
        context?.abortSignal,
      );
    if (
      anchors.length === 0
      && this.fuzzyMatcher !== undefined
      && !shouldSkipFuzzyFallbackForKnownAmbiguousSurface
      && shouldApplyFuzzyAnchorFallback(
        plannerSurfaceNormalized,
        initialClassifiedQueryClass,
        parsedIntent,
        mergedConstraints,
        relativeQuery,
      )
    ) {
      const fuzzyFallback = await this.buildFuzzyFallbackAnchors(
        plannerSurfaceNormalized,
        stageTimer,
      );
      fuzzyExpansions = fuzzyFallback.fuzzyExpansions;
      fuzzyAnchors = fuzzyFallback.fuzzyAnchors;
      if (fuzzyAnchors.length > 0) {
        allAnchors = [...anchors, ...fuzzyAnchors];
      }
    }
    const mergedConstraintAtoms = liftBundleToAtoms(mergedConstraints);
    const roleTypedAtoms = contextualizeConstraintAtoms(
      mergedConstraintAtoms,
      parsedIntent,
    );
    const effectiveAnchors = this.suppressConstraintShapedLexicalAnchors(
      plannerSurfaceNormalized,
      allAnchors,
      roleTypedAtoms,
      relativeQuery,
    );
    const anchorsChanged = effectiveAnchors.length !== allAnchors.length;
    const detectedIntentAfterAnchorSuppression = anchorsChanged || fuzzyAnchors.length > 0
      ? detectQueryIntent(
        normalizedQuery,
        effectiveAnchors,
        this.anchorExtractor,
        relativeQuery,
      )
      : parsedIntent;
    const effectiveIntent = promoteIntentFromParsedConstraints(
      promoteIntentForVintageBearingSpecificSkuLookup(
        detectedIntentAfterAnchorSuppression,
        originalQuery,
        plannerSurfaceNormalized,
        effectiveAnchors,
      ),
      buildBundleFromAtoms(roleTypedAtoms),
      effectiveAnchors,
    );
    const intentChanged = fuzzyAnchors.length > 0 || anchorsChanged || effectiveIntent !== intent;
    const effectiveRoute = intentChanged
      ? determineRoute(effectiveIntent, effectiveAnchors, lockDiscoveryLane)
      : route;
    const effectiveRetrievalMode = intentChanged
      ? determineRetrievalMode(
        effectiveIntent,
        effectiveAnchors,
        plannerSurfaceNormalized,
        lockDiscoveryLane,
      )
      : retrievalMode;
    const classifiedQueryClass = intentChanged
      ? await this.determineQueryClass(
        originalQuery,
        plannerSurfaceNormalized,
        effectiveIntent,
        effectiveAnchors,
      )
      : initialClassifiedQueryClass;
    const promotedQueryClass = promoteQueryClassFromConstraintEvidence(
      classifiedQueryClass,
      interpretedAmbiguousHints,
      ambiguityIntentResult.interpretation,
    );
    const constraints = buildBundleFromAtoms(roleTypedAtoms);
    const noMatchOverride = deriveExplicitNoMatchOverride(
      plannerSurfaceNormalized,
      constraints,
      effectiveAnchors,
    );
    const finalRoute = noMatchOverride?.route ?? effectiveRoute;
    const finalRetrievalMode = noMatchOverride?.retrievalMode ?? effectiveRetrievalMode;
    const queryClass = noMatchOverride?.queryClass ?? promotedQueryClass;
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'query_class_classification',
        { normalizedQuery, intent: effectiveIntent, anchorCount: effectiveAnchors.length },
        [{ ruleId: 'query_class.classified', description: 'Query class classified via determineQueryClass', inputsMatched: { intent: effectiveIntent }, outcome: queryClass }],
        [],
        queryClass,
        1.0,
      ));
    }
    const retrievalPlan = buildRetrievalPlan(constraints);
    const retrievalObjective = buildRetrievalObjective(constraints);

    // 7. Build expansions.
    stageTimer?.start('planner.expansion_build');
    const baseExpansions = this.expansionBuilder.build(
      plannerSurfaceNormalized,
      effectiveIntent,
      effectiveAnchors,
    );
    stageTimer?.end('planner.expansion_build');

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
    stageTimer?.start('planner.compute_uncertainty');
    const uncertainty = await this.computeUncertainty(
      normalizedQuery,
      effectiveAnchors,
      constraints,
      effectiveIntent,
      queryClass,
      finalRetrievalMode,
      plannerSurfaceNormalized,
    ).finally(() => {
      stageTimer?.end('planner.compute_uncertainty');
    });
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'uncertainty_estimation',
        { normalizedQuery, anchorCount: effectiveAnchors.length, constraintCount: constraints.hard.length + constraints.soft.length + constraints.inferred.length },
        [{ ruleId: 'uncertainty.computed', description: 'Uncertainty computed via computeUncertainty', inputsMatched: { anchorCount: effectiveAnchors.length }, outcome: String(uncertainty.overall) }],
        [],
        String(uncertainty.overall),
        1.0 - uncertainty.overall,
      ));
    }

    const budget = context?.budget ?? DEFAULT_QUERY_BUDGET;

    // 10. Infer target entity type for result grouping (Epic 8).
    const targetEntityType = inferTargetEntityType(
      normalizedQuery,
      effectiveAnchors,
      constraints,
      effectiveIntent,
    );
    if (tracingEnabled) {
      plannerTrace.push(buildDecisionRecord(
        'target_entity_inference',
        { normalizedQuery, intent: effectiveIntent, anchorCount: effectiveAnchors.length },
        targetEntityType != null
          ? [{ ruleId: 'target_entity.inferred', description: 'Target entity type inferred', inputsMatched: { intent: effectiveIntent }, outcome: targetEntityType }]
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
      effectiveAnchors.length >= 2
        ? effectiveAnchors.slice(1).map((a): QueryIntent =>
            a.confidence >= EXACT_ANCHOR_CONFIDENCE
              ? 'entity_exact'
              : 'entity_fuzzy',
          )
        : undefined;

    // RFC-005 §3.1, RFC-016 §2: surface what evidence/sealing the Admission
    // Gate needs for this query so it can close the resolved boundary correctly.
    //
    // Identity-seal requirement is a function of (intent × retrievalMode):
    //
    //   - Identity-style intents that end up in an identity-style retrieval
    //     mode (entity_lookup / entity_resolution) DO need identity seal — the
    //     answer is a single resolved entity and the gate is closing its
    //     identity boundary.
    //
    //   - The same intents under EXPLORATORY retrieval modes (similar_items,
    //     recommendation, compare_candidates, producer_browse, region_browse)
    //     return a LIST shaped by anchors/constraints rather than a single
    //     identity claim. Requiring an identity seal on a list output is
    //     structurally inapplicable: there is no winning entity whose identity
    //     could be sealed. Concretely this drops the false-positive admission
    //     rejection on queries like `마고 비슷한 레드` (mixed_query intent,
    //     similar_items mode — Margaux is an anchor, the answer is a red-wine
    //     shortlist).
    //
    // The exploratory-mode set lives in
    // `domain/query/model/retrieval-mode-classification.ts` and is shared with
    // `decision-engine.applyPolicyOverlay`'s allow-approximate gate so the
    // two sites cannot drift (CLAUDE.md rule 30).
    const intentRequestsIdentitySeal =
      effectiveIntent === 'entity_exact' ||
      effectiveIntent === 'entity_fuzzy' ||
      effectiveIntent === 'comparison_search' ||
      effectiveIntent === 'mixed_query';
    const admission_context = {
      requires_identity_seal:
        intentRequestsIdentitySeal && !isExploratoryRetrievalMode(finalRetrievalMode),
      requires_constraint_evidence: constraints.hard.length > 0,
      requires_anchor_evidence: finalRoute === 'mixed' && effectiveAnchors.length > 0,
    };
    const decompositionHint = analyzeQueryDecomposition(originalQuery).hint;

    return {
      rawQuery: originalQuery,
      normalizedQuery,
      normalizedQueryViews: queryViews,
      intent: effectiveIntent,
      ...(secondaryIntents !== undefined && { secondaryIntents }),
      suggestedRoute: finalRoute,
      suggestedRetrievalMode: finalRetrievalMode,
      queryClass,
      // TA2-T2: Include planner_heuristic anchors from fuzzy-match fallback.
      // allAnchors = exact alias anchors + fuzzy heuristic anchors (when present).
      anchors: effectiveAnchors,
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
   * Determines the query class based on intent, anchors, and ambiguity.
   */
  private async determineQueryClass(
    rawQuery: string,
    normalizedQuery: string,
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): Promise<QueryClass> {
    const rawQueryHasExactSafeSingletonWitness = hasRawQueryExactSafeSingletonAliasWitness(
      rawQuery,
      normalizedQuery,
      anchors,
    );
    if (
      (intent === 'entity_exact' || intent === 'entity_fuzzy')
      && hasDirectResolvableAttributeEntity(normalizedQuery)
    ) {
      return 'short_entity';
    }
    // Batch lookup: full query + all anchor surface forms in a single
    // round-trip. The substrate (PG/RDS in production) replies with the set of
    // forms it considers known-ambiguous; we then check the map locally without
    // additional awaits. C3: was previously N+1 sequential awaits on the hot
    // path, scaling badly with anchor count.
    const shouldApplyAliasAmbiguityOverride =
      intent === 'entity_exact'
      || intent === 'entity_fuzzy'
      || intent === 'comparison_search'
      || intent === 'mixed_query';
    if (shouldApplyAliasAmbiguityOverride && !rawQueryHasExactSafeSingletonWitness) {
      const surfaceFormsToCheck = [
        normalizedQuery,
        ...anchors.map((a) => a.normalizedForm),
      ];
      const ambiguousMap =
        surfaceFormsToCheck.length > 0
          ? await this.ambiguityDict.getAmbiguityInfoBatch(surfaceFormsToCheck)
          : new Map<string, AmbiguityInfo>();

      if (ambiguousMap.has(normalizedQuery)) {
        return 'ambiguous_short_form';
      }
      for (const anchor of anchors) {
        if (ambiguousMap.has(anchor.normalizedForm)) {
          return 'ambiguous_short_form';
        }
      }
    }

    // Short queries (1-2 tokens) with an anchor -> short_entity.
    // Guard: "".split(/\s+/) returns [''] (length 1, not 0); trim+filter removes empty tokens.
    const tokenCount = normalizedQuery.trim().length === 0
      ? 0
      : normalizedQuery.trim().split(/\s+/).length;
    if (tokenCount <= 2 && anchors.length > 0) {
      if (rawQueryHasExactSafeSingletonWitness) {
        return 'short_entity';
      }
      // Ambiguity here means "the query could resolve to MULTIPLE COMPETING
      // ENTITIES", not "the candidate-generation path produced multiple
      // anchor variants converging on the same entity". The latter is a
      // RECALL-positive — different lookup strategies (prefix_exact +
      // fuzzy + phonetic) all picking the same wine is evidence
      // STRENGTHENING the resolution, not weakening it.
      //
      // Concretely this is what makes `opu` resolve: the 3-char prefix
      // surfaces three anchor variants (prefix_exact at high confidence,
      // plus lower-confidence fuzzy / transliterated fallbacks) all
      // pointing to `opus-one-2018`. The previous gate counted only
      // `totalCandidates` (≥3) + saw the lower-confidence siblings and
      // misclassified the query as ambiguous_short_form, raising
      // T_resolve to 0.65 with `CLARIFICATION_BIAS_0.15` and pushing the
      // weighted-sum score under the bar. Requiring entity-level
      // distinctness restores the structural intent.
      const distinctEntityIds = new Set<string>(
        anchors.flatMap((a) => a.candidateEntityIds.map((id) => String(id))),
      );
      if (
        distinctEntityIds.size > 1
        && anchors.some((a) => a.confidence < SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD)
      ) {
        return 'ambiguous_short_form';
      }
      return 'short_entity';
    }

    if (shouldTreatSemanticDiscoveryAsShortEntitySurface(rawQuery, normalizedQuery, intent, anchors)) {
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
      log.warn(
        // Pass the raw error so the pino `err` serializer scrubs PII and
        // preserves the stack — consistent with the other W0 constraint/anchor
        // failure logs ({ err }). Passing `error.message` here dropped the
        // stack and split diagnostics from the sibling sites.
        { err: error },
        '[Planner] constraint compiler failed; falling back to deterministic constraint compiler',
      );
      return this.fallbackConstraintCompiler.compile(normalizedQuery, abortSignal);
    }
  }

  private buildEmptyConstraintCompilerResult(): ConstraintCompilerResult {
    const emptyBundle = { hard: [], soft: [], inferred: [] };
    return {
      bundle: emptyBundle,
      retrievalPlan: buildRetrievalPlan(emptyBundle),
      resolvedEntities: [],
      ambiguousEntityHints: [],
      reasonerOutput: EMPTY_CONSTRAINT_REASONER.reason(emptyBundle),
    };
  }

  private async buildFuzzyFallbackAnchors(
    normalizedQuery: string,
    stageTimer?: RequestExecutionContext['stageTimer'],
  ): Promise<{
    readonly fuzzyExpansions: readonly string[];
    readonly fuzzyAnchors: readonly AnchorCandidate[];
  }> {
    stageTimer?.start('planner.fuzzy_fallback');
    try {
      const fuzzyMatches = this.fuzzyMatcher?.match(normalizedQuery) ?? [];
      if (fuzzyMatches.length === 0) {
        return { fuzzyExpansions: [], fuzzyAnchors: [] };
      }

      const fuzzyTerms = [...new Set(
        fuzzyMatches
          .map((match) => match.term.trim())
          .filter((term) => term.length > 0),
      )];
      if (fuzzyTerms.length === 0) {
        return { fuzzyExpansions: [], fuzzyAnchors: [] };
      }

      const aliasMatchesByTerm = await this.anchorExtractor.lookupForFuzzyTerms(fuzzyTerms);
      const merged = new Map<string, {
        candidateEntityIds: AnchorCandidate['candidateEntityIds'];
        readonly lookupVariants: Set<string>;
        readonly lookupStrategies: Set<string>;
        aliasType: AnchorCandidate['aliasType'];
        confidence: number;
        normalizedForm: string;
        surfaceForm: string;
      }>();
      const emittedTerms = new Set<string>();

      for (const fuzzyMatch of fuzzyMatches) {
        const fuzzyTerm = fuzzyMatch.term.trim();
        if (fuzzyTerm.length === 0) {
          continue;
        }
        const aliasMatches = aliasMatchesByTerm.get(fuzzyTerm) ?? [];
        if (aliasMatches.length === 0) {
          continue;
        }
        emittedTerms.add(fuzzyTerm);

        for (const aliasMatch of aliasMatches) {
          const confidence = computeFuzzyFallbackConfidence(
            aliasMatch,
            fuzzyMatch.editDistance,
            fuzzyMatch.combinedScore,
          );
          const key = `${fuzzyTerm}\u0000${aliasMatch.entityIds.map(String).join(',')}`;
          const existing = merged.get(key);
          if (existing === undefined || confidence > existing.confidence) {
            merged.set(key, {
              surfaceForm: fuzzyTerm,
              normalizedForm: fuzzyTerm,
              candidateEntityIds: aliasMatch.entityIds,
              lookupVariants: existing?.lookupVariants ?? new Set<string>(),
              lookupStrategies: existing?.lookupStrategies ?? new Set<string>(),
              aliasType: aliasMatch.aliasType,
              confidence,
            });
          } else if (existing.aliasType === undefined && aliasMatch.aliasType !== undefined) {
            existing.aliasType = aliasMatch.aliasType;
          }

          const entry = merged.get(key);
          entry?.lookupVariants.add(fuzzyTerm);
          entry?.lookupStrategies.add('fuzzy_match_fallback');
          for (const strategy of splitLookupStrategies(aliasMatch.lookupStrategy)) {
            entry?.lookupStrategies.add(strategy);
          }
        }
      }

      const fuzzyAnchors = [...merged.values()]
        .map((entry): AnchorCandidate => ({
          surfaceForm: entry.surfaceForm,
          normalizedForm: entry.normalizedForm,
          candidateEntityIds: entry.candidateEntityIds,
          ...(entry.lookupVariants.size > 0
            ? { lookupVariants: [...entry.lookupVariants].sort() }
            : {}),
          ...(entry.lookupStrategies.size > 0
            ? { lookupStrategies: [...entry.lookupStrategies].sort() }
            : {}),
          ...(entry.aliasType !== undefined ? { aliasType: entry.aliasType } : {}),
          confidence: entry.confidence,
          source: 'planner_heuristic',
        }))
        .sort(
          compareScoreWithTiebreaker<AnchorCandidate>(
            (candidate) => candidate.confidence,
            (candidate) => candidate.surfaceForm,
          ),
        );

      return {
        fuzzyExpansions: [...emittedTerms],
        fuzzyAnchors,
      };
    } finally {
      stageTimer?.end('planner.fuzzy_fallback');
    }
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
        const anchorSurface = expression.anchorSurfaceForm.trim();
        if (anchorSurface.length === 0 || !matchedAnchorForms.has(anchorSurface.toLowerCase())) {
          continue;
        }

        const escapedAnchor = escapeRegex(anchorSurface);

        // `not` ("X 말고"): the anchor is being EXCLUDED — strip it so it never
        // becomes a hard include filter.
        if (expression.operator === 'not') {
          sanitizedQuery = sanitizedQuery
            .replace(new RegExp(`${escapedAnchor}${KOREAN_NOT_MARKER_PATTERN}`, 'u'), ' ')
            .replace(new RegExp(`${ENGLISH_NOT_MARKER_PATTERN}${escapedAnchor}`, 'iu'), ' ');
          continue;
        }

        // `similar_to` ("X 비슷한"): the anchor is a REFERENCE POINT for the
        // similarity neighbourhood, NOT a hard filter. Strip the anchor surface
        // (with its similarity marker) from the constraint-parsing query so the
        // compiler does not promote it to hard appellation/region/country
        // constraints that coarse-prune every candidate to zero. The anchor is
        // still carried for retrieval via `relativeQuery` / the `similar_items`
        // mode. Non-anchor intent words (e.g. 레드 → wine_type) are preserved.
        if (expression.operator === 'similar_to') {
          sanitizedQuery = sanitizedQuery
            .replace(new RegExp(`${escapedAnchor}${KOREAN_SIMILARITY_MARKER_PATTERN}`, 'u'), ' ')
            .replace(new RegExp(`${ENGLISH_SIMILARITY_MARKER_PATTERN}${escapedAnchor}`, 'iu'), ' ');
          continue;
        }
      }
    }

    if (shouldStripStrongEntityAnchorFromConstraintParsing(intent, anchors)) {
      sanitizedQuery = stripDominantAnchorTokens(sanitizedQuery, matchedAnchorForms, intent);
    }

    return sanitizedQuery.replace(/\s+/gu, ' ').trim();
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

    // C3: single batch lookup for the full-query surface + every anchor form.
    // Previously these were 1 + N sequential awaits; on remote substrates this
    // dominated planner wall-time for popular grape queries.
    const uncertaintySurfaceForms = [
      uncertaintyQuerySurface,
      ...anchors.map((a) => a.normalizedForm),
    ];
    const uncertaintyAmbiguityMap =
      uncertaintySurfaceForms.length > 0
        ? await this.ambiguityDict.getAmbiguityInfoBatch(uncertaintySurfaceForms)
        : new Map<string, AmbiguityInfo>();

    const fullQueryInfo = uncertaintyAmbiguityMap.get(uncertaintyQuerySurface) ?? null;
    if (fullQueryInfo !== null) {
      ambiguityTypes.add(KNOWN_AMBIGUOUS_SURFACE_TYPE);
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

    const convergedExactEntityLookup =
      intent === 'entity_exact'
      && queryClass === 'short_entity'
      && retrievalMode === 'entity_lookup'
      && anchors.length === 1
      && anchors[0] !== undefined
      && anchors[0].confidence >= EXACT_ANCHOR_CONFIDENCE
      && anchors[0].candidateEntityIds.length === 1;

    if (convergedExactEntityLookup && fullQueryInfo === null) {
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

    // Per-anchor aggregation uses the already-fetched batch map above — zero
    // additional awaits. C3: was previously a per-anchor sequential
    // `await getAmbiguityInfo(...)` loop, which on popular grape queries
    // (50–200 alias-matched anchors against a remote PG/RDS substrate)
    // accumulated 15–25 seconds of planner latency.
    for (const anchor of anchors) {
      // Multiple candidate entities -> ambiguous.
      if (anchor.candidateEntityIds.length > 1) {
        ambiguityTypes.add('multiple_candidates');
      }

      const info = uncertaintyAmbiguityMap.get(anchor.normalizedForm);
      if (info !== undefined) {
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
}
