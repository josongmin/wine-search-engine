import type { Pool } from 'pg';
import { FeedbackTTLEnforcer } from '../domain/learning/service/feedback-ttl-enforcer.js';
import { FeedbackProcessor } from '../domain/learning/service/feedback-processor.js';
import { AliasProposer } from '../domain/learning/service/alias-proposer.js';
import type { ExistingAliasChecker } from '../domain/learning/service/alias-proposer.js';
import { PromotionGate } from '../domain/learning/service/promotion-gate.js';
import type { AdversarialGuardPort } from '../domain/learning/service/promotion-gate.js';
import { AdversarialGuard, deconfuse } from '../domain/alias/service/adversarial-guard.js';
import { PgAliasRepository } from '../infrastructure/adapter/pg-alias-repository.js';
import type { AliasRepository } from '../domain/alias/port/alias-repository.port.js';
import { PgFeedbackStore } from '../infrastructure/adapter/pg-feedback-store.js';
import { PgProposalStore } from '../infrastructure/adapter/pg-proposal-store.js';
import type { FeedbackStore } from '../domain/learning/port/feedback-store.port.js';
import type { ProposalStore } from '../domain/learning/port/proposal-store.port.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { resolveActiveSnapshot } from '../infrastructure/db/active-snapshot-resolver.js';
import { readPgSqlState } from '../infrastructure/db/pg-sqlstate.js';
import { globalSilentSkipCounter } from '../observability/silent-skip-counters.js';

export interface LearningContainerServices {
  readonly feedbackStore: FeedbackStore | null;
  readonly proposalStore: ProposalStore | null;
  readonly feedbackProcessor: FeedbackProcessor | null;
  readonly aliasProposer: AliasProposer | null;
  /** RFC-010 §8 retention policy; requires Postgres feedback store. */
  readonly feedbackTtlEnforcer: FeedbackTTLEnforcer | null;
  /** E5-U3: Single gate for all model/weight promotion decisions (RFC-010 §9). */
  readonly promotionGate: PromotionGate | null;
}

function buildPgAliasChecker(pool: Pool): ExistingAliasChecker {
  return {
    async aliasExists(surfaceForm: string): Promise<boolean> {
      try {
        const { activeSnapshotId } = await resolveActiveSnapshot(pool);
        const result = await pool.query(
          `SELECT 1 FROM aliases
           WHERE surface_form = $1
             AND search_snapshot_id = $2
             AND is_suppressed = FALSE
           LIMIT 1`,
          [surfaceForm, activeSnapshotId],
        );
        return (result.rowCount ?? 0) > 0;
      } catch (err: unknown) {
        if (readPgSqlState(err) === '42P01') {
          // Snapshot pointer or aliases table missing (fresh DB, pre-publish).
          // Learning-side alias existence check is advisory — degrade cleanly
          // rather than fail the request.
          globalSilentSkipCounter.increment(
            'alias_checker_disabled_snapshot_pointer_missing',
            { surface: 'container-learning.buildPgAliasChecker' },
          );
          return false;
        }
        throw err;
      }
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
      feedbackTtlEnforcer: null,
      promotionGate: null,
    };
  }

  const feedbackStore = new PgFeedbackStore(pool);
  const proposalStore = new PgProposalStore(pool);
  const feedbackProcessor = new FeedbackProcessor(feedbackStore);
  const feedbackTtlEnforcer = new FeedbackTTLEnforcer(feedbackStore);
  const aliasChecker = buildPgAliasChecker(pool);
  const aliasProposer = new AliasProposer(proposalStore, aliasChecker);

  const aliasAdversarialGuard = new AdversarialGuard();
  const aliasRepository: AliasRepository = new PgAliasRepository(pool);
  const adversarialGuardPort: AdversarialGuardPort = {
    async isAdversarial(surfaceForm: string): Promise<boolean> {
      // Targeted lookup: resolve the deconfused form so homoglyph collisions are
      // detected against real aliases in the database.  We look up by the
      // deconfused (ASCII-normalised) surface form; any alias whose stored value
      // matches that form would visually impersonate it via homoglyphs.
      const deconfusedForm = deconfuse(surfaceForm).toLowerCase();
      // NOTE: This lookup assumes aliases were indexed with normalizedValue = deconfuse(value).toLowerCase().
      // If the ingestion pipeline uses a different normalization, findByNormalizedValue may return []
      // and the homoglyph check will silently pass. Keep deconfuse() and ingestion normalization in sync.
      const existingAliases = await aliasRepository.findByNormalizedValue(deconfusedForm);
      const result = aliasAdversarialGuard.checkHomoglyph(surfaceForm, existingAliases);
      return !result.passed;
    },
  };
  const promotionGate = new PromotionGate(proposalStore, adversarialGuardPort);

  return {
    feedbackStore,
    proposalStore,
    feedbackProcessor,
    aliasProposer,
    feedbackTtlEnforcer,
    promotionGate,
  };
}
