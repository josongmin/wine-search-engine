/**
 * ADR-009 Phase 0: `buildEvidenceRecordsFromFrames` replaces the regex-based
 * `parseObservations` path. Locks the field projection so the deterministic
 * claim verifier keeps seeing the same column names it expects today.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { buildEvidenceRecordsFromFrames } from '../../src/domain/evaluation/service/build-evidence-records-from-frames.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type {
  ToolCallEvidenceFrame,
} from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import type { ResultItem } from '../../src/domain/response/model/result-item.js';

function makeFrame(overrides: Partial<ToolCallEvidenceFrame> = {}): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId: 'tc-1',
    toolName: 'search_wines',
    invokedAt: '2026-04-15T00:00:00Z',
    requestId: 'req-1',
    request: { toolName: 'search_wines', input: {} },
    structuredOutput: { kind: 'no_op', reason: 'stub' },
    observationSnapshot: '',
    observationHash: 'a'.repeat(64),
    durationMs: 0,
    ...overrides,
  };
}

function makeResultItem(overrides: Partial<ResultItem['entity']> = {}): ResultItem {
  return {
    entity: {
      entityId: createCanonicalEntityId('opus-one-2018'),
      canonicalLabel: 'Opus One 2018',
      type: 'wine',
      producer: 'Opus One Winery',
      region: 'Napa Valley',
      vintage: 2018,
      priceRange: '$450',
      grapes: ['Cabernet Sauvignon'],
      ...overrides,
    },
  } as ResultItem;
}

describe('buildEvidenceRecordsFromFrames', () => {
  it('returns empty array when no frames supplied', () => {
    expect(buildEvidenceRecordsFromFrames([])).toEqual([]);
  });

  it('projects search_result_set into flat records with canonical column names', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [makeResultItem()],
        resultCount: 1,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec['entity_id']).toBe('opus-one-2018');
    expect(rec['canonical_label']).toBe('Opus One 2018');
    expect(rec['producer']).toBe('Opus One Winery');
    expect(rec['region']).toBe('Napa Valley');
    expect(rec['vintage_year']).toBe(2018);
    expect(rec['price_range']).toBe('$450');
    expect(rec['grapes']).toEqual(['Cabernet Sauvignon']);
  });

  it('skips tool_error and no_op frames (no verifiable evidence)', () => {
    const errorFrame = makeFrame({
      structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: 'bad' },
    });
    const noopFrame = makeFrame({
      structuredOutput: { kind: 'no_op', reason: 'unknown tool' },
    });
    expect(buildEvidenceRecordsFromFrames([errorFrame, noopFrame])).toEqual([]);
  });

  it('projects drinking_window frame as a single record', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'drinking_window',
        entityId: createCanonicalEntityId('chateau-margaux-2015'),
        window: {
          drinkingWindowStart: 2025,
          drinkingWindowEnd: 2045,
          currentlyDrinkable: true,
          confidence: 'high',
        },
        targetYear: 2026,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records).toHaveLength(1);
    expect(records[0]!['drinking_window_start']).toBe(2025);
    expect(records[0]!['drinking_window_end']).toBe(2045);
    expect(records[0]!['currently_drinkable']).toBe('true');
    expect(records[0]!['target_year']).toBe(2026);
    expect(records[0]!['drinking_window_confidence']).toBe('high');
  });

  it('preserves frame order and per-frame result order across multiple frames', () => {
    const frameA = makeFrame({
      toolCallId: 'a',
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [
          makeResultItem({ entityId: createCanonicalEntityId('a-1') }),
          makeResultItem({ entityId: createCanonicalEntityId('a-2') }),
        ],
        resultCount: 2,
      },
    });
    const frameB = makeFrame({
      toolCallId: 'b',
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [makeResultItem({ entityId: createCanonicalEntityId('b-1') })],
        resultCount: 1,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frameA, frameB]);
    expect(records.map((r) => r['entity_id'])).toEqual(['a-1', 'a-2', 'b-1']);
  });
});
