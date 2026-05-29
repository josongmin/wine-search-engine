import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { AmbiguousEntityHint } from '../../domain/attribute/model/ambiguous-entity-hint.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import {
  filterBindingInferredConstraints,
  type CanonicalEntityId,
} from '../../domain/shared/types/index.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import {
  isSemanticSoftIntentAttribute,
  softIntentRetrievalPhrases,
  shouldRunTypedRecommendationDiscoveryForSoftIntent,
} from '../../domain/query/service/soft-intent-strategy-table.js';
import { recipientProfileToRetrievalTerms } from '../../domain/query/service/recipient-situation-profile.js';
import type { WineTypeValue } from '../../domain/query/model/wine-type-patterns.js';

export function buildHybridRetrievalInputForPlan(
  plan: QueryPlanV1,
  route: HybridRetrievalInput['route'] = 'hybrid',
  anchorEntityId?: CanonicalEntityId,
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
): HybridRetrievalInput {
  const retrievalPlan = compiled?.query.retrievalPlan ?? buildRetrievalPlan(plan.constraints);
  const retrievalObjective = compiled?.query.retrievalObjective ?? buildRetrievalObjective(plan.constraints);
  const structuredQueries = buildStructuredQueryExpansions(plan, retrievalPlan);
  const ambiguitySoftConstraints = buildAmbiguousEntityHintSoftConstraints(plan.expansions.ambiguousEntityHints);
  // TA4: Propagate fuzzy entity hypothesis terms from the planner into the retrieval
  // input. When the planner's fuzzy matcher fires on an anchor-miss query, these terms
  // are entity hypothesis seeds that enable the entity-first dual retrieval path.
  const fuzzyEntityHypotheses = plan.expansions.fuzzyEntityHypotheses;
  return {
    queryPlan: plan,
    route,
    ...(compiled !== undefined ? { compiledRetrievalMode: compiled.execution.effectiveRetrievalMode } : {}),
    ...(compiled !== undefined
      ? { executionBudgetMaxCandidates: compiled.execution.budget.maxCandidates }
      : {}),
    lexicalQueries: buildPlanLexicalQueryVariants(plan, structuredQueries.lexical),
    semanticQueries: buildPlanSemanticQueryVariants(plan, structuredQueries.semantic),
    semanticEmbeddingQueries: buildPlanSemanticEmbeddingQueryVariants(plan, structuredQueries.semantic),
    hardConstraints: plan.constraints.hard,
    softConstraints: [
      ...plan.constraints.soft,
      ...ambiguitySoftConstraints,
    ],
    retrievalPlan,
    retrievalObjective,
    // ADR-014 Phase 1b.3b: propagate the compiled constraint graph so
    // candidate-pool's annotator can emit per-atom slot records.
    ...(compiled?.constraintGraph !== undefined
      ? { constraintGraph: compiled.constraintGraph }
      : {}),
    ...(anchorEntityId !== undefined ? { anchorEntityId } : {}),
    ...(requestContext !== undefined ? { requestContext } : {}),
    // T-IR-01: carry the path-selected retrieval lane down to the candidate
    // pool so `/v1/search/semantic` and `/v1/search/lexical` actually skip
    // the opposite leg instead of running a full hybrid pass.
    ...(requestContext?.retrievalLane !== undefined
      ? { retrievalLane: requestContext.retrievalLane }
      : {}),
    ...(fuzzyEntityHypotheses != null && fuzzyEntityHypotheses.length > 0
      ? { entityHypothesisTerms: fuzzyEntityHypotheses }
      : {}),
  };
}

export function buildStructuredQueryExpansions(
  plan: QueryPlanV1,
  retrievalPlan: ReturnType<typeof buildRetrievalPlan>,
): {
  readonly lexical: readonly string[];
  readonly semantic: readonly string[];
} {
  const lexical: string[] = [];
  const semantic: string[] = [];
  const wineTypeContext = resolveWineTypeContextFromConstraints(plan.constraints.hard);
  for (const constraint of plan.constraints.hard) {
    const lexicalPhrases = retrievalValueToPhrases(
      constraint.attribute,
      constraint.value,
      wineTypeContext,
      constraint.operator,
      'lexical',
    );
    if (lexicalPhrases.length > 0) {
      lexical.push(...lexicalPhrases);
    }
    if (isSemanticRetrievalExpansionAttribute(constraint.attribute)) {
      const semanticPhrases = retrievalValueToPhrases(
        constraint.attribute,
        constraint.value,
        wineTypeContext,
        constraint.operator,
        'semantic',
      );
      if (semanticPhrases.length > 0) {
        semantic.push(...semanticPhrases);
      }
    }
  }
  for (const boost of [...retrievalPlan.softBoosts, ...retrievalPlan.inferredBoosts]) {
    const lexicalPhrases = retrievalValueToPhrases(
      boost.attribute,
      boost.value,
      wineTypeContext,
      boost.operator,
      'lexical',
    );
    if (lexicalPhrases.length > 0) {
      lexical.push(...lexicalPhrases);
    }
    if (isSemanticRetrievalExpansionAttribute(boost.attribute)) {
      const semanticPhrases = retrievalValueToPhrases(
        boost.attribute,
        boost.value,
        wineTypeContext,
        boost.operator,
        'semantic',
      );
      if (semanticPhrases.length > 0) {
        semantic.push(...semanticPhrases);
      }
    }
  }
  for (const hint of plan.expansions.ambiguousEntityHints ?? []) {
    lexical.push(...hint.lexicalExpansions);
    semantic.push(...hint.semanticExpansions);
  }
  return { lexical: uniqueStrings(lexical), semantic: uniqueStrings(semantic) };
}

export function buildAmbiguousEntityHintSoftConstraints(
  hints: readonly AmbiguousEntityHint[] | undefined,
): readonly NormalizedConstraint[] {
  if (hints === undefined || hints.length === 0) {
    return [];
  }

  return hints.map((hint) => ({
    attribute: hint.retrievalConstraint.attribute,
    operator: hint.retrievalConstraint.operator,
    value: hint.retrievalConstraint.value,
    source_phrase: `ambiguous_entity_hint(${hint.surface})`,
    confidence: 0.7,
    mapping_version: 'ambiguous-entity-hint-v1',
  }));
}

export function isWineTypeValue(value: unknown): value is WineTypeValue {
  return value === 'red'
    || value === 'white'
    || value === 'rosé'
    || value === 'sparkling'
    || value === 'natural'
    || value === 'dessert'
    || value === 'fortified'
    || value === 'orange';
}

function resolveWineTypeContextFromConstraints(
  constraints: readonly QueryPlanV1['constraints']['hard'][number][],
): WineTypeValue | undefined {
  for (const constraint of constraints) {
    if (constraint.attribute !== 'wine_type') continue;
    if (typeof constraint.value === 'string' && isWineTypeValue(constraint.value)) {
      return constraint.value;
    }
    if (Array.isArray(constraint.value)) {
      const matched = constraint.value.find(isWineTypeValue);
      if (matched !== undefined) {
        return matched;
      }
    }
  }
  return undefined;
}

function isSemanticRetrievalExpansionAttribute(attribute: string): boolean {
  return attribute === 'region'
    || attribute === 'country'
    || attribute === 'appellation'
    || attribute === 'closure'
    || attribute === 'grape_family'
    || attribute === 'grape_primary'
    || attribute === 'flavor_profile'
    || attribute === 'certification'
    || attribute === 'pairing'
    || attribute === 'recipient_profile'
    || isSemanticSoftIntentAttribute(attribute);
}

export function retrievalValueToPhrases(
  attribute: string,
  value: unknown,
  wineTypeContext?: WineTypeValue,
  operator?: NormalizedConstraint['operator'],
  channel: 'lexical' | 'semantic' = 'lexical',
): readonly string[] {
  if (attribute === 'recipient_profile') {
    if (typeof value === 'string') {
      return recipientProfileToRetrievalTerms(value);
    }
    if (Array.isArray(value)) {
      return [
        ...new Set(
          value
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .flatMap((entry) => recipientProfileToRetrievalTerms(entry)),
        ),
      ];
    }
  }

  const softIntentPhrases = softIntentRetrievalPhrases(attribute, value, wineTypeContext, channel);
  if (softIntentPhrases !== undefined) {
    return softIntentPhrases;
  }

  if (shouldSuppressGenericNumericRetrievalPhrase(operator, value)) {
    return [];
  }

  const phrase = retrievalValueToPhrase(value);
  return phrase !== undefined ? [phrase] : [];
}

function shouldSuppressGenericNumericRetrievalPhrase(
  operator: NormalizedConstraint['operator'] | undefined,
  value: unknown,
): boolean {
  if (operator === 'range') {
    return true;
  }
  if ((operator === '>=' || operator === '<=') && typeof value === 'number') {
    return true;
  }
  return false;
}

function retrievalValueToPhrase(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : undefined;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'min' in value
    && 'max' in value
  ) {
    const min = typeof value.min === 'number' ? value.min.toString() : undefined;
    const max = typeof value.max === 'number' ? value.max.toString() : undefined;
    return [min, max].filter((entry): entry is string => entry !== undefined).join(' ');
  }
  return undefined;
}

function constraintValueToStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  return [];
}

function hasExplicitWineTypeConstraint(
  constraints: readonly QueryPlanV1['constraints']['hard'][number][],
): boolean {
  return resolveWineTypeContextFromConstraints(constraints) !== undefined;
}

function hasGiftOccasionPreference(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...filterBindingInferredConstraints(plan.constraints.inferred)].some((constraint) =>
    constraint.attribute === 'occasion'
    && constraintValueToStrings(constraint.value)
      .some((value) => value.trim().toLowerCase() === 'gift'),
  );
}

function hasTypedRecommendationSoftIntent(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...filterBindingInferredConstraints(plan.constraints.inferred)].some((constraint) =>
    shouldRunTypedRecommendationDiscoveryForSoftIntent(constraint.attribute, constraint.value),
  );
}

function hasClosurePreference(plan: QueryPlanV1): boolean {
  return [...plan.constraints.soft, ...filterBindingInferredConstraints(plan.constraints.inferred)].some((constraint) =>
    constraint.attribute === 'closure',
  );
}

export function shouldRunTypedRecommendationDiscovery(plan: QueryPlanV1): boolean {
  if (hasExplicitWineTypeConstraint(plan.constraints.hard)) {
    return false;
  }
  return hasGiftOccasionPreference(plan)
    || hasTypedRecommendationSoftIntent(plan)
    || hasClosurePreference(plan);
}

export function shouldRunAmbiguousEntityBranchExploration(plan: QueryPlanV1): boolean {
  return plan.expansions.ambiguousEntityHints?.some((hint) => hint.explorationBranches.length > 0) ?? false;
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildDenseSafeSemanticViews(
  plan: QueryPlanV1,
): readonly string[] {
  const views = plan.normalizedQueryViews;
  if (views === undefined) {
    return [];
  }

  if (views.semanticVariants.length > 0) {
    return views.semanticVariants;
  }

  return uniqueStrings([
    views.raw,
    views.accentless,
    views.punctuationStripped,
    views.vintageCanonicalized,
    views.vintageStripped,
    ...(views.transliterated !== undefined ? [views.transliterated] : []),
    ...(views.reordered ?? []),
  ]);
}

export function buildPlanLexicalQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.normalizedQuery,
    ...(plan.normalizedQueryViews?.lookupVariants ?? []),
    ...plan.expansions.lexical,
    ...extraTerms,
  ]);
}

export function buildPlanSemanticQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.rawQuery,
    ...(plan.normalizedQueryViews?.transliterated !== undefined
      ? [plan.normalizedQueryViews.transliterated]
      : []),
    ...plan.expansions.semantic,
    ...extraTerms,
  ]);
}

export function buildPlanSemanticEmbeddingQueryVariants(
  plan: QueryPlanV1,
  extraTerms: readonly string[] = [],
): readonly string[] {
  return uniqueStrings([
    plan.rawQuery,
    ...buildDenseSafeSemanticViews(plan),
    ...plan.expansions.semantic,
    ...extraTerms,
  ]);
}
