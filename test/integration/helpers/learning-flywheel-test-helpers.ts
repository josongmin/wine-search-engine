import type { FeedbackSignal } from '../../../src/domain/learning/model/feedback-signal.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { OPUS_ONE_ID } from './test-fixtures.js';
import type { InMemoryFeedbackStore } from './in-memory-adapters.js';

let idCounter = 0;

export function resetLearningFlywheelTestIds() {
  idCounter = 0;
}

function nextId(): string {
  return `signal-${++idCounter}`;
}

export function nextProposalId(): string {
  return `proposal-${++idCounter}`;
}

const BASE_SNAPSHOT = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default',
  planner_version: '1.0.0',
  feature_flags: {},
} as const;

export function makeClickSignal(
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  sessionId: string,
  isPositive = true,
  offsetMs = 0,
): FeedbackSignal {
  return {
    signalId: nextId(),
    type: 'click',
    query,
    queryClass: 'short_entity',
    entityId,
    isPositive,
    timestamp: new Date(Date.now() + offsetMs),
    sessionId,
    decisionSnapshot: BASE_SNAPSHOT,
  };
}

function makeSessionSuccessSignal(
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  sessionId: string,
): FeedbackSignal {
  return {
    signalId: nextId(),
    type: 'session_success',
    query,
    queryClass: 'short_entity',
    entityId,
    isPositive: true,
    timestamp: new Date(),
    sessionId,
    decisionSnapshot: BASE_SNAPSHOT,
  };
}

export async function saveSignals(
  feedbackStore: InMemoryFeedbackStore,
  signals: readonly FeedbackSignal[],
): Promise<void> {
  await Promise.all(signals.map(async (signal) => {
    await feedbackStore.saveFeedback(signal);
  }));
}

export async function seedClickSignals(
  feedbackStore: InMemoryFeedbackStore,
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  options: {
    count: number;
    sessionModulo: number;
    isPositive?: boolean;
    offsetStepMs?: number;
  },
): Promise<void> {
  await saveSignals(
    feedbackStore,
    Array.from({ length: options.count }, (_, i) =>
      makeClickSignal(
        query,
        entityId,
        `sess-${i % options.sessionModulo}`,
        options.isPositive ?? true,
        i * (options.offsetStepMs ?? 1000),
      ),
    ),
  );
}

export async function seedSessionSuccessSignals(
  feedbackStore: InMemoryFeedbackStore,
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  count: number,
): Promise<void> {
  await saveSignals(
    feedbackStore,
    Array.from({ length: count }, (_, i) =>
      makeSessionSuccessSignal(query, entityId, `sess-${i}`),
    ),
  );
}

export async function seedStrongAliasEvidence(
  feedbackStore: InMemoryFeedbackStore,
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  options: {
    clickCount: number;
    clickSessionModulo: number;
    sessionSuccessCount?: number;
    offsetStepMs?: number;
  },
): Promise<void> {
  await seedClickSignals(feedbackStore, query, entityId, {
    count: options.clickCount,
    sessionModulo: options.clickSessionModulo,
    offsetStepMs: options.offsetStepMs,
  });

  if ((options.sessionSuccessCount ?? 0) > 0) {
    await seedSessionSuccessSignals(
      feedbackStore,
      query,
      entityId,
      options.sessionSuccessCount ?? 0,
    );
  }
}

export function makePendingAliasProposal(
  overrides: Partial<{
    proposalId: string;
    surfaceForm: string;
    targetEntityId: ReturnType<typeof createEntityId>;
    queryCount: number;
    clickThroughRate: number;
    sessionSuccessRate: number;
    confidence: number;
  }> = {},
) {
  return {
    proposalId: overrides.proposalId ?? 'proposal-default',
    surfaceForm: overrides.surfaceForm ?? 'default alias',
    targetEntityId: overrides.targetEntityId ?? OPUS_ONE_ID,
    proposedType: 'observed_query_alias' as const,
    evidence: {
      queryCount: overrides.queryCount ?? 20,
      clickThroughRate: overrides.clickThroughRate ?? 0.85,
      sessionSuccessRate: overrides.sessionSuccessRate ?? 0.75,
    },
    confidence: overrides.confidence ?? 0.92,
    status: 'pending' as const,
    createdAt: new Date(),
  };
}
