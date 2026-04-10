/**
 * Position-debiased relevance via Inverse Propensity Scoring (IPS).
 *
 * Reference: Joachims et al. 2017 "Unbiased Learning-to-Rank with Biased
 * Feedback". A click at position p is up-weighted by 1/examineProbability(p)
 * to correct for the fact that lower-ranked items are less likely to be
 * examined regardless of relevance.
 */

import type { FeedbackEvent } from '../model/feedback-event.js';

export interface ExaminationModel {
  /** Probability the user examines the result at the given 0-indexed rank. */
  examineProbability(position: number): number;
}

/**
 * Position examination propensity estimates (Joachims et al. 2017 position bias model).
 * Position 1 (index 0) = full examination probability = 1.0.
 * The geometric-ish decay (1.0 → 0.6 → 0.4 → 0.3 → 0.2) matches typical web
 * search examination curves. Will be replaced with fitted values from impression
 * logs once Epic-18 click pipeline is wired.
 *
 * TODO(W6-P1-4): replace with click-stream calibrated values from pg-feedback-repository.
 *
 * Exported so tests and callers can reference the canonical values (Rule 15: no magic numbers).
 */
// eslint-disable-next-line no-magic-numbers -- empirical position bias decay curve (Joachims et al. 2017); each value is a documented domain constant
export const IPS_POSITION_PROPENSITY = [1.0, 0.6, 0.4, 0.3, 0.2] as const;

const POSITION_PROPENSITIES: readonly number[] = IPS_POSITION_PROPENSITY;
/** Floor for positions beyond the table — decays as 0.1 / (p - 3). */
const TAIL_PROPENSITY_BASE = 0.1;
/** Lowest examination probability (avoid divide-by-zero from IPS weighting). */
const MIN_PROPENSITY = 0.01;

export class PositionBasedExaminationModel implements ExaminationModel {
  examineProbability(position: number): number {
    if (!Number.isFinite(position) || position < 0) return MIN_PROPENSITY;
    if (position < POSITION_PROPENSITIES.length) {
      return POSITION_PROPENSITIES[position]!;
    }
    // Decay tail: position 5 → 0.1/(5-3)=0.05, position 10 → 0.1/7≈0.014.
    const decayed = TAIL_PROPENSITY_BASE / (position - 3);
    return decayed > MIN_PROPENSITY ? decayed : MIN_PROPENSITY;
  }
}

export interface DebiasedRelevance {
  readonly entityId: string;
  readonly debiasedScore: number;
  readonly clicks: number;
  readonly impressions: number;
  readonly avgPosition: number;
}

/**
 * Aggregate (entityId → debiased score) from a batch of feedback events.
 *
 * Algorithm:
 *   - Per entity, count impressions and IPS-weighted clicks.
 *   - debiasedScore = Σ (1 / examineProbability(clickPosition)) / Σ impressions
 *   - Idempotent on eventId: duplicate eventIds are dropped.
 */
export function computeDebiasedRelevance(
  events: readonly FeedbackEvent[],
  examinationModel: ExaminationModel,
): readonly DebiasedRelevance[] {
  const seen = new Set<string>();
  const agg = new Map<string, {
    clicks: number;
    impressions: number;
    weightedClicks: number;
    posSum: number;
    posCount: number;
  }>();

  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    if (!Number.isFinite(e.position) || e.position < 0) continue;

    let entry = agg.get(e.entityId);
    if (entry === undefined) {
      entry = { clicks: 0, impressions: 0, weightedClicks: 0, posSum: 0, posCount: 0 };
      agg.set(e.entityId, entry);
    }

    if (e.eventType === 'impression') {
      entry.impressions++;
      entry.posSum += e.position;
      entry.posCount++;
    } else if (e.eventType === 'click') {
      entry.clicks++;
      const propensity = examinationModel.examineProbability(e.position);
      const weight = 1 / Math.max(propensity, MIN_PROPENSITY);
      entry.weightedClicks += weight;
    }
  }

  const out: DebiasedRelevance[] = [];
  for (const [entityId, v] of agg) {
    const debiasedScore = v.impressions > 0 ? v.weightedClicks / v.impressions : 0;
    const avgPosition = v.posCount > 0 ? v.posSum / v.posCount : 0;
    out.push({
      entityId,
      debiasedScore,
      clicks: v.clicks,
      impressions: v.impressions,
      avgPosition,
    });
  }
  return out;
}
