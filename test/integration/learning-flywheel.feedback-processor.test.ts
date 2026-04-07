import { beforeEach, describe, expect, it } from 'vitest';
import { FeedbackProcessor } from '../../src/domain/learning/service/feedback-processor.js';
import {
  InMemoryFeedbackStore,
} from './helpers/in-memory-adapters.js';
import { CHATEAU_MARGAUX_ID, OPUS_ONE_ID } from './helpers/test-fixtures.js';
import {
  makeClickSignal,
  resetLearningFlywheelTestIds,
  saveSignals,
  seedClickSignals,
  seedStrongAliasEvidence,
} from './helpers/learning-flywheel-test-helpers.js';

describe('Learning Flywheel feedback processor integration', () => {
  let feedbackStore: InMemoryFeedbackStore;
  let feedbackProcessor: FeedbackProcessor;

  beforeEach(() => {
    resetLearningFlywheelTestIds();
    feedbackStore = new InMemoryFeedbackStore();
    feedbackProcessor = new FeedbackProcessor(feedbackStore);
  });

  it('aggregates 10 positive clicks on entity E for query Q into strong signal', async () => {
    const QUERY = 'opus one special';

    await seedStrongAliasEvidence(feedbackStore, QUERY, OPUS_ONE_ID, {
      clickCount: 10,
      clickSessionModulo: 5,
      sessionSuccessCount: 5,
      offsetStepMs: 1000,
    });

    const aggregations = await feedbackProcessor.aggregateByQueryEntity();

    const agg = aggregations.find(
      (a) => a.query === QUERY && a.entityId === OPUS_ONE_ID,
    );
    expect(agg).toBeDefined();
    expect(agg!.positiveCount).toBe(15);
    expect(agg!.sessionCount).toBe(5);
    expect(agg!.clicks).toBe(10);
  });

  it('identifies strong patterns when minSessions and positiveRate conditions are met', async () => {
    const QUERY = 'margaux classic';

    await seedClickSignals(feedbackStore, QUERY, CHATEAU_MARGAUX_ID, {
      count: 10,
      sessionModulo: 5,
      offsetStepMs: 500,
    });

    const aggregations = await feedbackProcessor.aggregateByQueryEntity();
    const strongPatterns = feedbackProcessor.identifyStrongPatterns(
      aggregations,
      5,
      0.7,
    );

    expect(strongPatterns.length).toBeGreaterThan(0);
    const pattern = strongPatterns.find((p) => p.query === QUERY);
    expect(pattern).toMatchObject({
      query: QUERY,
      entityId: CHATEAU_MARGAUX_ID,
    });
  });

  it('detects click spam (> 20 clicks from one session-entity)', async () => {
    await saveSignals(
      feedbackStore,
      Array.from({ length: 21 }, (_, i) =>
        makeClickSignal('opus one', OPUS_ONE_ID, 'spam-session', true, i * 10),
      ),
    );

    const issues = await feedbackProcessor.detectQualityIssues();
    const spamIssues = issues.filter((issue) => issue.type === 'click_spam');
    expect(spamIssues.length).toBeGreaterThan(0);
    expect(spamIssues[0]!.signalCount).toBeGreaterThan(20);
  });
});
