import type { QueryClass, ConstraintBundle } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../model/query-plan.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { QueryUncertainty } from '../model/query-uncertainty.js';
import type { SessionContext } from '../model/session-context.js';
import type { QueryBudget } from '../model/query-budget.js';
import type { QueryTargetType } from '../model/query-target-type.js';
import { DEFAULT_QUERY_BUDGET } from '../model/query-budget.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../model/threshold-profile.js';
import type { AmbiguityDictionary } from '../port/ambiguity-dictionary.port.js';
import { type AnchorExtractor } from './anchor-extractor.js';
import { type ExpansionBuilder } from './expansion-builder.js';
import { PolicyCompiler } from './policy-compiler.js';
import { type NLMapper } from '../../attribute/service/nl-mapper.js';
import { QueryNormalizer } from './query-normalizer.js';

/** Current planner version. */
const PLANNER_VERSION = '1.0.0';

/** Version tag applied to all rule-based constraints (RFC-004, RFC-005). */
const RULE_BASED_MAPPING_VERSION = 'rule-based-v1.0';

/** Current policy rule version. */
const POLICY_RULE_VERSION = '1.0.0';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Price-related keywords for budget search detection. */
const PRICE_KEYWORDS: readonly RegExp[] = [
  /\d+\s*(?:원|만원|dollar|usd|\$|€|£)/i,
  /\b(?:under|below|cheaper|budget|affordable)\b|(?:저렴|싼|가성비)/i,
  /만원\s*(?:이하|미만|대)/,
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

/** Vintage year pattern to detect explicit vintage specification. */
const VINTAGE_YEAR_PATTERN = /\b(19|20)\d{2}\b/;

/** Region/location keywords for geographic entity detection. */
const REGION_KEYWORDS: readonly RegExp[] = [
  /\b(?:napa|sonoma|bordeaux|burgundy|tuscany|champagne)\b/i,
  /\b(?:valley|region|appellation|aoc|doc|doca|côtes|côte)\b/i,
  /\b(?:나파|샤블리|보르도|투지|롱글로|토스카나)\b/,
  /\b(?:지역|지방|아펠라시옹|지역명)\b/,
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
  private readonly queryNormalizer = new QueryNormalizer();

  constructor(
    private readonly ambiguityDict: AmbiguityDictionary,
    private readonly anchorExtractor: AnchorExtractor,
    private readonly expansionBuilder: ExpansionBuilder,
    private readonly nlMapper: NLMapper,
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
   * 7. Parse constraints (placeholder -- returns empty bundle).
   * 8. Build expansions.
   * 9. Compute uncertainty.
   * 10. Compile policy.
   *
   * @param query - The raw user query string.
   * @param context - Optional planner context (locale, session, budget).
   * @returns An immutable query plan.
   */
  async plan(query: string, context?: PlannerContext): Promise<QueryPlanV1> {
    // 1. Normalize.
    const queryViews = this.queryNormalizer.normalize(query);
    const normalizedQuery = queryViews.accentless;

    // 2. Extract anchors.
    const anchors = await this.anchorExtractor.extract(normalizedQuery, queryViews);

    // 3. Detect intent.
    const intent = this.detectIntent(normalizedQuery, anchors);

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

    // 6. Parse constraints.
    const constraints = await this.parseConstraints(normalizedQuery);

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

    return {
      rawQuery: query,
      normalizedQuery,
      normalizedQueryViews: queryViews,
      intent,
      ...(secondaryIntents !== undefined && { secondaryIntents }),
      route,
      retrievalMode,
      queryClass,
      anchors,
      constraints,
      expansions,
      policy,
      uncertainty,
      plannerVersion: PLANNER_VERSION,
      policyRuleVersion: POLICY_RULE_VERSION,
      thresholdProfileId: DEFAULT_THRESHOLD_PROFILE.id,
      admission_context,
      ...(context?.session !== undefined && { sessionContext: context.session }),
      queryBudget: budget,
      ...(targetEntityType !== undefined && { targetEntityType }),
    };
  }

  /**
   * Detects the primary intent based on anchors, patterns, and keywords.
   *
   * Multi-stage detection with confidence-aware fallback:
   * 1. Fuzzy/exact matching from anchors (high confidence scores)
   * 2. Comparison and mixed-query markers (requires anchor presence)
   * 3. Constraint keywords with/without anchors
   * 4. Pairing and budget markers
   * 5. Default semantic discovery
   *
   * Key improvements (SOTA++ §1-2):
   * - Respects anchor confidence thresholds for intent determination
   * - Treats weak anchors (0.5-0.85) differently than strong (≥0.85)
   * - Prefers entity_fuzzy when weak anchor + found results
   * - Escalates to mixed_query when constraints present with any anchor
   */
  private detectIntent(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): QueryIntent {
    const hasStrongAnchor = anchors.some(
      (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
    );
    const hasWeakAnchor = anchors.some(
      (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE &&
        a.confidence < EXACT_ANCHOR_CONFIDENCE,
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

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 1: Comparison detection (requires explicit markers + anchors)
    // ───────────────────────────────────────────────────────────────────────
    if (hasComparisonMarker && hasAnyAnchor) {
      return 'comparison_search';
    }
    if (anchors.length >= 2 && hasComparisonMarker) {
      return 'comparison_search';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 2: Korean mixed-query detection (requires marker + anchor)
    // ───────────────────────────────────────────────────────────────────────
    if (hasKoreanMixed && hasAnyAnchor) {
      return 'mixed_query';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 3: Strong single anchor handling
    // ───────────────────────────────────────────────────────────────────────
    // Strong anchor with constraint keywords -> mixed (entity + filters).
    if (hasStrongAnchor && hasConstraintKeyword) {
      return 'mixed_query';
    }

    // Strong single anchor, no constraints -> exact entity.
    if (hasStrongAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
      return 'entity_exact';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 4: Weak anchor (0.5-0.85) handling — SOTA++ improvement
    // ───────────────────────────────────────────────────────────────────────
    // Weak anchor without constraints -> fuzzy entity (found some wines but need disambiguation).
    if (hasWeakAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
      return 'entity_fuzzy';
    }

    // Weak anchor + constraints -> mixed (apply filters to anchor set).
    if (hasWeakAnchor && (hasConstraintKeyword || hasPriceKeyword)) {
      return 'mixed_query';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 5: Any anchor + constraints (catch-all for anchor + filters)
    // ───────────────────────────────────────────────────────────────────────
    if (hasAnyAnchor && (hasConstraintKeyword || hasPriceKeyword)) {
      return 'mixed_query';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 6: Pairing and budget keywords (no anchor required)
    // ───────────────────────────────────────────────────────────────────────
    if (hasPairingKeyword) {
      return 'pairing_search';
    }

    // Budget/price keywords without entity.
    if (hasPriceKeyword) {
      return 'budget_search';
    }

    // ───────────────────────────────────────────────────────────────────────
    // STAGE 7: Pure constraint keywords (no anchor)
    // ───────────────────────────────────────────────────────────────────────
    if (hasConstraintKeyword) {
      return 'facet_search';
    }

    // ───────────────────────────────────────────────────────────────────────
    // DEFAULT: Semantic discovery (no anchors, no keywords)
    // ───────────────────────────────────────────────────────────────────────
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
   */
  private determineRetrievalMode(
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
    _normalizedQuery: string,
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
  private static readonly SOFT_ATTRIBUTES = new Set([
    'body', 'sweetness', 'acidity', 'tannin', 'style',
    'price_band', 'occasion',
  ]);

  /**
   * Maximum n-gram size (in whitespace-delimited tokens) to probe against
   * the NL mapping table. Covers all known multi-word phrases.
   */
  private static readonly MAX_NGRAM_TOKENS = 3;

  /**
   * Parses constraints from the normalized query by scanning for known
   * natural-language phrases via the NLMapper.
   *
   * Generates token n-grams (up to {@link MAX_NGRAM_TOKENS} tokens) from the
   * query and probes each against the mapping table. Matched constraints are
   * classified as hard (body, sweetness, etc.) or soft (price_band, occasion).
   */
  private async parseConstraints(
    normalizedQuery: string,
  ): Promise<ConstraintBundle> {
    const tokens = normalizedQuery.split(/\s+/);
    const candidatePhrases: string[] = [];

    for (
      let i = 0;
      i < tokens.length;
      i++
    ) {
      const maxEnd = Math.min(
        tokens.length,
        i + Planner.MAX_NGRAM_TOKENS,
      );
      for (let j = i + 1; j <= maxEnd; j++) {
        candidatePhrases.push(tokens.slice(i, j).join(' '));
      }
    }

    const matched = await this.nlMapper.mapConstraints(candidatePhrases);

    const hard: ConstraintBundle['hard'][number][] = [];
    const soft: ConstraintBundle['soft'][number][] = [];

    for (const constraint of matched) {
      if (Planner.SOFT_ATTRIBUTES.has(constraint.attribute)) {
        soft.push(constraint);
      } else {
        hard.push(constraint);
      }
    }

    // RFC-005: When NLMapper returns nothing (e.g. noOpMappingTable in test
    // or cold-start configs), fall back to rule-based extraction so that
    // wine_type, country, and sensory constraints are never silently dropped.
    if (hard.length === 0 && soft.length === 0) {
      return this.extractRuleBasedConstraints(normalizedQuery);
    }

    return { hard, soft, inferred: [] };
  }

  /**
   * Rule-based constraint extractor: pattern-matches the normalized query
   * directly without a mapping table.
   *
   * Covers the most common wine-domain constraints:
   *   - wine_type  (hard)  — red / white / rosé / sparkling / natural / dessert
   *   - country    (hard)  — France / Italy / Spain / USA / etc.
   *   - price_band (soft)  — "under $50", "만원 이하"
   *   - body       (soft)  — full-body / light-body
   *   - sweetness  (soft)  — dry / sweet
   *
   * Operates as a fallback only; NLMapper takes precedence when available.
   */
  private extractRuleBasedConstraints(normalizedQuery: string): ConstraintBundle {
    const hard: ConstraintBundle['hard'][number][] = [];
    const soft: ConstraintBundle['soft'][number][] = [];
    const q = normalizedQuery;

    // ── Wine type (hard) ───────────────────────────────────────────────────
    const wineTypeRules: [RegExp, string][] = [
      [/\b(?:red|rouge|레드|적포도주)\b/i, 'red'],
      [/\b(?:white|blanc|화이트|백포도주)\b/i, 'white'],
      [/\bros[eé]|로제\b/i, 'rosé'],
      [/\b(?:sparkling|스파클링|champagne|샴페인|prosecco|cava|크레망)\b/i, 'sparkling'],
      [/\b(?:natural wine|내추럴 와인|내추럴)\b/i, 'natural'],
      [/\b(?:dessert wine|디저트 와인|sauternes|icewine)\b/i, 'dessert'],
      [/\b(?:fortified|주정강화|port|sherry|madeira|marsala)\b/i, 'fortified'],
      [/\b(?:orange wine|오렌지 와인|amber wine)\b/i, 'orange'],
    ];
    for (const [pattern, value] of wineTypeRules) {
      if (pattern.test(q)) {
        hard.push({
          attribute: 'wine_type',
          operator: '=',
          value,
          source_phrase: value,
          confidence: 0.9,
          mapping_version: RULE_BASED_MAPPING_VERSION,
        });
        break; // Only one wine_type per query
      }
    }

    // ── Country (hard) ─────────────────────────────────────────────────────
    const countryRules: [RegExp, string][] = [
      [/\b(?:french|france|프랑스)\b/i, 'France'],
      [/\b(?:italian|italy|이탈리아)\b/i, 'Italy'],
      [/\b(?:spanish|spain|스페인)\b/i, 'Spain'],
      [/\b(?:american|usa|us wine|california|napa|sonoma|oregon|미국)\b/i, 'USA'],
      [/\b(?:australian|australia|호주)\b/i, 'Australia'],
      [/\b(?:argentinian|argentina|아르헨티나)\b/i, 'Argentina'],
      [/\b(?:chilean|chile|칠레)\b/i, 'Chile'],
      [/\b(?:german|germany|독일)\b/i, 'Germany'],
      [/\b(?:portuguese|portugal|포르투갈)\b/i, 'Portugal'],
      [/\b(?:new zealand|뉴질랜드)\b/i, 'New Zealand'],
      [/\b(?:south african?|south africa|남아공)\b/i, 'South Africa'],
      [/\b(?:austrian|austria|오스트리아)\b/i, 'Austria'],
    ];
    for (const [pattern, value] of countryRules) {
      if (pattern.test(q)) {
        hard.push({
          attribute: 'country',
          operator: '=',
          value,
          source_phrase: value,
          confidence: 0.85,
          mapping_version: RULE_BASED_MAPPING_VERSION,
        });
        break; // Only one country per query
      }
    }

    // ── Price band (soft) ──────────────────────────────────────────────────
    // Korean \b word boundary doesn't work with Hangul. Use (?:^|\s|\d) anchors instead.
    const priceUnder =
      /\bunder\s+\$?(\d+)\b/i.exec(q) ??
      /(\d+)\s*(?:달러|dollar)\s*이하/i.exec(q) ??
      /(\d+)\s*만원\s*(?:이하|미만|대)/i.exec(q);
    if (priceUnder?.[1] !== undefined) {
      const priceValue = parseInt(priceUnder[1], 10);
      // 만원 unit in Korean (1만원 ≈ $7)
      const usd = /만원/.test(q) ? priceValue * 7 : priceValue;
      const band =
        usd <= 20 ? 'budget' : usd <= 50 ? 'mid' : usd <= 100 ? 'premium' : 'luxury';
      soft.push({
        attribute: 'price_band',
        operator: '=',
        value: band,
        source_phrase: priceUnder[0],
        confidence: 0.8,
        mapping_version: RULE_BASED_MAPPING_VERSION,
      });
    }

    // ── Body (soft) ────────────────────────────────────────────────────────
    if (/\b(?:full[\s-]?body|풀바디|bold|heavy|묵직)\b/i.test(q)) {
      soft.push({
        attribute: 'body',
        operator: '=',
        value: 'full',
        source_phrase: 'full-body',
        confidence: 0.75,
        mapping_version: RULE_BASED_MAPPING_VERSION,
      });
    } else if (/\b(?:light[\s-]?body|라이트바디|light wine|가벼운|가볍)\b/i.test(q)) {
      soft.push({
        attribute: 'body',
        operator: '=',
        value: 'light',
        source_phrase: 'light-body',
        confidence: 0.75,
        mapping_version: RULE_BASED_MAPPING_VERSION,
      });
    }

    // ── Sweetness (soft) ───────────────────────────────────────────────────
    if (/\b(?:dry wine|드라이|brut|extra[\s-]?brut)\b/i.test(q)) {
      soft.push({
        attribute: 'sweetness',
        operator: '=',
        value: 'dry',
        source_phrase: 'dry',
        confidence: 0.8,
        mapping_version: RULE_BASED_MAPPING_VERSION,
      });
    } else if (/\b(?:sweet wine|달콤한|스위트|demi[\s-]?sec|semi[\s-]?sweet)\b/i.test(q)) {
      soft.push({
        attribute: 'sweetness',
        operator: '=',
        value: 'sweet',
        source_phrase: 'sweet',
        confidence: 0.8,
        mapping_version: RULE_BASED_MAPPING_VERSION,
      });
    }

    return { hard, soft, inferred: [] };
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
