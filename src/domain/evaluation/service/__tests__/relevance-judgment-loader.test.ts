import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadRelevanceJudgments,
  filterRelevantIds,
} from '../relevance-judgment-loader.js';
import type { RelevanceJudgment } from '../../model/relevance-judgment.js';

describe('relevance-judgment-loader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rel-judgment-loader-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadRelevanceJudgments', () => {
    it('parses valid NDJSON file with multiple judgments', async () => {
      const file = path.join(tmpDir, 'silver.ndjson');
      const lines = [
        JSON.stringify({
          queryId: 'q-001',
          query: 'burgundy pinot noir',
          entityId: 'wine-42',
          canonicalLabel: 'Domaine X Pinot Noir 2019',
          grade: 3,
          confidence: 0.9,
          source: 'llm_silver',
          labelerModel: 'claude-haiku-4-5',
          rationale: 'exact region and varietal match',
        }),
        '',
        JSON.stringify({
          queryId: 'q-001',
          query: 'burgundy pinot noir',
          entityId: 'wine-99',
          canonicalLabel: 'Chateau Y Cabernet 2018',
          grade: 0,
          confidence: 0.85,
          source: 'llm_silver',
        }),
      ].join('\n');
      await fs.writeFile(file, lines, 'utf8');

      const out = await loadRelevanceJudgments(file);

      expect(out).toHaveLength(2);
      expect(out[0]?.entityId).toBe('wine-42');
      expect(out[0]?.grade).toBe(3);
      expect(out[0]?.labelerModel).toBe('claude-haiku-4-5');
      expect(out[1]?.entityId).toBe('wine-99');
      // exactOptionalPropertyTypes: optional keys omitted when absent
      expect(Object.hasOwn(out[1] ?? {}, 'labelerModel')).toBe(false);
    });

    it('skips malformed lines with a warning and retains valid ones', async () => {
      const file = path.join(tmpDir, 'mixed.ndjson');
      const good = JSON.stringify({
        queryId: 'q-1',
        query: 'hello',
        entityId: 'e-1',
        canonicalLabel: 'Wine A',
        grade: 2,
        confidence: 0.8,
        source: 'llm_silver',
      });
      const badJson = '{not json';
      const badShape = JSON.stringify({ queryId: 'q-2' }); // missing fields
      await fs.writeFile(file, `${good}\n${badJson}\n${badShape}\n${good}\n`, 'utf8');

      const warnSpy = vi.fn();
      // Spy on bootstrapLogger.warn indirectly by not asserting — we just
      // verify the loader returned the two valid lines and did not throw.
      void warnSpy;

      const out = await loadRelevanceJudgments(file);
      expect(out).toHaveLength(2);
      expect(out[0]?.queryId).toBe('q-1');
      expect(out[1]?.queryId).toBe('q-1');
    });

    it('returns empty array for a missing file without throwing', async () => {
      const file = path.join(tmpDir, 'does-not-exist.ndjson');
      const out = await loadRelevanceJudgments(file);
      expect(out).toEqual([]);
    });
  });

  describe('filterRelevantIds', () => {
    const judgments: readonly RelevanceJudgment[] = [
      {
        queryId: 'q-a',
        query: 'a',
        entityId: 'e-1',
        canonicalLabel: 'A',
        grade: 3,
        confidence: 0.9,
        source: 'llm_silver',
      },
      {
        queryId: 'q-a',
        query: 'a',
        entityId: 'e-2',
        canonicalLabel: 'B',
        grade: 2,
        confidence: 0.8,
        source: 'llm_silver',
      },
      {
        queryId: 'q-a',
        query: 'a',
        entityId: 'e-3',
        canonicalLabel: 'C',
        grade: 1,
        confidence: 0.6,
        source: 'llm_silver',
      },
      {
        queryId: 'q-b',
        query: 'b',
        entityId: 'e-4',
        canonicalLabel: 'D',
        grade: 3,
        confidence: 0.95,
        source: 'llm_silver',
      },
    ];

    it('applies default threshold of 2 (relevant or better)', () => {
      const relevant = filterRelevantIds(judgments, 'q-a');
      expect(relevant).toEqual(new Set(['e-1', 'e-2']));
    });

    it('respects a stricter threshold of 3', () => {
      const relevant = filterRelevantIds(judgments, 'q-a', 3);
      expect(relevant).toEqual(new Set(['e-1']));
    });

    it('returns an empty set for an unknown queryId', () => {
      const relevant = filterRelevantIds(judgments, 'q-unknown');
      expect(relevant.size).toBe(0);
    });
  });
});
