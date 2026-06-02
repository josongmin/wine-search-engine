/**
 * Entity Lookup V2 — learned reranker + calibrated decision (T-ELV2-05, real).
 *
 * Implements the frozen {@link LookupRerankDecisionPort}. Reuses the production
 * LambdaMART scorer ({@link scoreDocument}) and the trained per-query-class
 * models ({@link QueryClassWeights}) — NOT a bespoke threshold tweak (ticket
 * forbidden: "learned scorer 없이 threshold tweak만 반복"). The learned score
 * re-orders the candidate union; the terminal status is then derived by the
 * SAME precision-first, downgrade-only rules as the calibrated-abstain layer
 * (confidence floor + top1-top2 margin).
 *
 * Graceful degradation (mirrors the ranking pipeline):
 *   - no trained model for the query class  → lexical fallback (input order),
 *   - feature-schema mismatch / scorer throw → lexical fallback,
 *   - saturated scores (all ~equal)         → lexical fallback,
 * so an untrained/cold deploy never wrong-resolves on a degenerate model.
 */

import { scoreDocument, type QueryClassWeights } from '../../ranking/service/lambdamart-ranker.js';
import type { RankingFeatures } from '../../ranking/service/ltr-feature-extractor.js';
import { clamp01 } from '../../shared/utils/clamp.js';
import type {
  LookupCandidateFeatures,
  LookupDecision,
  LookupDecisionInput,
  LookupRerankDecisionPort,
  LookupScoredCandidate,
} from './lookup-v2-types.js';

/** Min learned score for the top candidate to be certified `resolved`. */
export const LTR_RESOLVE_THRESHOLD = 0.5;
/** Min top1-top2 learned-score gap; below it the result is `ambiguous`. */
export const LTR_GAP_THRESHOLD = 0.1;
/** Below this score spread the model is saturated → distrust the ordering. */
export const LTR_SATURATION_EPSILON = 1e-3;

export interface LtrRerankDeciderDeps {
  /** Trained per-query-class LambdaMART models; absent ⇒ lexical fallback. */
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
}

interface RerankedCandidate {
  readonly candidate: LookupScoredCandidate;
  readonly score: number;
}

export class LtrRerankDecider implements LookupRerankDecisionPort {
  constructor(private readonly deps: LtrRerankDeciderDeps = {}) {}

  decide(input: LookupDecisionInput, _signal?: AbortSignal): Promise<LookupDecision> {
    return Promise.resolve(this.decideSync(input));
  }

  private decideSync(input: LookupDecisionInput): LookupDecision {
    const { queryClass, scored } = input;
    if (scored.length === 0) {
      return decision('failed', 'no_match', 'No candidate to rerank.', 0, undefined);
    }

    const model = this.deps.ltrModels?.get(queryClass);
    if (model === undefined) {
      return this.lexicalFallback(scored, 'no_ltr_model');
    }

    const reranked = this.scoreWithModel(scored, model);
    if (reranked === undefined) {
      // schema mismatch / scorer error → never trust a broken model.
      return this.lexicalFallback(scored, 'ltr_unavailable');
    }

    reranked.sort((a, b) => b.score - a.score || a.candidate.entityId.localeCompare(b.candidate.entityId));
    // Saturation only applies with a runner-up to compare against — a lone
    // candidate has no spread by construction and must keep its learned score.
    if (reranked.length >= 2) {
      const spread = reranked[0]!.score - reranked[reranked.length - 1]!.score;
      if (spread < LTR_SATURATION_EPSILON) {
        return this.lexicalFallback(scored, 'ltr_saturated');
      }
    }

    return this.decideFromOrdered(reranked, 'learned_rerank');
  }

  private scoreWithModel(
    scored: readonly LookupScoredCandidate[],
    model: QueryClassWeights,
  ): RerankedCandidate[] | undefined {
    try {
      return scored.map((candidate) => ({
        candidate,
        score: clamp01(scoreDocument(toRankingFeatures(candidate.features), model)),
      }));
    } catch {
      return undefined;
    }
  }

  /** Fallback: keep the resolver-calibrated ordering, apply the same gates. */
  private lexicalFallback(scored: readonly LookupScoredCandidate[], reasonCode: string): LookupDecision {
    const ordered = [...scored]
      .map((candidate) => ({ candidate, score: clamp01(candidate.calibratedScore) }))
      .sort((a, b) => b.score - a.score || a.candidate.entityId.localeCompare(b.candidate.entityId));
    return this.decideFromOrdered(ordered, reasonCode);
  }

  private decideFromOrdered(ordered: readonly RerankedCandidate[], baseReason: string): LookupDecision {
    const top1 = ordered[0]!.score;
    const top2 = ordered[1]?.score;
    const margin = top2 !== undefined ? top1 - top2 : undefined;

    if (top1 < LTR_RESOLVE_THRESHOLD) {
      return decision('failed', `below_resolve_threshold:${baseReason}`, 'Top reranked candidate is below the resolve threshold.', top1, margin);
    }
    if (margin !== undefined && margin < LTR_GAP_THRESHOLD) {
      return decision('ambiguous', `narrow_margin:${baseReason}`, 'Top two reranked candidates are too close to call.', top1, margin);
    }
    return decision('resolved', baseReason, 'Resolved by the learned reranker.', top1, margin);
  }
}

/**
 * Map the lookup feature vector onto the LambdaMART ranking-feature schema.
 * Lookup-specific evidence is projected onto the closest ranking features;
 * dimensions with no lookup analogue are 0. `entityOnlyIndicator` is 1 because
 * lookup is, by definition, an entity-only task.
 */
function toRankingFeatures(f: LookupCandidateFeatures): RankingFeatures {
  return {
    bm25Score: f.normalizedAliasEvidence,
    semanticScore: f.transliterationConsistency,
    popularityScore: f.popularityPrior,
    recencyScore: 0,
    classMatchScore: clamp01(f.channelAgreement / LOOKUP_CHANNEL_COUNT),
    attributeMatchScore: f.exactAliasEvidence,
    diversityScore: 0,
    multilingualScore: f.transliterationConsistency,
    entityPosteriorScore: f.editDistanceScore,
    identityExactnessTierScore: Math.max(f.exactAliasEvidence, f.phoneticConsistency),
    laneCorroborationScore: f.familyGraphProximity,
    laneDisagreementScore: clamp01(1 - f.scriptLanguageConsistency),
    entityOnlyIndicator: 1,
    generalOnlyIndicator: 0,
  };
}

/** Declared retrieval-channel count, for normalising channel agreement. */
const LOOKUP_CHANNEL_COUNT = 7;

function decision(
  status: LookupDecision['status'],
  reasonCode: string,
  detail: string,
  topConfidence: number,
  margin: number | undefined,
): LookupDecision {
  return {
    status,
    reasonCode,
    detail,
    topConfidence: clamp01(topConfidence),
    ...(margin !== undefined ? { top1Top2Margin: clamp01(margin) } : {}),
    // Learned-rerank scores are model outputs, not calibrated probabilities, so
    // calibration is reported as not-trusted (precision-first consumers gate on it).
    calibrationTrusted: false,
  };
}
