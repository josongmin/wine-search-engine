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
import type { ComparisonEntity } from '../../response/model/comparison-response.js';
import type {
  ToolCallEvidenceFrame,
  ToolCallStructuredOutput,
} from '../../agent/model/tool-call-evidence-frame.js';
import { KRW_PER_USD_APPROXIMATE } from '../../shared/constants.js';
import type { EvidenceRecord } from './claim-verifier-deterministic.js';

type EvidenceRecordValue = string | number | readonly string[] | null | undefined;

function parseStepIndexFromToolCallId(toolCallId: string): number | undefined {
  const match = /-s(?<stepIndex>\d+)(?:-p\d+)?$/u.exec(toolCallId);
  if (match?.groups?.['stepIndex'] === undefined) {
    return undefined;
  }
  const stepIndex = Number(match.groups['stepIndex']);
  if (!Number.isFinite(stepIndex)) {
    return undefined;
  }
  return Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : undefined;
}

function withFrameProvenance(
  record: Record<string, EvidenceRecordValue>,
  frame: ToolCallEvidenceFrame,
): EvidenceRecord {
  const stepIndex = parseStepIndexFromToolCallId(frame.toolCallId);
  return {
    ...record,
    __source_tool_name: frame.toolName,
    __source_tool_call_id: frame.toolCallId,
    __source_request_id: frame.requestId,
    ...(stepIndex !== undefined ? { __source_step_index: stepIndex } : {}),
  };
}

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
  return recordsForStructuredOutput(frame.structuredOutput).map((record) =>
    withFrameProvenance({ ...record }, frame));
}

function recordsForStructuredOutput(
  output: ToolCallStructuredOutput,
): readonly EvidenceRecord[] {
  switch (output.kind) {
    case 'search_result_set':
      return output.resultSet.map((item) => resultItemToEvidenceRecord(item));
    case 'food_pairing':
      return output.resultSet.map((item) => resultItemToEvidenceRecord(item));
    case 'comparison_result': {
      return output.response.entities.flatMap((entry) => comparisonEntityToEvidenceRecords(entry));
    }
    case 'drinking_window': {
      const rec: Record<string, EvidenceRecordValue> = {
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

function comparisonEntityToEvidenceRecords(
  entry: ComparisonEntity,
): readonly EvidenceRecord[] {
  const conceptPrototypeAxis = entry.conceptAggregate?.prototypeAxis ?? [];
  if (conceptPrototypeAxis.length > 0) {
    return conceptPrototypeAxis.map((item) => resultItemToEvidenceRecord(item, entry));
  }
  if (entry.topResult === null) {
    return [];
  }
  return [resultItemToEvidenceRecord(entry.topResult, entry)];
}

/**
 * Flatten a `ResultItem` into the column-name projection that
 * `claim-verifier-deterministic.ts` already expects. This mirrors the field
 * names legacy `evidence-parser.ts` emits so the verifier needs zero changes
 * in Phase 0.
 */
function resultItemToEvidenceRecord(
  item: ResultItem,
  comparisonEntry?: ComparisonEntity,
): EvidenceRecord {
  const entity = item.entity;
  const rec: Record<string, EvidenceRecordValue> = {
    entity_id: entity.entityId,
    canonical_label: entity.canonicalLabel,
  };
  if (entity.producer !== undefined) rec['producer'] = entity.producer;
  if (entity.region !== undefined) rec['region'] = entity.region;
  if (entity.closure !== undefined) rec['closure'] = entity.closure;
  if (entity.country !== undefined) rec['country'] = entity.country;
  if (entity.appellation !== undefined) rec['appellation'] = entity.appellation;
  if (entity.producerPrestige !== undefined) rec['producer_prestige'] = entity.producerPrestige;
  if (entity.style !== undefined) rec['style'] = entity.style;
  if (entity.wineType !== undefined) rec['wine_type'] = entity.wineType;
  if (entity.vintage !== undefined) rec['vintage_year'] = entity.vintage;
  if (entity.priceRange !== undefined) {
    rec['price_range'] = entity.priceRange;
    const priceUsd = parsePriceRangeAsUsd(entity.priceRange);
    if (priceUsd !== undefined) rec['price_usd'] = priceUsd;
  }
  if (entity.grapes !== undefined && entity.grapes.length > 0) {
    rec['grapes'] = entity.grapes;
  }
  if (entity.alcoholPct !== undefined) rec['alcohol_pct'] = entity.alcoholPct;
  if (entity.body !== undefined) rec['body'] = entity.body;
  if (entity.tannin !== undefined) rec['tannin'] = entity.tannin;
  if (entity.acidity !== undefined) rec['acidity'] = entity.acidity;
  if (entity.sweetness !== undefined) rec['sweetness'] = entity.sweetness;
  if (entity.criticScore !== undefined) {
    rec['critic_score_normalized'] = entity.criticScore;
  }
  if (entity.pairingTags !== undefined && entity.pairingTags.length > 0) {
    rec['pairing'] = entity.pairingTags;
  }
  if (entity.occasion !== undefined && entity.occasion.length > 0) {
    rec['occasion'] = entity.occasion;
  }
  if (item.drinkingWindow !== undefined) {
    rec['drinking_window_start'] = item.drinkingWindow.drinkingWindowStart;
    rec['drinking_window_end'] = item.drinkingWindow.drinkingWindowEnd;
    rec['currently_drinkable'] = item.drinkingWindow.currentlyDrinkable ? 'true' : 'false';
  }
  applyComparisonConceptEvidence(rec, comparisonEntry);
  return rec;
}

function applyComparisonConceptEvidence(
  rec: Record<string, EvidenceRecordValue>,
  comparisonEntry: ComparisonEntity | undefined,
): void {
  if (
    comparisonEntry?.comparisonMode !== 'concept'
    || comparisonEntry.canonicalConcept === undefined
    || comparisonEntry.conceptEntityType === undefined
  ) {
    return;
  }

  // comparison_concept is supplemental comparison-leg provenance only.
  // It must never overwrite the representative result's primary evidence
  // field (e.g. appellation / region / grape / wine_type) on this record.
  rec['comparison_concept'] = comparisonEntry.canonicalConcept;
  rec['comparison_concept_field'] = comparisonEntry.conceptEntityType;
  rec['comparison_sub_query'] = comparisonEntry.subQuery;
  if (comparisonEntry.conceptAggregate !== undefined) {
    rec['comparison_aggregate_result_count'] = comparisonEntry.conceptAggregate.aggregateResultCount;
    if (comparisonEntry.conceptAggregate.representativeResult?.entity.entityId === rec['entity_id']) {
      rec['comparison_candidate_role'] = 'representative';
    } else {
      rec['comparison_candidate_role'] = 'prototype';
    }
  }

  switch (comparisonEntry.conceptEntityType) {
    case 'country':
      return;
    case 'region':
      return;
    case 'appellation':
      return;
    case 'grape_primary':
      return;
    case 'wine_type':
      return;
  }
}

function parsePriceRangeAsUsd(priceRange: string): number | undefined {
  const trimmed = priceRange.trim();
  if (/^\$\s*[0-9]+(?:\.[0-9]+)?\s*-\s*\$\s*[0-9]+(?:\.[0-9]+)?$/u.test(trimmed)) {
    return undefined;
  }
  const usdMatch = /^\$\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(trimmed);
  if (usdMatch?.[1] !== undefined) {
    const usd = Number(usdMatch[1]);
    return Number.isFinite(usd) ? usd : undefined;
  }
  if (/^(?:₩|)?[0-9][0-9,]*\s*원?\s*-\s*(?:₩|)?[0-9][0-9,]*\s*원?$/u.test(trimmed)) {
    return undefined;
  }
  const krwMatch = /^(?:₩|)([0-9][0-9,]*)\s*원?$/u.exec(trimmed);
  if (krwMatch?.[1] !== undefined) {
    const krw = Number(krwMatch[1].replace(/,/gu, ''));
    if (Number.isFinite(krw)) {
      return Math.round((krw / KRW_PER_USD_APPROXIMATE) * 100) / 100;
    }
  }
  return undefined;
}
