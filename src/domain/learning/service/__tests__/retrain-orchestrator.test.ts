import { describe, it, expect } from 'vitest';
import { RetrainOrchestrator, type RetrainConfig } from '../retrain-orchestrator.js';
import { InMemoryModelRegistry } from '../../../../infrastructure/adapter/in-memory-model-registry.js';
import type { FeedbackEvent } from '../../../feedback/model/feedback-event.js';

function evt(
  partial: Partial<FeedbackEvent> &
    Pick<FeedbackEvent, 'eventId' | 'eventType' | 'entityId' | 'position' | 'query'>,
): FeedbackEvent {
  return {
    timestamp: 0,
    requestId: 'req',
    ...partial,
  };
}

/** Simple reader wrapping a mutable array, matching `FeedbackCollectorReader`. */
class ArrayReader {
  constructor(private readonly events: FeedbackEvent[]) {}
  getAll(): readonly FeedbackEvent[] {
    return this.events;
  }
}

function buildSufficientEvents(): FeedbackEvent[] {
  // 6 impressions + 1 click on (q='pinot noir', entity='w1') — passes the
  // default minImpressions=5 filter in extractTrainingData so the stub
  // receives a non-empty dataset.
  const out: FeedbackEvent[] = [];
  for (let i = 0; i < 6; i++) {
    out.push(
      evt({
        eventId: `i${i}`,
        eventType: 'impression',
        query: 'pinot noir',
        entityId: 'w1',
        position: 0,
      }),
    );
  }
  out.push(
    evt({
      eventId: 'c1',
      eventType: 'click',
      query: 'pinot noir',
      entityId: 'w1',
      position: 0,
    }),
  );
  return out;
}

const defaultConfig: RetrainConfig = {
  minEventsForRetrain: 5,
  minNdcgImprovement: 0.01,
  minHoursBetweenRetrains: 1,
};

describe('RetrainOrchestrator', () => {
  it('insufficient events → status insufficient_data', async () => {
    const reader = new ArrayReader([
      evt({ eventId: 'i1', eventType: 'impression', query: 'q', entityId: 'w1', position: 0 }),
    ]);
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const result = await orch.run(1_000_000);
    expect(result.status).toBe('insufficient_data');
    expect(result.trainSampleCount).toBe(0);
    expect(result.reason).toMatch(/events/);
  });

  it('sufficient events → status success with stub metrics and active model', async () => {
    const reader = new ArrayReader(buildSufficientEvents());
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const result = await orch.run(1_000_000);
    expect(result.status).toBe('success');
    expect(result.trainSampleCount).toBeGreaterThanOrEqual(1);
    expect(result.newModelMetrics).toBeDefined();
    expect(Number.isFinite(result.newModelMetrics!.ndcg_at_10)).toBe(true);

    const active = await registry.getActive();
    expect(active).not.toBeNull();
    expect(active!.artifact.trainingMetrics.ndcg_at_10).toBe(result.newModelMetrics!.ndcg_at_10);
  });

  it('cooldown not elapsed → returns insufficient_data on second run', async () => {
    const reader = new ArrayReader(buildSufficientEvents());
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const t0 = 1_000_000;
    const first = await orch.run(t0);
    expect(first.status).toBe('success');

    // Advance clock by only 5 minutes — well under the 1h cooldown.
    const fiveMinutesMs = 5 * 60 * 1000;
    const second = await orch.run(t0 + fiveMinutesMs);
    expect(second.status).toBe('insufficient_data');
    expect(second.reason).toMatch(/cooldown/);
  });

  it('successful retrain registers new model in registry', async () => {
    const reader = new ArrayReader(buildSufficientEvents());
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const before = await registry.list();
    expect(before).toHaveLength(0);

    const result = await orch.run(2_000_000);
    expect(result.status).toBe('success');

    const after = await registry.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('active');
    expect(after[0]!.artifact.version).toBe('ltr-2000000');
  });

  // W6-P0: stubTrain() 하드코딩 — LTR 실제 재학습 미작동
  // 현재 retrain-orchestrator.ts는 stubTrain()을 호출해 NDCG=0.72, MRR=0.61을 하드코딩 반환.
  // 실제 trainLambdaMARTModel()이 연결되면 NDCG는 학습 데이터에 따라 달라져야 한다.
  // 또한 artifact version이 'stub-' prefix로 시작하면 안 된다.
  it('W6-P0: trained model artifact version should NOT be stub-prefixed', async () => {
    const reader = new ArrayReader(buildSufficientEvents());
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const result = await orch.run(3_000_000);
    expect(result.status).toBe('success');

    const active = await registry.getActive();
    expect(active).not.toBeNull();
    // Real training should produce a version that doesn't say 'stub'
    expect(active!.artifact.version, 'artifact version must not be stub-prefixed — stubTrain() must be replaced with real trainLambdaMARTModel()').not.toMatch(/^stub-/);
  });

  it('W6-P0: trained model NDCG should vary with data (not be hardcoded 0.72)', async () => {
    // stubTrain() always returns NDCG_AT_10=0.72. Real training computes from data.
    // With minimal data (1 query, 1 click) NDCG should NOT equal the stub constant 0.72.
    const reader = new ArrayReader(buildSufficientEvents());
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(reader, registry, defaultConfig);

    const result = await orch.run(4_000_000);
    expect(result.status).toBe('success');
    // Hardcoded stub value — real LTR will produce a different number
    expect(result.newModelMetrics!.ndcg_at_10).not.toBe(0.72);
  });

  it('feedback collector throws → returns failed status', async () => {
    const throwingReader = {
      getAll(): readonly FeedbackEvent[] {
        throw new Error('collector I/O failed');
      },
    };
    const registry = new InMemoryModelRegistry();
    const orch = new RetrainOrchestrator(throwingReader, registry, defaultConfig);

    const result = await orch.run(2_000_000);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/collector|failed/i);
    // No model should have been registered.
    expect(await registry.list()).toHaveLength(0);
  });
});
