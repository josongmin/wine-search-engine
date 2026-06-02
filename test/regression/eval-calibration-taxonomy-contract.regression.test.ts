/**
 * Regression: eval ↔ runtime query-class mismatch is a FIRST-CLASS eval metric.
 *
 * Root bug (migration 025): calibration was keyed by the GOLD query class
 * (e.g. `exact_entity`) while the runtime resolver keys by the CLASSIFIER's
 * output (e.g. `short_entity`). `extract-calibration-trace.ts` now stratifies
 * calibration by `COALESCE(runtime_query_class, gold_query_class)`, but nothing
 * surfaced the disagreement rate, so the taxonomy drift was invisible.
 *
 * This contract pins:
 *  (a) a SearchPipelineOutput carrying `runtimeQueryClass` that differs from the
 *      gold class + `goldRuntimeQueryClassMismatch = true` flows through
 *      EvalRunner into an EvalResult that carries both fields, and
 *  (b) SliceEvaluator.computeMetrics() reports a non-zero
 *      `goldRuntimeQueryClassMismatchRate` and a per-class breakdown keyed by
 *      the RUNTIME class.
 *
 * Plus the verdict-required edge cases: undefined-runtime-class NaN safety,
 * the exactOptionalPropertyTypes shape choice (required, possibly-empty Map),
 * the healthy-taxonomy false-positive (all gold === runtime → rate 0), and the
 * disjointness of the mismatch metric from slice-underperformance flagging.
 */

import { describe, it, expect } from 'vitest';
import {
  EvalRunner,
  type SearchPipelinePort,
  type SearchPipelineOutput,
  type ReleaseGates,
} from '../../src/domain/evaluation/service/eval-runner.js';
import { SliceEvaluator } from '../../src/domain/evaluation/service/slice-evaluator.js';
import { UtilityScorer } from '../../src/domain/evaluation/service/utility-scorer.js';
import { SelectivePredictor } from '../../src/domain/evaluation/service/selective-predictor.js';
import { CalibrationEvaluator } from '../../src/domain/evaluation/service/calibration-evaluator.js';
import { EvidenceAuditor } from '../../src/domain/evaluation/service/evidence-auditor.js';
import type { EvalCase } from '../../src/domain/evaluation/model/eval-case.js';
import type { EvalResult } from '../../src/domain/evaluation/model/eval-result.js';
import type { EvalMetrics } from '../../src/domain/evaluation/model/eval-metrics.js';
import type { QueryClass } from '../../src/domain/shared/types/query-class.js';
import type { EntityId, EvidenceItem, DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import {
  InMemoryGoldSetStore,
  InMemoryEvalResultStore,
} from '../integration/helpers/in-memory-adapters.js';
import { OPUS_ONE_ID } from '../integration/helpers/test-fixtures.js';

const STUB_SNAPSHOT: DecisionSnapshot = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: 'taxonomy-contract-stub',
  threshold_profile_id: 'default',
  planner_version: 'taxonomy-contract-stub',
  feature_flags: {},
};

const STUB_EVIDENCE: readonly EvidenceItem[] = [
  {
    type: 'lexical_match',
    source: 'taxonomy_contract_stub',
    contribution: '+0.55',
    strength: 'high',
    provenance: 'taxonomy contract stub',
  },
];

function makeCase(
  id: string,
  query: string,
  queryClass: QueryClass,
  expectedEntityId?: EntityId,
): EvalCase {
  return {
    caseId: id,
    query,
    queryClass,
    expectedStatus: expectedEntityId !== undefined ? 'resolved' : 'ambiguous',
    ...(expectedEntityId !== undefined ? { expectedEntityId } : {}),
    labelTier: 'gold',
    annotatorAgreement: 0.9,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    sliceTags: [],
  };
}

const RELAXED_RELEASE_GATES: ReleaseGates = {
  minUtility: 0.0,
  maxWrongResolveRate: 1.0,
  maxECE: 1.0,
  maxEAURC: 1.0,
  maxAdmissionViolationRate: 1.0,
  minEvidenceSufficiency: 0.0,
  minEvidenceComprehensiveness: 0.0,
};

/**
 * Pipeline stub that surfaces a runtime query class + precomputed mismatch
 * flag per case. The adapter (in production) computes the mismatch flag by
 * comparing the classifier's runtime class against the gold class; here we
 * inject it directly so the contract is deterministic.
 */
class TaxonomyStubPipeline implements SearchPipelinePort {
  constructor(
    private readonly cases: readonly EvalCase[],
    private readonly runtimeClassByQuery: ReadonlyMap<string, QueryClass>,
  ) {}

  async execute(
    query: string,
    goldQueryClass: EvalCase['queryClass'],
  ): Promise<SearchPipelineOutput> {
    const c = this.cases.find((x) => x.query === query);
    if (c === undefined) {
      throw new Error(`taxonomy stub: missing case for query ${query}`);
    }
    const resolved = c.expectedStatus === 'resolved';
    const runtimeClass = this.runtimeClassByQuery.get(query);
    const mismatch = runtimeClass !== undefined && runtimeClass !== goldQueryClass;
    return {
      predictedStatus: c.expectedStatus,
      ...(resolved && c.expectedEntityId !== undefined
        ? { predictedEntityId: c.expectedEntityId }
        : {}),
      decisionConfidence: 0.88,
      evidenceItems: resolved ? STUB_EVIDENCE : [],
      latencyMs: 1,
      decisionSnapshot: STUB_SNAPSHOT,
      ...(runtimeClass !== undefined ? { runtimeQueryClass: runtimeClass } : {}),
      ...(mismatch ? { goldRuntimeQueryClassMismatch: true } : {}),
    };
  }
}

function newSliceEvaluator(): SliceEvaluator {
  return new SliceEvaluator(
    new UtilityScorer(),
    new SelectivePredictor(),
    new CalibrationEvaluator(),
    new EvidenceAuditor(),
  );
}

/**
 * Builds a minimal EvalResult for direct computeMetrics() unit tests.
 * Respects exactOptionalPropertyTypes: optional keys are omitted, never set
 * to `undefined`.
 */
function makeResult(
  caseId: string,
  opts: {
    readonly runtimeQueryClass?: QueryClass;
    readonly mismatch?: boolean;
    readonly isCorrectResolve?: boolean;
    readonly isWrongResolve?: boolean;
    readonly utilityScore?: number;
  } = {},
): EvalResult {
  const isCorrectResolve = opts.isCorrectResolve ?? true;
  const isWrongResolve = opts.isWrongResolve ?? false;
  return {
    caseId,
    predictedEntityId: OPUS_ONE_ID,
    predictedStatus: 'resolved',
    decisionConfidence: 0.9,
    utilityScore: opts.utilityScore ?? (isCorrectResolve ? 1.0 : -1.5),
    isCorrectResolve,
    isWrongResolve,
    isSafeAbstain: false,
    isAvoidableAbstain: false,
    evidenceItems: STUB_EVIDENCE,
    latencyMs: 1,
    decisionSnapshot: STUB_SNAPSHOT,
    ...(opts.runtimeQueryClass !== undefined
      ? { runtimeQueryClass: opts.runtimeQueryClass }
      : {}),
    ...(opts.mismatch === true ? { goldRuntimeQueryClassMismatch: true } : {}),
  };
}

describe('eval ↔ runtime query-class mismatch is a first-class metric', () => {
  describe('(a) end-to-end flow through EvalRunner', () => {
    it('propagates runtimeQueryClass + goldRuntimeQueryClassMismatch into the stored EvalResult and overall metrics', async () => {
      // Gold class is exact_entity; the runtime classifier emits short_entity —
      // exactly the calibration-keying drift from migration 025.
      const evalCase = makeCase('tc-mismatch', 'Opus One 2018', 'exact_entity', OPUS_ONE_ID);
      const runtimeClassByQuery = new Map<string, QueryClass>([
        ['Opus One 2018', 'short_entity'],
      ]);

      const goldSetStore = new InMemoryGoldSetStore();
      const evalResultStore = new InMemoryEvalResultStore();
      await goldSetStore.addCase(evalCase);

      const pipeline = new TaxonomyStubPipeline([evalCase], runtimeClassByQuery);
      const runner = new EvalRunner(goldSetStore, evalResultStore, pipeline, RELAXED_RELEASE_GATES);

      const report = await runner.run();

      // EvalResult carries both runtime fields.
      const [stored] = evalResultStore.getAll();
      expect(stored?.runtimeQueryClass).toBe('short_entity');
      expect(stored?.goldRuntimeQueryClassMismatch).toBe(true);

      // (b) metrics report a non-zero mismatch rate (1 of 1 mismatched).
      expect(report.overallMetrics.goldRuntimeQueryClassMismatchRate).toBe(1);
      // Per-class breakdown keyed by the RUNTIME class.
      expect(report.overallMetrics.mismatchRateByClass.get('short_entity')).toBe(1);
      expect(report.overallMetrics.mismatchRateByClass.has('exact_entity')).toBe(false);
    });

    it('matching gold === runtime emits no mismatch flag and rate 0', async () => {
      const evalCase = makeCase('tc-match', 'Opus One 2018', 'short_entity', OPUS_ONE_ID);
      const runtimeClassByQuery = new Map<string, QueryClass>([
        ['Opus One 2018', 'short_entity'],
      ]);

      const goldSetStore = new InMemoryGoldSetStore();
      const evalResultStore = new InMemoryEvalResultStore();
      await goldSetStore.addCase(evalCase);

      const runner = new EvalRunner(
        goldSetStore,
        evalResultStore,
        new TaxonomyStubPipeline([evalCase], runtimeClassByQuery),
        RELAXED_RELEASE_GATES,
      );

      const report = await runner.run();
      const [stored] = evalResultStore.getAll();
      expect(stored?.runtimeQueryClass).toBe('short_entity');
      expect(stored?.goldRuntimeQueryClassMismatch).toBeUndefined();
      expect(report.overallMetrics.goldRuntimeQueryClassMismatchRate).toBe(0);
    });
  });

  describe('(b) computeMetrics() mismatch-rate math', () => {
    it('overall rate = mismatches / total', () => {
      const evaluator = newSliceEvaluator();
      const results: EvalResult[] = [
        makeResult('r1', { runtimeQueryClass: 'short_entity', mismatch: true }),
        makeResult('r2', { runtimeQueryClass: 'short_entity', mismatch: false }),
        makeResult('r3', { runtimeQueryClass: 'pure_constraint', mismatch: true }),
        makeResult('r4', { runtimeQueryClass: 'pure_constraint', mismatch: false }),
      ];

      const metrics = evaluator.computeMetrics(results);

      // 2 of 4 mismatched.
      expect(metrics.goldRuntimeQueryClassMismatchRate).toBe(0.5);
      // Each class: 1 of 2 mismatched.
      expect(metrics.mismatchRateByClass.get('short_entity')).toBe(0.5);
      expect(metrics.mismatchRateByClass.get('pure_constraint')).toBe(0.5);
    });

    it('empty result set → rate 0 and empty map, never NaN', () => {
      const evaluator = newSliceEvaluator();
      const metrics = evaluator.computeMetrics([]);

      expect(metrics.goldRuntimeQueryClassMismatchRate).toBe(0);
      expect(Number.isNaN(metrics.goldRuntimeQueryClassMismatchRate)).toBe(false);
      expect(metrics.mismatchRateByClass.size).toBe(0);
    });

    // VERDICT-REQUIRED: some results missing runtimeQueryClass (undefined),
    // some concrete — rate computed correctly, no NaN, undefined bucketed
    // under the 'unknown' fallback.
    it('handles a mix of undefined and concrete runtimeQueryClass without NaN', () => {
      const evaluator = newSliceEvaluator();
      const results: EvalResult[] = [
        // No runtimeQueryClass → falls back to 'unknown'.
        makeResult('r1', { mismatch: true }),
        makeResult('r2', { mismatch: false }),
        makeResult('r3', { runtimeQueryClass: 'short_entity', mismatch: true }),
      ];

      const metrics = evaluator.computeMetrics(results);

      // 2 of 3 mismatched overall.
      expect(metrics.goldRuntimeQueryClassMismatchRate).toBeCloseTo(2 / 3, 10);
      expect(Number.isNaN(metrics.goldRuntimeQueryClassMismatchRate)).toBe(false);

      // 'unknown' bucket: 1 of 2 mismatched; 'short_entity': 1 of 1.
      expect(metrics.mismatchRateByClass.get('unknown')).toBe(0.5);
      expect(metrics.mismatchRateByClass.get('short_entity')).toBe(1);
      for (const rate of metrics.mismatchRateByClass.values()) {
        expect(Number.isNaN(rate)).toBe(false);
      }
    });

    // VERDICT-REQUIRED FALSE-POSITIVE: a healthy taxonomy (all gold === runtime,
    // no mismatch flags) must report rate EXACTLY 0 and a map of all-zero rates.
    it('healthy taxonomy (no mismatches) reports rate exactly 0', () => {
      const evaluator = newSliceEvaluator();
      const results: EvalResult[] = [
        makeResult('r1', { runtimeQueryClass: 'short_entity', mismatch: false }),
        makeResult('r2', { runtimeQueryClass: 'pure_constraint', mismatch: false }),
        makeResult('r3', { runtimeQueryClass: 'exact_entity', mismatch: false }),
      ];

      const metrics = evaluator.computeMetrics(results);

      expect(metrics.goldRuntimeQueryClassMismatchRate).toBe(0);
      for (const rate of metrics.mismatchRateByClass.values()) {
        expect(rate).toBe(0);
      }
    });

    // exactOptionalPropertyTypes shape choice: mismatchRateByClass is a
    // REQUIRED ReadonlyMap that may be EMPTY (never undefined / never omitted).
    it('mismatchRateByClass is always a present Map (required, possibly empty)', () => {
      const evaluator = newSliceEvaluator();

      const emptyMetrics = evaluator.computeMetrics([]);
      expect(emptyMetrics.mismatchRateByClass).toBeInstanceOf(Map);
      expect(emptyMetrics.mismatchRateByClass.size).toBe(0);

      const nonEmptyMetrics = evaluator.computeMetrics([
        makeResult('r1', { runtimeQueryClass: 'short_entity', mismatch: true }),
      ]);
      expect(nonEmptyMetrics.mismatchRateByClass).toBeInstanceOf(Map);
      expect(nonEmptyMetrics.mismatchRateByClass.size).toBe(1);

      // Compile-time: the field is non-optional on EvalMetrics, so this access
      // requires no `?.` or `?? new Map()` guard.
      const assertPresent = (m: EvalMetrics): number => m.mismatchRateByClass.size;
      expect(assertPresent(emptyMetrics)).toBe(0);
    });
  });

  // VERDICT-REQUIRED DISJOINTNESS: a high mismatch rate (>5%) must NOT cause the
  // existing slice-underperformance flagging (utility / wrong-resolve / ECE) to
  // misfire. The mismatch metric is a separate diagnostic axis.
  describe('mismatch rate is disjoint from slice-underperformance flagging', () => {
    it('100% mismatch rate with healthy utility/wrong-resolve does not flag any slice', () => {
      const evaluator = newSliceEvaluator();

      // All results mismatched (rate = 1.0, far above the 5% threshold) but all
      // correctly resolved with full utility and zero wrong-resolves.
      const results: EvalResult[] = [
        makeResult('r1', { runtimeQueryClass: 'short_entity', mismatch: true, isCorrectResolve: true, utilityScore: 1.0 }),
        makeResult('r2', { runtimeQueryClass: 'short_entity', mismatch: true, isCorrectResolve: true, utilityScore: 1.0 }),
        makeResult('r3', { runtimeQueryClass: 'pure_constraint', mismatch: true, isCorrectResolve: true, utilityScore: 1.0 }),
      ];
      const cases: EvalCase[] = [
        makeCase('r1', 'q1', 'exact_entity', OPUS_ONE_ID),
        makeCase('r2', 'q2', 'exact_entity', OPUS_ONE_ID),
        makeCase('r3', 'q3', 'semantic_preference', OPUS_ONE_ID),
      ];

      const overall = evaluator.computeMetrics(results);
      expect(overall.goldRuntimeQueryClassMismatchRate).toBe(1);

      const sliceMetrics = evaluator.evaluateBySlice(results, cases);
      const flagged = evaluator.flagUnderperformingSlices(sliceMetrics, overall);

      // No slice flagged — flagging keys on utility / wrong-resolve / ECE only,
      // none of which the mismatch rate touches.
      expect(flagged).toHaveLength(0);
      // And none of the flag metrics is 'mismatch'-derived.
      for (const f of flagged) {
        expect(['decisionUtility', 'wrongResolveRate', 'ece']).toContain(f.metric);
      }
    });
  });
});
