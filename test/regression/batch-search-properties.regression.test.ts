/**
 * Property-based regression tests for BatchSearchUseCase
 * (`tools.batch-search`, feature catalog category `tools`).
 *
 * Batch search dispatches N independent search queries in a single call and
 * aggregates the results. Because it backs the dashboard / simulation surface
 * (POST /v1/batch-search), the following invariants MUST hold; any regression
 * here corrupts caller correlation, idempotency keys, or batch cardinality.
 *
 * Invariants verified (append-only, SOTA++ grade, numRuns = 100 each):
 *  1. Cardinality — `results.length === total === requests.length`, and
 *     `succeeded + failed + not_executed === total`. The batch never drops or
 *     duplicates a slot regardless of per-item outcome.
 *  2. Per-query independence — every requested `id` appears exactly once in the
 *     results, in the same order as the input requests. No double-issue.
 *  3. Result-ordering determinism — `results[i].id === requests[i].id`.
 *  4. Batch-id determinism + NFC invariance — two batches whose queries differ
 *     only by Unicode normalization form (NFC vs NFD, common with composed
 *     Korean 한글) produce the SAME deterministic `batch_id`. The idempotency
 *     key is invariant under Unicode normalization.
 *  5. Bounded batch size — a batch larger than MAX_BATCH_SIZE fails fast as a
 *     whole (every item failed, batch_status === 'failed') without dispatching
 *     a single sub-search.
 *  6. Empty-batch safety — an empty request array returns a well-formed
 *     succeeded envelope with zero counts and no dispatch.
 *  7. Failure isolation — one query throwing does NOT crash the batch in
 *     partial (non-fail-fast) mode; other queries still run and succeed.
 *  8. No-throw contract — `execute` never rejects; all errors are captured in
 *     the response envelope.
 *  9. batch_status / has_failures consistency — derived fields match the
 *     aggregated counts exactly (mirrors the HTTP response schema refinement).
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the use case to
 * make a property pass. The only production change paired with this file is a
 * structural NFC normalization of the deterministic batch-id input so the
 * idempotency key is normalization-invariant (invariant 4).
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  BatchSearchUseCase,
  type BatchSearchRequestItem,
} from '../../src/application/search/batch-search.usecase.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

// fast-check is deterministic for a given seed; the runner pins a seed on
// failure so reruns reproduce. All async properties use this run count.
const NUM_RUNS = 100;

// Mirror of BatchSearchUseCase.MAX_BATCH_SIZE — kept as a named constant so the
// over-size property does not embed a magic number. Source value: 20.
const EXPECTED_MAX_BATCH_SIZE = 20;

function makeSearchResponse(requestId = 'req'): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.95,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results: [],
    clarification: null,
    meta: {
      requestId,
      queryTimeMs: 1,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
      response_hash: 'hash',
    },
  };
}

/**
 * Build a SearchExecutorPort whose behavior is decided per-query by `verdicts`
 * (true → succeed, false → throw). Records every query string it received so
 * tests can assert per-query independence / non-dispatch.
 */
function makeExecutor(verdict: (query: string, requestId: string) => boolean): {
  port: SearchExecutorPort;
  calls: string[];
} {
  const calls: string[] = [];
  const port: SearchExecutorPort = {
    execute: vi.fn(async (request, requestId) => {
      calls.push(request.query);
      if (!verdict(request.query, requestId)) {
        throw new Error('synthetic failure');
      }
      return makeSearchResponse(requestId);
    }),
  };
  return { port, calls };
}

// Arbitrary for batch item ids that are unique within a batch is enforced by
// generating an index-suffixed id; the query body may be ASCII, Korean, or
// accented Latin to exercise Unicode paths.
const queryArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.constantFrom(
    '까베르네 소비뇽',
    '부르고뉴 화이트',
    '리오하 레세르바',
    '바롤로 2015',
    '샴페인 브뤼',
    'Châteauneuf-du-Pape',
    'Rioja Reserva',
    '한국 와인 5만원 이하',
  ),
);

function itemsArb(maxItems: number) {
  return fc
    .array(queryArb, { minLength: 1, maxLength: maxItems })
    .map((queries): BatchSearchRequestItem[] =>
      queries.map((query, i) => ({ id: `item-${String(i)}`, query: query || `q-${String(i)}` })),
    );
}

describe('batch-search properties (regression)', () => {
  it('invariant 1+2+3: cardinality, no double-issue, ordering determinism', async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb(EXPECTED_MAX_BATCH_SIZE), async (items) => {
        const { port } = makeExecutor(() => true);
        const useCase = new BatchSearchUseCase(port);
        const res = await useCase.execute(items);

        expect(res.total).toBe(items.length);
        expect(res.results.length).toBe(items.length);
        expect(res.succeeded + res.failed + res.not_executed).toBe(res.total);

        // ordering + uniqueness
        const seen = new Set<string>();
        for (let i = 0; i < items.length; i++) {
          expect(res.results[i]!.id).toBe(items[i]!.id);
          expect(seen.has(res.results[i]!.id)).toBe(false);
          seen.add(res.results[i]!.id);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('invariant 4: batch_id is deterministic and NFC-normalization invariant (Korean)', async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb(EXPECTED_MAX_BATCH_SIZE), async (items) => {
        const { port } = makeExecutor(() => true);
        const useCase = new BatchSearchUseCase(port);

        // Same input → same generated batch id (determinism).
        const a = await useCase.execute(items);
        const b = await useCase.execute(items);
        expect(a.batch_id).toBe(b.batch_id);

        // NFC vs NFD of the same logical queries → same batch id (invariance).
        const nfcItems = items.map((it) => ({ ...it, query: it.query.normalize('NFC') }));
        const nfdItems = items.map((it) => ({ ...it, query: it.query.normalize('NFD') }));
        const nfc = await useCase.execute(nfcItems);
        const nfd = await useCase.execute(nfdItems);
        expect(nfc.batch_id).toBe(nfd.batch_id);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('invariant 5: over-size batch fails as a whole and dispatches nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: EXPECTED_MAX_BATCH_SIZE + 1, max: EXPECTED_MAX_BATCH_SIZE + 30 }),
        async (count) => {
          const items: BatchSearchRequestItem[] = Array.from({ length: count }, (_v, i) => ({
            id: `item-${String(i)}`,
            query: `query ${String(i)}`,
          }));
          const { port, calls } = makeExecutor(() => true);
          const useCase = new BatchSearchUseCase(port);
          const res = await useCase.execute(items);

          expect(res.batch_status).toBe('failed');
          expect(res.failed).toBe(count);
          expect(res.succeeded).toBe(0);
          expect(res.results.length).toBe(count);
          // No sub-search dispatched for an over-size batch.
          expect(calls.length).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('invariant 6: empty batch is safe (succeeded, zero counts, no dispatch)', async () => {
    const { port, calls } = makeExecutor(() => true);
    const useCase = new BatchSearchUseCase(port);
    const res = await useCase.execute([]);

    expect(res.total).toBe(0);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.not_executed).toBe(0);
    expect(res.batch_status).toBe('succeeded');
    expect(res.has_failures).toBe(false);
    expect(res.results).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('invariant 7+8: one failing query does not crash the batch (partial mode)', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemsArb(EXPECTED_MAX_BATCH_SIZE),
        fc.integer({ min: 0, max: EXPECTED_MAX_BATCH_SIZE - 1 }),
        async (items, failIdx) => {
          const targetId = `item-${String(failIdx % items.length)}`;
          const { port } = makeExecutor((_q, requestId) => !requestId.endsWith(targetId));
          const useCase = new BatchSearchUseCase(port);

          // Must not reject.
          const res = await useCase.execute(items, { fail_fast: false });

          expect(res.results.length).toBe(items.length);
          // The targeted item failed; everything else succeeded (independence).
          const failedItem = res.results.find((r) => r.id === targetId)!;
          expect(failedItem.status).toBe('failed');
          expect(res.succeeded).toBe(items.length - 1);
          expect(res.failed).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('invariant 9: batch_status / has_failures match aggregated counts', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemsArb(EXPECTED_MAX_BATCH_SIZE),
        // verdict bitmask: bit i decides whether query i succeeds.
        fc.bigInt({ min: 0n, max: (1n << 20n) - 1n }),
        async (items, mask) => {
          let idx = 0;
          const queryToBit = new Map<string, boolean>();
          for (const it of items) {
            queryToBit.set(it.query + ' ' + String(idx), ((mask >> BigInt(idx)) & 1n) === 1n);
            idx++;
          }
          let callIdx = 0;
          const port: SearchExecutorPort = {
            execute: vi.fn(async (request, requestId) => {
              const ok = ((mask >> BigInt(callIdx)) & 1n) === 1n;
              callIdx++;
              if (!ok) throw new Error('synthetic');
              return makeSearchResponse(requestId);
            }),
          };
          const useCase = new BatchSearchUseCase(port);
          const res = await useCase.execute(items, { fail_fast: false });

          const anyFailures = res.failed > 0 || res.not_executed > 0;
          const expectedStatus = !anyFailures
            ? 'succeeded'
            : res.succeeded === 0
              ? 'failed'
              : 'partial_failure';
          expect(res.batch_status).toBe(expectedStatus);
          expect(res.has_failures).toBe(anyFailures);
          expect(res.succeeded + res.failed + res.not_executed).toBe(res.total);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
