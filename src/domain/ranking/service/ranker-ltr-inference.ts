import type { QueryClass } from '../../shared/types/index.js';
import type {
  DualLanePresence,
  IdentityExactnessTier,
} from '../../retrieval/model/dual-lane-artifact.js';
import type { RankedResult, ComponentScores } from '../model/ranked-result.js';
import type { QueryClassWeights } from '../index.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { LTRRanker } from './ltr-ranker.js';
import {
  extractLTRFeatures,
  rankingFeaturesToVector,
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_NAME_ORDER,
  LTR_FEATURE_SCHEMA_HASH,
} from './ltr-feature-extractor.js';
import { MS_PER_DAY } from '../../shared/utils/time-units.js';
import {
  evaluateRerankSafety,
  buildRerankSafetyListContext,
} from './rerank-safety.js';
import type { SafetyCandidateDescriptor } from './rerank-safety.js';
import type { ScoreDecomposition } from '../model/score-decomposition.js';
import type { LTRScoreComponents } from './ltr-feature-extractor.js';
import {
  incrementLtrInferenceComponentScoreAbsent,
  type LtrInferenceComponentScoreField,
} from '../../../domain/observability/silent-skip-counters.js';

const MODEL_STALENESS_THRESHOLD_DAYS = 30;

// MS_PER_DAY imported from SSoT: @domain/shared/utils/time-units
const MILLISECONDS_PER_DAY = MS_PER_DAY;

/** LambdaMART weight vector length (must match {@link extractLTRFeatures} output). */
const LTR_MODEL_FEATURE_DIMENSION = LTR_FEATURE_DIMENSION;

function projectObservedLtrComponentScore(
  componentScores: ComponentScores,
  key: LtrInferenceComponentScoreField,
): Partial<Pick<LTRScoreComponents, LtrInferenceComponentScoreField>> {
  const value = componentScores[key];
  if (value === undefined) {
    incrementLtrInferenceComponentScoreAbsent(key);
    return {};
  }

  return { [key]: value } as Pick<LTRScoreComponents, typeof key>;
}

function buildObservedLtrInferenceScoreComponents(
  input: {
    readonly componentScores: ComponentScores;
    readonly entityPosteriorScore?: number | undefined;
    readonly identityExactnessTier: IdentityExactnessTier;
    readonly lanePresence?: DualLanePresence | undefined;
  },
): LTRScoreComponents {
  const { componentScores } = input;

  return {
    ...projectObservedLtrComponentScore(componentScores, 'semantic'),
    ...projectObservedLtrComponentScore(componentScores, 'popularity'),
    ...projectObservedLtrComponentScore(componentScores, 'attributeAlignment'),
    ...projectObservedLtrComponentScore(componentScores, 'preferenceAlignment'),
    ...projectObservedLtrComponentScore(componentScores, 'multilingualScore'),
    ...projectObservedLtrComponentScore(componentScores, 'recency'),
    ...(input.entityPosteriorScore !== undefined
      ? { entityPosterior: input.entityPosteriorScore }
      : {}),
    identityExactnessTier: input.identityExactnessTier,
    ...(input.lanePresence !== undefined
      ? { lanePresence: input.lanePresence }
      : {}),
  };
}

export function buildObservedLtrInferenceArtifact(
  input: {
    readonly componentScores: ComponentScores;
    readonly entityPosteriorScore?: number | undefined;
    readonly identityExactnessTier: IdentityExactnessTier;
    readonly lanePresence?: DualLanePresence | undefined;
  },
): {
  readonly scoreComponents: LTRScoreComponents;
  readonly features: ReturnType<typeof extractLTRFeatures>;
  readonly vector: readonly number[];
} {
  const scoreComponents = buildObservedLtrInferenceScoreComponents(input);
  const features = extractLTRFeatures(scoreComponents);

  return {
    scoreComponents,
    features,
    vector: rankingFeaturesToVector(features),
  };
}

/**
 * E1-T4: Typed reason why learned LTR rerank was skipped.
 *
 * - `not_skipped`: rerank was applied normally
 * - `no_model_for_query_class`: no LTR model registered for this query class
 * - `empty_candidates`: result list was empty before rerank
 * - `feature_dimension_mismatch`: model weight vector length ≠ LTR_MODEL_FEATURE_DIMENSION
 * - `model_stale`: model age exceeded MODEL_STALENESS_THRESHOLD_DAYS (warning only, does not skip)
 */
export type LtrRerankSkipReason =
  | 'not_skipped'
  | 'no_model_for_query_class'
  | 'empty_candidates'
  | 'feature_dimension_mismatch';

export function applyLearnedLtrRerank(
  rankedResults: readonly RankedResult[],
  queryClass: QueryClass,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
  ltrFeatureInputsByEntityId: ReadonlyMap<
    string,
    {
      readonly features: ReturnType<typeof extractLTRFeatures>;
      readonly vector: readonly number[];
    }
  >,
): { results: RankedResult[]; skipReason: LtrRerankSkipReason; modelId?: string; ltrSaturated?: boolean } {
  const ltrModel = ltrModels?.get(queryClass);
  if (!ltrModel) {
    return { results: [...rankedResults], skipReason: 'no_model_for_query_class' };
  }
  if (rankedResults.length === 0) {
    return { results: [], skipReason: 'empty_candidates' };
  }

  // Guard against an Invalid Date `trainedAt` (e.g. JSONB corruption or a
  // training record written with `new Date(undefined)`). Without this guard,
  // `getTime()` returns NaN, `NaN > threshold` is false, and a stale model
  // would silently bypass the freshness warning. Treat NaN as "unknown age"
  // and log it so operators notice.
  const trainedAtMs = ltrModel.trainedAt.getTime();
  const modelAgeMs = Number.isFinite(trainedAtMs) ? Date.now() - trainedAtMs : Number.NaN;
  const modelAgeDays = modelAgeMs / MILLISECONDS_PER_DAY;
  if (!Number.isFinite(modelAgeDays)) {
    bootstrapLogger.warn(
      { queryClass },
      '[Ranker] LTR model has invalid trainedAt timestamp — treating as stale',
    );
  } else if (modelAgeDays > MODEL_STALENESS_THRESHOLD_DAYS) {
    bootstrapLogger.warn(
      {
        queryClass,
        modelAgeDays: Math.floor(modelAgeDays),
        threshold: MODEL_STALENESS_THRESHOLD_DAYS,
      },
      '[Ranker] LTR model is stale — consider retraining',
    );
  }

  if (ltrModel.weights.length !== LTR_MODEL_FEATURE_DIMENSION) {
    bootstrapLogger.warn({ queryClass, modelWeightDim: ltrModel.weights.length, expectedDim: LTR_MODEL_FEATURE_DIMENSION }, '[Ranker] LTR model dimension mismatch — skipping LTR rerank');
    return { results: [...rankedResults], skipReason: 'feature_dimension_mismatch' };
  }

  // E5-T3: Build safety evaluation descriptors — one per candidate,
  // using heuristic scores and ranks from the pre-LTR ordering.
  // We first run LTR to get proposed ranks, then apply safety checks.
  //
  // ltrFeatureVectorMap: entity → ordered feature vector (LTR schema order) so ScoreDecomposition can
  // carry the raw input for debugging / drift analysis.
  const ltrFeatureVectorMap = new Map<string, readonly number[]>();
  const rankableDocuments = rankedResults.map((doc, idx) => {
    const featureInput = ltrFeatureInputsByEntityId.get(String(doc.entityId));
    if (featureInput === undefined) {
      throw new Error(
        `Ranker invariant violated: missing LTR feature input for entity '${String(doc.entityId)}'`,
      );
    }
    ltrFeatureVectorMap.set(String(doc.entityId), featureInput.vector);
    return {
      entityId: doc.entityId,
      retrievalScore: doc.finalScore,
      features: featureInput.features,
      originalRank: idx + 1,
    };
  });

  const ltrResult = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);
  const rerankedDocs = ltrResult.documents;
  const ltrSaturated = ltrResult.saturated;

  // Build proposed LTR rank map for safety evaluation
  const proposedLtrRankMap = new Map<string, number>(
    rerankedDocs.map((r) => [r.entityId, r.finalRank]),
  );

  // E5-T3: Build safety candidate descriptors + list context.
  // Safety is evaluated HERE (single pass) with the actual proposed LTR ranks.
  // H2 fix: hardConstraintViolations carries only the violations that caused
  // hardConstraintPass=false. When the candidate passes all hard constraints,
  // unmetConstraints may still have soft mismatches — exclude those here so the
  // safety envelope does not conflate soft-constraint mismatches with hard ones.
  const safetyDescriptors: SafetyCandidateDescriptor[] = rankedResults.map((doc, idx) => ({
    entityId: String(doc.entityId),
    heuristicRank: idx + 1,
    hardConstraintPass: doc.componentScores.hardConstraintPass,
    // When hardConstraintPass is true, there are no hard violations to report.
    hardConstraintViolations: doc.componentScores.hardConstraintPass ? [] : [...doc.unmetConstraints],
    anchorSimilarity: doc.componentScores.anchorSimilarity ?? 0,
    // E5-T3: sparseRank is now propagated from ScoredEntry to RankedResult (Wave 2 fix).
    // sparseRank === 1 enables protected-candidate Rule 3 for exact-known-item BM25 hits.
    sparseRank: doc.sparseRank ?? Infinity,
    heuristicScoreNormalized: Number.isFinite(doc.finalScore) ? doc.finalScore : 0,
    proposedLtrRank: proposedLtrRankMap.get(doc.entityId) ?? Infinity,
  }));
  const safetyListCtx = buildRerankSafetyListContext(safetyDescriptors);

  // Single-pass safety evaluation with actual proposed LTR ranks (H1 fix:
  // applyLearnedLtrRerank no longer runs a separate safety pass internally).
  const blockedByEnvelopeIds = new Set<string>();
  for (const desc of safetyDescriptors) {
    const safetyResult = evaluateRerankSafety(desc, safetyListCtx, []);
    if (!safetyResult.allowed) {
      blockedByEnvelopeIds.add(desc.entityId);
    }
  }

  const originalByEntity = new Map<string, RankedResult>(
    rankedResults.map((result) => [String(result.entityId), result]),
  );

  const results = rerankedDocs
    .map((reranked) => {
      const entityKey = reranked.entityId;
      const original = originalByEntity.get(entityKey);
      if (original === undefined) {
        return undefined;
      }

      // E5-T3: Safety envelope — blocked candidates keep heuristic score
      if (blockedByEnvelopeIds.has(entityKey)) {
        // Keep heuristic score + rank; only attach decomposition with no delta
        const decomp: ScoreDecomposition = {
          lexicalContribution: 0,
          semanticContribution: original.componentScores.semantic ?? 0,
          anchorContribution: original.componentScores.anchorSimilarity ?? 0,
          attributeSatisfaction: original.componentScores.attributeAlignment ?? 0,
          popularityContribution: original.componentScores.popularity ?? 0,
          preferenceAlignmentContribution: original.componentScores.preferenceAlignment ?? 0,
          heuristicScoreRaw: original.finalScore,
          heuristicScoreNormalized: Number.isFinite(original.finalScore) ? original.finalScore : 0,
          finalScore: original.finalScore,
        };
        return {
          ...original,
          scoreDecomposition: decomp,
        };
      }

      // Allowed — apply LTR score + build full decomposition
      const heuristicNorm = Number.isFinite(original.finalScore) ? original.finalScore : 0;
      const ltrNorm = Number.isFinite(reranked.ltrScore) ? reranked.ltrScore : heuristicNorm;
      const rerankDelta = ltrNorm - heuristicNorm;

        const decomp: ScoreDecomposition = {
          lexicalContribution: 0,
        semanticContribution: original.componentScores.semantic ?? 0,
        anchorContribution: original.componentScores.anchorSimilarity ?? 0,
        attributeSatisfaction: original.componentScores.attributeAlignment ?? 0,
        popularityContribution: original.componentScores.popularity ?? 0,
        preferenceAlignmentContribution: original.componentScores.preferenceAlignment ?? 0,
        heuristicScoreRaw: heuristicNorm,
        heuristicScoreNormalized: heuristicNorm,
        ltrScoreNormalized: ltrNorm,
        rerankDeltaNormalized: rerankDelta,
        // C4: attach the feature vector used for LTR inference so ScoreDecomposition
        // is self-contained for drift analysis and debugging.
        ...(ltrFeatureVectorMap.has(entityKey)
          ? {
              ltrFeatureVector: ltrFeatureVectorMap.get(entityKey),
              ltrFeatureDimension: LTR_FEATURE_DIMENSION,
              ltrFeatureNameOrder: LTR_FEATURE_NAME_ORDER,
              ltrFeatureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
            }
          : {}),
        finalScore: reranked.ltrScore,
      };

      return {
        ...original,
        finalScore: reranked.ltrScore,
        rank: reranked.finalRank,
        scoreDecomposition: decomp,
      };
    })
    .filter((result) => result !== undefined) as RankedResult[];
  // P0-5: queryClass is the model identifier (key into ltrModels Map).
  // Returned so rank() can populate rerankDecision.modelId.
  return { results, skipReason: 'not_skipped', modelId: ltrModel.queryClass, ltrSaturated };
}
