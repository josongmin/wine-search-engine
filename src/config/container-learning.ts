import type { Pool } from 'pg';
import { FeedbackProcessor } from '../domain/learning/service/feedback-processor.js';
import { AliasProposer } from '../domain/learning/service/alias-proposer.js';
import type { ExistingAliasChecker } from '../domain/learning/service/alias-proposer.js';
import { PgFeedbackStore } from '../infrastructure/adapter/pg-feedback-store.js';
import { PgProposalStore } from '../infrastructure/adapter/pg-proposal-store.js';
import type { FeedbackStore } from '../domain/learning/port/feedback-store.port.js';
import type { ProposalStore } from '../domain/learning/port/proposal-store.port.js';
import type { RuntimeHandles } from './runtime-handles.js';

export interface LearningContainerServices {
  readonly feedbackStore: FeedbackStore | null;
  readonly proposalStore: ProposalStore | null;
  readonly feedbackProcessor: FeedbackProcessor | null;
  readonly aliasProposer: AliasProposer | null;
}

function buildPgAliasChecker(pool: Pool): ExistingAliasChecker {
  return {
    async aliasExists(surfaceForm: string): Promise<boolean> {
      const result = await pool.query(
        `SELECT 1 FROM aliases
         WHERE surface_form = $1 AND is_suppressed = FALSE
         LIMIT 1`,
        [surfaceForm],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function buildLearningContainerServices(
  runtime: RuntimeHandles = {},
): LearningContainerServices {
  const pool: Pool | undefined = runtime.pool;

  if (pool === undefined) {
    return {
      feedbackStore: null,
      proposalStore: null,
      feedbackProcessor: null,
      aliasProposer: null,
    };
  }

  const feedbackStore = new PgFeedbackStore(pool);
  const proposalStore = new PgProposalStore(pool);
  const feedbackProcessor = new FeedbackProcessor(feedbackStore);
  const aliasChecker = buildPgAliasChecker(pool);
  const aliasProposer = new AliasProposer(proposalStore, aliasChecker);

  return {
    feedbackStore,
    proposalStore,
    feedbackProcessor,
    aliasProposer,
  };
}
