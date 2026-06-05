import type { ConstraintBundle, QueryClass } from '../../../domain/shared/types/index.js';
import type { QueryIntent } from '../../../domain/query/model/query-intent.js';
import type { QueryUncertainty } from '../../../domain/query/model/query-uncertainty.js';
import type { AnchorCandidate } from '../../../domain/query/model/anchor-candidate.js';
import { AnchorExtractor, type AliasMatcher } from '../../../domain/query/service/anchor-extractor.js';
import { buildAliasSurfaceLookupPlan } from '../../../domain/query/service/alias-lookup-plan.js';
import { buildNormalizedQueryViews } from '../../../domain/query/service/query-normalizer.js';
import { PolicyCompiler } from '../../../domain/query/service/policy-compiler.js';
import type { AmbiguityDictionary } from '../../../domain/query/port/ambiguity-dictionary.port.js';
import type {
  LookupExactSafeRegistryPort,
  LookupExactSafeMatch,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import { EXACT_IDENTITY_MIN_CONFIDENCE } from '../../../domain/resolver/v2/channel-provenance.js';
import {
  findRawQueryExactSafeSingletonAliasWitness,
  hasDeterministicSingletonAliasWitness,
} from '../../../domain/query/service/exact-safe-anchor-witness.js';
import type { LookupPlannerContext, LookupPlannerPort } from './lookup-planner.port.js';
import type { LookupQueryPlan } from './lookup-query-plan.js';

const EMPTY_CONSTRAINTS: ConstraintBundle = { hard: [], soft: [], inferred: [] };

export interface RuntimeLookupPlannerDeps {
  readonly aliasMatcher: AliasMatcher;
  readonly ambiguityDictionary?: AmbiguityDictionary | undefined;
  readonly exactSafeRegistry?: LookupExactSafeRegistryPort | undefined;
}

export class RuntimeLookupPlanner implements LookupPlannerPort {
  private readonly anchorExtractor: AnchorExtractor;
  private readonly policyCompiler = new PolicyCompiler();

  constructor(private readonly deps: RuntimeLookupPlannerDeps) {
    this.anchorExtractor = new AnchorExtractor(deps.aliasMatcher);
  }

  async plan(query: string, context?: LookupPlannerContext): Promise<LookupQueryPlan> {
    const normalizedQueryViews = buildNormalizedQueryViews(query);
    const normalizedQuery = normalizedQueryViews.strict;

    const exactSafeMatch = this.lookupExactSafe(normalizedQueryViews, context?.stageTimer);
    if (exactSafeMatch !== null) {
      const anchors = [buildExactSafeAnchor(query, normalizedQuery, exactSafeMatch)];
      return this.buildPlan({
        rawQuery: query,
        normalizedQuery,
        normalizedQueryViews,
        queryClass: 'exact_entity',
        intent: 'entity_exact',
        anchors,
        uncertainty: {
          overall: 0,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 1,
          anchorConfidence: 1,
          constraintConfidence: 1,
        },
      });
    }

    const persistedAmbiguity = await this.lookupPersistedAmbiguity(normalizedQuery, context);
    if (persistedAmbiguity !== null) {
      return this.buildPlan({
        rawQuery: query,
        normalizedQuery,
        normalizedQueryViews,
        queryClass: 'ambiguous_short_form',
        intent: 'entity_fuzzy',
        anchors: [],
        uncertainty: {
          overall: 0.95,
          ambiguityDetected: true,
          ambiguityTypes: [...persistedAmbiguity.types],
          ambiguitySeverity: persistedAmbiguity.severity,
          decisionEffect: 'force_clarify',
          parserConfidence: 1,
          anchorConfidence: 0,
          constraintConfidence: 1,
        },
      });
    }

    const anchors = await this.anchorExtractor.extract(
      normalizedQuery,
      normalizedQueryViews,
      context?.stageTimer,
    );
    const authorityAnchors = pruneLookupAuthorityAnchors(
      normalizedQuery,
      normalizedQueryViews,
      anchors,
    );

    const queryClass = classifyLookupQueryClass({
      rawQuery: query,
      normalizedQuery,
      anchors: authorityAnchors,
    });
    const intent: QueryIntent = queryClass === 'exact_entity' ? 'entity_exact' : 'entity_fuzzy';
    const uncertainty = buildLookupUncertainty(queryClass, authorityAnchors);
    return this.buildPlan({
      rawQuery: query,
      normalizedQuery,
      normalizedQueryViews,
      queryClass,
      intent,
      anchors: authorityAnchors,
      uncertainty,
    });
  }

  private buildPlan(args: {
    readonly rawQuery: string;
    readonly normalizedQuery: string;
    readonly normalizedQueryViews: ReturnType<typeof buildNormalizedQueryViews>;
    readonly queryClass: QueryClass;
    readonly intent: QueryIntent;
    readonly anchors: readonly AnchorCandidate[];
    readonly uncertainty: QueryUncertainty;
  }): LookupQueryPlan {
    return {
      rawQuery: args.rawQuery,
      normalizedQuery: args.normalizedQuery,
      normalizedQueryViews: args.normalizedQueryViews,
      queryClass: args.queryClass,
      anchors: args.anchors,
      constraints: EMPTY_CONSTRAINTS,
      policy: this.policyCompiler.compile(
        args.intent,
        args.queryClass,
        args.anchors,
        args.uncertainty,
      ),
      uncertainty: args.uncertainty,
    };
  }

  private lookupExactSafe(
    views: ReturnType<typeof buildNormalizedQueryViews>,
    stageTimer: LookupPlannerContext['stageTimer'],
  ): LookupExactSafeMatch | null {
    stageTimer?.start('exact');
    const exactSafe = this.deps.exactSafeRegistry?.match(views) ?? null;
    stageTimer?.end('exact');
    return exactSafe;
  }

  private async lookupPersistedAmbiguity(
    normalizedQuery: string,
    context?: LookupPlannerContext,
  ) {
    if (this.deps.ambiguityDictionary === undefined) {
      return null;
    }
    context?.stageTimer?.start('ambiguity_lookup');
    try {
      return await this.deps.ambiguityDictionary.getAmbiguityInfo(
        normalizedQuery,
        context?.abortSignal,
      );
    } catch {
      return null;
    } finally {
      context?.stageTimer?.end('ambiguity_lookup');
    }
  }
}

function tokenizeLookupSurface(value: string): readonly string[] {
  return buildNormalizedQueryViews(value)
    .punctuationStripped
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function anchorHasAuthorityLookupVariant(
  anchor: AnchorCandidate,
  wholeSurfaceQueries: ReadonlySet<string>,
): boolean {
  const lookupVariants = anchor.lookupVariants ?? [];
  if (lookupVariants.length === 0) {
    return true;
  }

  return lookupVariants.some((variant) => {
    const trimmed = variant.trim();
    return trimmed.length > 0
      && (
        wholeSurfaceQueries.has(trimmed)
        || tokenizeLookupSurface(trimmed).length > 1
      );
  });
}

function pruneLookupAuthorityAnchors(
  normalizedQuery: string,
  normalizedQueryViews: ReturnType<typeof buildNormalizedQueryViews>,
  anchors: readonly AnchorCandidate[],
): readonly AnchorCandidate[] {
  const queryTokenCount = tokenizeLookupSurface(normalizedQueryViews.punctuationStripped).length;
  if (queryTokenCount <= 1 || anchors.length === 0) {
    return anchors;
  }

  const wholeSurfaceQueries = new Set(
    buildAliasSurfaceLookupPlan(normalizedQuery, normalizedQueryViews).tokenList,
  );
  const authorityAnchors = anchors.filter((anchor) =>
    anchorHasAuthorityLookupVariant(anchor, wholeSurfaceQueries),
  );

  return authorityAnchors.length > 0 ? authorityAnchors : [];
}

function buildExactSafeAnchor(
  rawQuery: string,
  normalizedQuery: string,
  match: LookupExactSafeMatch,
): AnchorCandidate {
  return {
    surfaceForm: rawQuery,
    normalizedForm: normalizedQuery,
    candidateEntityIds: [match.entityId],
    lookupVariants: [match.normalizedSurface],
    lookupStrategies: [match.kind === 'compact_exact_safe' ? 'compact_exact' : 'exact'],
    aliasType: 'observed_query_alias',
    confidence: 1,
    source: 'alias',
  };
}

function classifyLookupQueryClass(args: {
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly anchors: readonly AnchorCandidate[];
}): QueryClass {
  if (args.anchors.length === 0) {
    return 'unknown';
  }
  if (
    findRawQueryExactSafeSingletonAliasWitness(
      args.rawQuery,
      args.normalizedQuery,
      args.anchors,
    ) !== undefined
  ) {
    return 'exact_entity';
  }
  if (hasDeterministicSingletonAliasWitness(args.anchors) || hasHighConfidenceStrictExactSingletonAnchor(args.anchors)) {
    return 'exact_entity';
  }
  const entityIds = new Set(args.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)));
  if (entityIds.size > 1) {
    return 'ambiguous_short_form';
  }
  return 'short_entity';
}

function buildLookupUncertainty(
  queryClass: QueryClass,
  anchors: readonly AnchorCandidate[],
): QueryUncertainty {
  if (queryClass === 'exact_entity') {
    return {
      overall: 0.05,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 1,
      anchorConfidence: strongestAnchorConfidence(anchors),
      constraintConfidence: 1,
    };
  }
  if (queryClass === 'ambiguous_short_form') {
    return {
      overall: 0.9,
      ambiguityDetected: true,
      ambiguityTypes: ['multi_entity_short_form'],
      ambiguitySeverity: 'high',
      decisionEffect: 'force_clarify',
      parserConfidence: 1,
      anchorConfidence: strongestAnchorConfidence(anchors),
      constraintConfidence: 1,
    };
  }
  if (queryClass === 'short_entity') {
    return {
      overall: 0.35,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 1,
      anchorConfidence: strongestAnchorConfidence(anchors),
      constraintConfidence: 1,
    };
  }
  return {
    overall: 0.8,
    ambiguityDetected: false,
    ambiguityTypes: [],
    ambiguitySeverity: 'medium',
    decisionEffect: 'raise_threshold',
    parserConfidence: 0.7,
    anchorConfidence: 0,
    constraintConfidence: 1,
  };
}

function strongestAnchorConfidence(
  anchors: readonly AnchorCandidate[],
): number {
  return anchors.reduce((max, anchor) => Math.max(max, anchor.confidence), 0);
}

function hasHighConfidenceStrictExactSingletonAnchor(
  anchors: readonly AnchorCandidate[],
): boolean {
  return anchors.some((anchor) =>
    anchor.source === 'alias'
    && anchor.candidateEntityIds.length === 1
    && anchor.confidence >= EXACT_IDENTITY_MIN_CONFIDENCE
    && (anchor.lookupStrategies?.every((strategy) =>
      strategy === 'exact'
      || strategy === 'compact_exact'
      || strategy === 'transliterated_exact',
    ) ?? false),
  );
}
