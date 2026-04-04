import type { QueryClass, ConstraintBundle } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../model/query-plan.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { QueryUncertainty } from '../model/query-uncertainty.js';
import type { SessionContext } from '../model/session-context.js';
import type { QueryBudget } from '../model/query-budget.js';
import { DEFAULT_QUERY_BUDGET } from '../model/query-budget.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../model/threshold-profile.js';
import type { AmbiguityDictionary } from '../port/ambiguity-dictionary.port.js';
import { type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { PolicyCompiler } from './policy-compiler.js';
import { normalizeUnicode } from '../../shared/utils/unicode-normalize.js';

/** Current planner version. */
const PLANNER_VERSION = '1.0.0';

/** Current policy rule version. */
const POLICY_RULE_VERSION = '1.0.0';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Price-related keywords for budget search detection. */
const PRICE_KEYWORDS: readonly RegExp[] = [
  /\b\d+\s*(?:원|만원|dollar|usd|\$|€|£)\b/i,
  /\b(?:under|below|cheaper|budget|affordable|저렴|싼|가성비)\b/i,
  /\b(?:만원\s*(?:이하|미만|대))\b/,
] as const;

/** Pairing-related keywords. */
const PAIRING_KEYWORDS: readonly RegExp[] = [
  /\b(?:pair|pairing|goes?\s+with|match|accompany)\b/i,
  /\b(?:어울리|곁들|맞는|페어링)\b/,
  /\b(?:steak|fish|cheese|chicken|pasta|pizza|beef|pork|seafood)\b/i,
  /\b(?:스테이크|생선|치즈|치킨|파스타|피자|소고기|돼지고기|해산물)\b/,
] as const;

/** Constraint keywords indicating structured filtering. */
const CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  /\b(?:red|white|rose|sparkling|natural)\b/i,
  /\b(?:레드|화이트|로제|스파클링|내추럴)\b/,
  /\b(?:from|region|grape|variety|vintage|year)\b/i,
  /\b(?:지역|품종|빈티지|연도)\b/,
  /\b(?:dry|sweet|tannic|fruity|oaky|light|full[\s-]?body)\b/i,
  /\b(?:드라이|스위트|타닌|과일|오크|라이트|풀바디)\b/,
] as const;

/**
 * Context passed to the planner alongside the raw query.
 */
export interface PlannerContext {
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
 * and policy compilation into a single immutable {@link QueryPlanV1}.
 *
 * Deterministic: the same input query, planner version, and policy rule
 * version always produce the same plan.
 */
export class Planner {
  private readonly policyCompiler = new PolicyCompiler();

  constructor(
    private readonly ambiguityDict: AmbiguityDictionary,
    private readonly anchorExtractor: AnchorExtractor,
    private readonly expansionBuilder: ExpansionBuilder,
  ) {}

  /**
   * Plans a query by executing the full planning pipeline.
   *
   * Pipeline stages:
   * 1. Normalize query.
   * 2. Extract anchors.
   * 3. Detect intent.
   * 4. Determine route.
   * 5. Determine query class.
   * 6. Parse constraints (placeholder -- returns empty bundle).
   * 7. Build expansions.
   * 8. Compute uncertainty.
   * 9. Compile policy.
   *
   * @param query - The raw user query string.
   * @param context - Optional planner context (locale, session, budget).
   * @returns An immutable query plan.
   */
  async plan(query: string, context?: PlannerContext): Promise<QueryPlanV1> {
    // 1. Normalize.
    const normalizedQuery = this.normalizeQuery(query);

    // 2. Extract anchors.
    const anchors = await this.anchorExtractor.extract(normalizedQuery);

    // 3. Detect intent.
    const intent = this.detectIntent(normalizedQuery, anchors);

    // 4. Determine route.
    const route = this.determineRoute(intent, anchors);

    // 5. Determine query class.
    const queryClass = await this.determineQueryClass(
      normalizedQuery,
      intent,
      anchors,
    );

    // 6. Parse constraints.
    const constraints = this.parseConstraints(normalizedQuery);

    // 7. Build expansions.
    const expansions = this.expansionBuilder.build(
      normalizedQuery,
      intent,
      anchors,
    );

    // 8. Compute uncertainty.
    const uncertainty = await this.computeUncertainty(
      normalizedQuery,
      anchors,
      constraints,
    );

    // 9. Compile policy.
    const policy = this.policyCompiler.compile(
      intent,
      queryClass,
      anchors,
      uncertainty,
    );

    const budget = context?.budget ?? DEFAULT_QUERY_BUDGET;

    return {
      rawQuery: query,
      normalizedQuery,
      intent,
      route,
      queryClass,
      anchors,
      constraints,
      expansions,
      policy,
      uncertainty,
      plannerVersion: PLANNER_VERSION,
      policyRuleVersion: POLICY_RULE_VERSION,
      thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
      sessionContext: context?.session,
      queryBudget: budget,
    };
  }

  /**
   * Normalizes a query string: strips accents from Latin characters only
   * (preserving Korean and other non-Latin scripts), lowercases, and
   * collapses contiguous whitespace.
   *
   * Uses NFC normalization to preserve Korean syllable blocks. NFD is applied
   * only to extract Latin combining marks before recomposing to NFC, so
   * Korean Jamo are never left in decomposed form.
   */
  private normalizeQuery(query: string): string {
    // 1. Apply homoglyph normalization and whitespace collapse via shared util
    //    (NFC-safe: preserves Korean syllables).
    let result = normalizeUnicode(query);

    // 2. Strip accents only from Latin-range characters (U+0000–U+024F).
    //    We decompose to NFD, remove combining marks that follow a Latin base,
    //    then recompose to NFC so Korean blocks are never split apart.
    result = result
      .normalize('NFD')
      .replace(/(?<=[A-Za-z\u00C0-\u024F])[\u0300-\u036f]+/g, '')
      .normalize('NFC');

    // 3. Lowercase and final whitespace collapse.
    result = result.toLowerCase().replace(/\s+/g, ' ').trim();

    return result;
  }

  /**
   * Detects the primary intent based on anchors, patterns, and keywords.
   */
  private detectIntent(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): QueryIntent {
    const hasStrongAnchor = anchors.some(
      (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
    );
    const hasAnyAnchor = anchors.some(
      (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
    );
    const hasComparisonMarker =
      this.anchorExtractor.hasComparisonMarkers(normalizedQuery);
    const hasKoreanMixed =
      this.anchorExtractor.hasKoreanMixedQueryMarkers(normalizedQuery);
    const hasPriceKeyword = PRICE_KEYWORDS.some((re) =>
      re.test(normalizedQuery),
    );
    const hasPairingKeyword = PAIRING_KEYWORDS.some((re) =>
      re.test(normalizedQuery),
    );
    const hasConstraintKeyword = CONSTRAINT_KEYWORDS.some((re) =>
      re.test(normalizedQuery),
    );

    // Comparison: two+ anchors or explicit comparison marker with anchor.
    if (hasComparisonMarker && hasAnyAnchor) {
      return 'comparison_search';
    }
    if (anchors.length >= 2 && hasComparisonMarker) {
      return 'comparison_search';
    }

    // Korean mixed-query markers with an anchor -> mixed.
    if (hasKoreanMixed && hasAnyAnchor) {
      return 'mixed_query';
    }

    // Strong anchor with constraint keywords -> mixed.
    if (hasStrongAnchor && hasConstraintKeyword) {
      return 'mixed_query';
    }

    // Strong single anchor, no constraints -> exact entity.
    if (hasStrongAnchor) {
      return 'entity_exact';
    }

    // Weak anchor -> fuzzy entity.
    if (hasAnyAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
      return 'entity_fuzzy';
    }

    // Anchor + constraints -> mixed.
    if (hasAnyAnchor && (hasConstraintKeyword || hasPriceKeyword)) {
      return 'mixed_query';
    }

    // Pairing keywords.
    if (hasPairingKeyword) {
      return 'pairing_search';
    }

    // Budget/price keywords without entity.
    if (hasPriceKeyword) {
      return 'budget_search';
    }

    // Constraint keywords without entity.
    if (hasConstraintKeyword) {
      return 'facet_search';
    }

    // Default: semantic discovery.
    return 'semantic_discovery';
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
   * Determines the query class based on intent, anchors, and ambiguity.
   */
  private async determineQueryClass(
    normalizedQuery: string,
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): Promise<QueryClass> {
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
      if (totalCandidates > 1 && anchors.some((a) => a.confidence < 0.8)) {
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
    }
  }

  /**
   * Parses constraints from the normalized query.
   *
   * This is a placeholder implementation. A full constraint parser would
   * use NLP or rule-based extraction to identify hard/soft/inferred constraints.
   * For now, returns an empty bundle to satisfy the type contract.
   */
  private parseConstraints(_normalizedQuery: string): ConstraintBundle {
    return {
      hard: [],
      soft: [],
      inferred: [],
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
    const parserConfidence = Math.max(0.5, Math.min(1.0, 1.0 - tokenCount * 0.05));

    // Anchor confidence: max anchor confidence, or 0 if no anchors.
    const anchorConfidence =
      anchors.length > 0
        ? Math.max(...anchors.map((a) => a.confidence))
        : 0;

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
        : 0.5; // neutral when no constraints expected

    // Detect ambiguity from anchors and dictionary.
    const ambiguityTypes: string[] = [];
    let ambiguitySeverity: QueryUncertainty['ambiguitySeverity'] = 'low';

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
    if (anchors.length > 0 && anchorConfidence < 0.6) {
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
        1.0 -
          0.3 * parserConfidence -
          0.4 * anchorConfidence -
          0.3 * constraintConfidence +
          (ambiguityDetected ? 0.15 : 0),
      ),
    );

    // Decision effect based on severity.
    let decisionEffect: QueryUncertainty['decisionEffect'];
    if (ambiguitySeverity === 'high') {
      decisionEffect = 'force_clarify';
    } else if (ambiguitySeverity === 'medium' || overall >= 0.6) {
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
}
