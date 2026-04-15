/**
 * LTR training data extraction (Epic-18 T18-3 scaffolding).
 *
 * Transforms a batch of feedback events + debiased relevance signals into
 * training examples suitable for an offline LightGBM / XGBoost LTR job.
 * The actual model training happens in a Python pipeline — this module
 * only shapes the dataset and applies the "minimum impressions" noise
 * filter so downstream jobs receive a stable, per-(query, entity) label.
 */

import type { FeedbackEvent } from '../model/feedback-event.js';
import type { DebiasedRelevance } from './position-debias.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/** Default minimum impressions per (query, entity) before it becomes a label. */
const DEFAULT_MIN_IMPRESSIONS = 5;

export interface TrainingExample {
  readonly query: string;
  readonly entityId: string;
  /** Pointer to a logged feature vector snapshot; undefined until T18-? wires snapshotting. */
  readonly featureSnapshotRef?: string;
  /** Debiased click-through relevance clamped to [0, 1]. */
  readonly relevanceLabel: number;
  readonly impressions: number;
  readonly clicks: number;
}

export interface TrainingDataset {
  readonly examples: readonly TrainingExample[];
  readonly minImpressions: number;
  readonly extractedAt: number;
}

export interface ExtractTrainingDataOptions {
  readonly minImpressions?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

// clamp01: imported from @shared/utils/clamp (SSoT).

/**
 * Extract (query, entityId) training examples from feedback events.
 *
 * Steps:
 *   1. Group events by (query, entityId), counting impressions and clicks.
 *   2. Drop groups below `minImpressions` (too noisy to label).
 *   3. Look up debiased score by entityId and clamp to [0, 1] as the label.
 *   4. featureSnapshotRef is left undefined for now; a later task will wire
 *      it to the feature snapshot log.
 */
export function extractTrainingData(
  events: readonly FeedbackEvent[],
  debiased: readonly DebiasedRelevance[],
  options: ExtractTrainingDataOptions = {},
): TrainingDataset {
  const minImpressions = options.minImpressions ?? DEFAULT_MIN_IMPRESSIONS;
  const now = options.now ?? Date.now;

  const debiasedByEntity = new Map<string, DebiasedRelevance>();
  for (const d of debiased) debiasedByEntity.set(d.entityId, d);

  const groups = new Map<string, { query: string; entityId: string; impressions: number; clicks: number }>();
  const seen = new Set<string>();

  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    if (e.eventType !== 'impression' && e.eventType !== 'click') continue;

    const key = `${e.query}\u0000${e.entityId}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { query: e.query, entityId: e.entityId, impressions: 0, clicks: 0 };
      groups.set(key, g);
    }
    if (e.eventType === 'impression') g.impressions++;
    else g.clicks++;
  }

  const examples: TrainingExample[] = [];
  for (const g of groups.values()) {
    if (g.impressions < minImpressions) continue;
    const d = debiasedByEntity.get(g.entityId);
    const relevanceLabel = d === undefined ? 0 : clamp01(d.debiasedScore);
    examples.push({
      query: g.query,
      entityId: g.entityId,
      relevanceLabel,
      impressions: g.impressions,
      clicks: g.clicks,
    });
  }

  return {
    examples,
    minImpressions,
    extractedAt: now(),
  };
}
