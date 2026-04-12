/**
 * Integration smoke test: benchmark scenarios → labeling input → stub silver
 * labeler → promote-to-gold.
 *
 * This is a WIRING test, not a fixture snapshot test. It proves that:
 *   1. The bridge emits schema-valid labeling input from a tiny scenario list.
 *   2. The stub labeler consumes that input and writes NDJSON judgments.
 *   3. The promoter splits those judgments into gold/audit/rejected buckets.
 *   4. The bucket counts are conservative (sum ≤ input count) and account for
 *      every written judgment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runBridge,
  DEFAULT_TOP_K_CANDIDATES,
} from '../../scripts/eval/scenarios-to-labeling-input.js';
import { runStubLabeler, stubGrade } from '../../scripts/eval/generate-silver-labels-stub.js';
import { bucketize } from '../../scripts/eval/promote-to-gold.js';
import { loadRelevanceJudgments } from '../../src/domain/evaluation/service/relevance-judgment-loader.js';

const INPUT_CANDIDATE_COUNT = 3;

describe('silver labeling pipeline (stub)', () => {
  let tmpDir = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'silver-pipeline-'));
  });

  afterAll(async () => {
    // Best effort cleanup — don't fail the test if removal hiccups.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('runs bridge → stub labeler → promoter end-to-end', async () => {
    const labelingInputPath = path.join(tmpDir, 'labeling-input.jsonl');
    const silverPath = path.join(tmpDir, 'silver.ndjson');

    // 1) Bridge: explicit exploratory source mode from AGENT_SCENARIOS against
    //    the real ontology snapshot. Fixture-native corpora are the default
    //    release-gate truth; this test keeps the deterministic exploratory
    //    bridge alive as a non-gating pipeline check.
    const bridgeResult = await runBridge({
      output: labelingInputPath,
      limit: INPUT_CANDIDATE_COUNT,
      topK: DEFAULT_TOP_K_CANDIDATES,
      ontology: 'data/entity-ontology.json',
      sourceMode: 'agent_scenarios',
      help: false,
    });
    expect(bridgeResult.linesWritten).toBeGreaterThan(0);
    expect(bridgeResult.linesWritten).toBeLessThanOrEqual(INPUT_CANDIDATE_COUNT);

    const inputLines = (await fs.readFile(labelingInputPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(inputLines.length).toBe(bridgeResult.linesWritten);

    // Count total (queryId, candidate) pairs that should be labeled.
    let expectedJudgmentCount = 0;
    for (const line of inputLines) {
      const parsed = JSON.parse(line) as { candidates: readonly unknown[] };
      expectedJudgmentCount += parsed.candidates.length;
    }

    // 2) Stub labeler
    const stubResult = await runStubLabeler({
      input: labelingInputPath,
      output: silverPath,
      help: false,
    });
    expect(stubResult.judgmentsWritten).toBe(expectedJudgmentCount);

    // 3) Load silver judgments and bucket them manually — that's cheaper than
    //    shelling out to promote-to-gold.ts and gives the same guarantees.
    const silver = await loadRelevanceJudgments(silverPath);
    expect(silver.length).toBe(expectedJudgmentCount);

    let gold = 0;
    let audit = 0;
    let rejected = 0;
    for (const j of silver) {
      switch (bucketize(j.confidence)) {
        case 'gold':
          gold++;
          break;
        case 'audit':
          audit++;
          break;
        case 'rejected':
          rejected++;
          break;
      }
    }

    // 4) Bucket sum MUST equal the input count — the core invariant.
    expect(gold + audit + rejected).toBe(silver.length);

    // And every judgment must be schema-valid (source correct, grade in 0..3).
    for (const j of silver) {
      expect(j.source).toBe('llm_silver');
      expect([0, 1, 2, 3]).toContain(j.grade);
      expect(j.confidence).toBeGreaterThanOrEqual(0);
      expect(j.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('stubGrade is deterministic for a synthetic strong-match fixture', () => {
    // Directly exercise the stub's happy path so the gold bucket is covered
    // by a unit assertion without depending on ontology content.
    const decision = stubGrade('Bordeaux red wine', {
      entityId: 'synthetic:bordeaux',
      canonicalLabel: 'Bordeaux red',
      region: 'Bordeaux',
    });
    expect(decision.grade).toBe(3);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.85);
    expect(bucketize(decision.confidence)).toBe('gold');

    // Second call with identical args must produce identical bytes.
    const repeat = stubGrade('Bordeaux red wine', {
      entityId: 'synthetic:bordeaux',
      canonicalLabel: 'Bordeaux red',
      region: 'Bordeaux',
    });
    expect(repeat).toEqual(decision);
  });
});
