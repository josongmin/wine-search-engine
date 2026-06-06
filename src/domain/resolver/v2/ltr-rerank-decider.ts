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

// NOTE (T-ELV2-05 train-serve blocker): these thresholds are calibrated for a
// LOOKUP-domain-trained model's learned-score range. They are UNVALIDATED for
// the current search-trained model served through the OOD lookup projection (see
// `toRankingFeatures` below). They are extracted-as-named-consts (rule 15) so the
// approximation is auditable rather than silent; their VALUES can only be
// validated once a lookup-domain model defines the real score distribution. Do
// NOT tune them to make tests pass against a search-trained model.
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
 *
 * ⚠️ OUT-OF-DISTRIBUTION WARNING (T-ELV2-05 train-serve blocker): this projects
 * lookup features onto a schema that the PRODUCTION training extractor populates
 * differently — most notably the `bm25Score` slot is emitted as constant 0.0 at
 * training time (search ltr-feature-extractor), but here it receives
 * `normalizedAliasEvidence`. A SEARCH-trained model has therefore never seen a
 * non-zero bm25Score and serving it this vector is OOD. This projection is only
 * safe to SERVE once a model is trained on THIS exact distribution (or with
 * explicit owner approval). The mapping is intentionally LEFT UNCHANGED this
 * session — it is gated OFF by `LTR_SERVING_ENABLED` (default false), so the
 * learned branch is reached only by tests with injected models, never live.
 */
export function toRankingFeatures(f: LookupCandidateFeatures): RankingFeatures {
  const scopeCorroboration = clamp01(
    Math.max(
      f.familyGraphProximity,
      f.lineGraphProximity ?? 0,
      f.vintageGraphProximity ?? 0,
    ),
  );
  return {
    bm25Score: Math.max(f.normalizedAliasEvidence, f.scopeQualifierAgreement ?? 0),
    semanticScore: Math.max(f.transliterationConsistency, f.scopeAxisAgreement ?? 0),
    popularityScore: f.popularityPrior,
    recencyScore: f.vintageGraphProximity ?? 0,
    classMatchScore: clamp01(Math.max(f.channelAgreement / LOOKUP_CHANNEL_COUNT, f.scopeAxisAgreement ?? 0)),
    attributeMatchScore: Math.max(f.exactAliasEvidence, f.scopeQualifierAgreement ?? 0),
    // Reuse the (otherwise-unused-in-lookup) diversityScore slot to carry the
    // persisted ambiguity-cluster membership signal (T-06 Half A) — otherwise it
    // is computed but DROPPED before scoring. Same OOD-projection caveat as the
    // whole mapping (a lookup-domain model must be trained on this distribution;
    // see the train-serve blocker above), consistent with familyGraphProximity →
    // laneCorroborationScore below.
    diversityScore: clamp01(f.ambiguityClusterMembership),
    multilingualScore: f.transliterationConsistency,
    entityPosteriorScore: f.editDistanceScore,
    identityExactnessTierScore: Math.max(f.exactAliasEvidence, f.phoneticConsistency),
    laneCorroborationScore: scopeCorroboration,
    laneDisagreementScore: clamp01(1 - Math.max(f.scriptLanguageConsistency, f.scopeAxisAgreement ?? 0)),
    entityOnlyIndicator: 1,
    generalOnlyIndicator: 0,
  };
}

/** Declared retrieval-channel count, for normalising channel agreement. */
const LOOKUP_CHANNEL_COUNT = 9;

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
