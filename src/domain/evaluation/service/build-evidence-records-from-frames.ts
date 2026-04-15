/**
 * ADR-009 Phase 0: type-dispatched evidence builder that consumes
 * `ToolCallEvidenceFrame` and emits `EvidenceRecord[]` without any regex
 * parsing of observation text.
 *
 * Parallel path to `evidence-parser.ts:parseObservations`. That legacy
 * regex-based parser is retained for pre-Phase-0 bench runs (when frames
 * are absent). New consumers should prefer this module.
 *
 * Once the cutover gate (`evidenceFrameCoverage >= 0.99` two nightly runs)
 * holds and no production code path falls through to `parseObservations`,
 * the legacy path is retirable.
 */

import type { ResultItem } from '../../response/model/result-item.js';
import type {
  ToolCallEvidenceFrame,
  ToolCallStructuredOutput,
} from '../../agent/model/tool-call-evidence-frame.js';
import type { EvidenceRecord } from './claim-verifier-deterministic.js';

/**
 * Build a flat EvidenceRecord list from the typed structured outputs of
 * every tool call frame in a run. Ordering: frame order, then result order
 * within each frame.
 */
export function buildEvidenceRecordsFromFrames(
  frames: readonly ToolCallEvidenceFrame[],
): readonly EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  for (const frame of frames) {
    records.push(...recordsForFrame(frame));
  }
  return records;
}

function recordsForFrame(frame: ToolCallEvidenceFrame): readonly EvidenceRecord[] {
  return recordsForStructuredOutput(frame.structuredOutput);
}

function recordsForStructuredOutput(
  output: ToolCallStructuredOutput,
): readonly EvidenceRecord[] {
  switch (output.kind) {
    case 'search_result_set':
      return output.resultSet.map(resultItemToEvidenceRecord);
    case 'food_pairing':
      return output.resultSet.map(resultItemToEvidenceRecord);
    case 'comparison_result': {
      // ComparisonSearchResponse.entities[n].topResult may be null (e.g.
      // no-match side in a comparison). Drop those entries; nothing
      // verifiable lives inside a null top result.
      const tops = output.response.entities
        .map((entry) => entry.topResult)
        .filter((top): top is NonNullable<typeof top> => top !== null);
      return tops.map(resultItemToEvidenceRecord);
    }
    case 'drinking_window': {
      const rec: Record<string, string | number | readonly string[] | null | undefined> = {
        entity_id: String(output.entityId),
        drinking_window_start: output.window.drinkingWindowStart,
        drinking_window_end: output.window.drinkingWindowEnd,
        currently_drinkable: output.window.currentlyDrinkable ? 'true' : 'false',
        target_year: output.targetYear,
        drinking_window_confidence: output.window.confidence,
      };
      return [rec];
    }
    case 'tool_error':
    case 'no_op':
      // Error / no-op frames carry no verifiable evidence by definition.
      return [];
  }
}

/**
 * Flatten a `ResultItem` into the column-name projection that
 * `claim-verifier-deterministic.ts` already expects. This mirrors the field
 * names legacy `evidence-parser.ts` emits so the verifier needs zero changes
 * in Phase 0.
 */
function resultItemToEvidenceRecord(item: ResultItem): EvidenceRecord {
  const entity = item.entity;
  const rec: Record<string, string | number | readonly string[] | null | undefined> = {
    entity_id: entity.entityId,
    canonical_label: entity.canonicalLabel,
  };
  if (entity.producer !== undefined) rec['producer'] = entity.producer;
  if (entity.region !== undefined) rec['region'] = entity.region;
  if (entity.appellation !== undefined) rec['appellation'] = entity.appellation;
  if (entity.style !== undefined) rec['style'] = entity.style;
  if (entity.vintage !== undefined) rec['vintage_year'] = entity.vintage;
  if (entity.priceRange !== undefined) rec['price_range'] = entity.priceRange;
  if (entity.grapes !== undefined && entity.grapes.length > 0) {
    rec['grapes'] = entity.grapes;
  }
  if (entity.criticScore !== undefined) {
    rec['critic_score'] = entity.criticScore;
  }
  if (entity.pairingTags !== undefined && entity.pairingTags.length > 0) {
    rec['pairing'] = entity.pairingTags;
  }
  if (item.drinkingWindow !== undefined) {
    rec['drinking_window_start'] = item.drinkingWindow.drinkingWindowStart;
    rec['drinking_window_end'] = item.drinkingWindow.drinkingWindowEnd;
    rec['currently_drinkable'] = item.drinkingWindow.currentlyDrinkable ? 'true' : 'false';
  }
  return rec;
}
