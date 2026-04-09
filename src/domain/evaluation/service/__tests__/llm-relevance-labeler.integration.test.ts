/**
 * Integration tests for labelRelevance.
 *
 * Exercises the full labelRelevance pipeline (prompt build → ChatLlmPort call
 * → JSON parse → fallback handling) with a stub ChatLlmPort. No real LLM API
 * calls — the StubLabelerLlm maps candidate canonical labels to predetermined
 * LabelingResult payloads, giving us deterministic, offline test runs.
 *
 * Also includes a deterministic fixture-loader test that reads
 * data/relevance/sample-silver-input.jsonl and labels every (query, candidate)
 * pair via the stub, proving the fixture round-trips through the labeler
 * without hitting production LLM adapters.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  labelRelevance,
  FALLBACK_GRADE,
  FALLBACK_CONFIDENCE,
  type LabelingCandidate,
  type LabelingRequest,
  type LabelingResult,
} from '../llm-relevance-labeler.js';
import {
  StubLabelerLlm,
  MalformedResponseLlm,
  ThrowingLlm,
} from './stub-llm-for-labeler.js';

const BORDEAUX_QUERY = '보르도 레드 와인 추천';

const MARGAUX: LabelingCandidate = {
  entityId: 'w-1',
  canonicalLabel: 'Château Margaux 2015',
  producer: 'Château Margaux',
  region: 'Bordeaux',
  grapes: ['Cabernet Sauvignon', 'Merlot'],
  vintageYear: 2015,
  priceUsd: 850,
};

const GRANGE: LabelingCandidate = {
  entityId: 'w-2',
  canonicalLabel: 'Penfolds Grange 2018',
  producer: 'Penfolds',
  region: 'Barossa Valley',
  grapes: ['Shiraz'],
  vintageYear: 2018,
  priceUsd: 650,
};

const UNKNOWN_CANDIDATE: LabelingCandidate = {
  entityId: 'w-99',
  canonicalLabel: 'Completely Unlisted Wine 2024',
  producer: 'Unknown Producer',
  region: 'Nowhere',
  grapes: ['Mystery'],
};

function buildStub(): StubLabelerLlm {
  const responses = new Map<string, LabelingResult>([
    [MARGAUX.canonicalLabel, { grade: 3, confidence: 0.92, rationale: 'perfect bordeaux match' }],
    [GRANGE.canonicalLabel, { grade: 1, confidence: 0.6, rationale: 'australian shiraz, not bordeaux' }],
  ]);
  return new StubLabelerLlm(responses);
}

describe('labelRelevance (integration with stub LLM)', () => {
  it('returns the predetermined grade for a known entity', async () => {
    const stub = buildStub();
    const request: LabelingRequest = { query: BORDEAUX_QUERY, candidate: MARGAUX };

    const result = await labelRelevance(stub, request);

    expect(result.grade).toBe(3);
    expect(result.confidence).toBeCloseTo(0.92, 5);
    expect(result.rationale).toBe('perfect bordeaux match');
    expect(stub.calls).toBe(1);
  });

  it('falls through to the default neutral response for an unknown entity', async () => {
    const stub = buildStub();
    const request: LabelingRequest = { query: BORDEAUX_QUERY, candidate: UNKNOWN_CANDIDATE };

    const result = await labelRelevance(stub, request);

    // StubLabelerLlm.complete returns the STUB_DEFAULT_RESPONSE
    // (grade 1, confidence 0.5) when nothing matches.
    expect(result.grade).toBe(1);
    expect(result.confidence).toBeCloseTo(0.5, 5);
    expect(result.rationale).toBe('stub default');
    expect(stub.calls).toBe(1);
  });

  it('falls back to FALLBACK_GRADE on malformed LLM response text', async () => {
    const llm = new MalformedResponseLlm();
    const warnings: string[] = [];
    const request: LabelingRequest = { query: BORDEAUX_QUERY, candidate: MARGAUX };

    const result = await labelRelevance(llm, request, { warn: (m) => warnings.push(m) });

    expect(result.grade).toBe(FALLBACK_GRADE);
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
    expect(result.rationale).toBe('parse_fallback');
    // Malformed-but-returned response should not go through the retry path.
    expect(llm.calls).toBe(1);
    expect(warnings).toHaveLength(0);
  });

  it('returns FALLBACK_GRADE/CONFIDENCE when the LLM throws on every attempt', async () => {
    const llm = new ThrowingLlm('boom');
    const warnings: string[] = [];
    const request: LabelingRequest = { query: BORDEAUX_QUERY, candidate: MARGAUX };

    const result = await labelRelevance(llm, request, { warn: (m) => warnings.push(m) });

    expect(result.grade).toBe(FALLBACK_GRADE);
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
    expect(result.rationale).toBe('llm_error_fallback');
    // labelRelevance retries once (LLM_RETRY_COUNT = 1 ⇒ 2 total attempts).
    expect(llm.calls).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('boom');
  });

  it('deterministically labels every candidate in the sample fixture', async () => {
    // Pre-seed the stub with grades for a handful of fixture canonical labels;
    // the rest fall through to the neutral default. This verifies the fixture
    // round-trips through labelRelevance without hitting any real LLM.
    const fixturePath = path.resolve(
      process.cwd(),
      'data/relevance/sample-silver-input.jsonl',
    );
    const raw = await fs.readFile(fixturePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);

    interface FixtureLine {
      readonly queryId: string;
      readonly query: string;
      readonly candidates: readonly LabelingCandidate[];
    }
    const fixture: readonly FixtureLine[] = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      // The fixture is checked-in test data with a known shape; runtime
      // validation would only catch a typo in the test fixture itself, not
      // a real production payload, so a structural cast is acceptable here.
      return parsed as FixtureLine;
    });

    // 5 queries × 3 candidates = 15 pairs.
    expect(fixture).toHaveLength(5);
    const totalPairs = fixture.reduce((n, f) => n + f.candidates.length, 0);
    expect(totalPairs).toBe(15);

    const seeded = new Map<string, LabelingResult>([
      ['Château Margaux 2015', { grade: 3, confidence: 0.95, rationale: 'seeded margaux' }],
      ['Louis Jadot Gevrey-Chambertin 2019', { grade: 3, confidence: 0.9, rationale: 'seeded burgundy' }],
      ['Dom Pérignon Vintage 2013', { grade: 3, confidence: 0.93, rationale: 'seeded champagne' }],
    ]);
    const stub = new StubLabelerLlm(seeded);

    const grades: number[] = [];
    for (const line of fixture) {
      for (const candidate of line.candidates) {
        const result = await labelRelevance(stub, { query: line.query, candidate });
        grades.push(result.grade);
      }
    }

    // Exactly one call per (query, candidate) pair: deterministic, no retries.
    expect(stub.calls).toBe(totalPairs);
    expect(grades).toHaveLength(totalPairs);
    // The three seeded entities must land at grade 3; the remaining 12
    // fall through to the stub default (grade 1).
    const gradeCounts = grades.reduce<Record<number, number>>((acc, g) => {
      acc[g] = (acc[g] ?? 0) + 1;
      return acc;
    }, {});
    expect(gradeCounts[3]).toBe(3);
    expect(gradeCounts[1]).toBe(totalPairs - 3);
  });
});
