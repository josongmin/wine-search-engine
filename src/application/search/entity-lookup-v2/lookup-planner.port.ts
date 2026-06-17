import type { AmbiguityInfo } from '../../../domain/query/port/ambiguity-dictionary.port.js';
import type { AnchorCandidate } from '../../../domain/query/model/anchor-candidate.js';
import type { NormalizedQueryViews } from '../../../domain/query/model/query-views.js';
import type { StageTimer } from '../../../domain/shared/stage-timer.js';
import type { LookupQueryPlan } from './lookup-query-plan.js';

export interface LookupPlannerContext {
  readonly abortSignal?: AbortSignal | undefined;
  readonly stageTimer?: StageTimer | undefined;
  /** Pre-normalized views from the use-case front door (avoids duplicate fanout). */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;
  /** Anchors from timed multi-channel retrieval — skips AnchorExtractor recall. */
  readonly prefetchedAnchors?: readonly AnchorCandidate[] | undefined;
  /** Pre-fetched persisted ambiguity — skips a second dictionary round-trip. */
  readonly persistedAmbiguity?: AmbiguityInfo | null | undefined;
  /** When true, only exact-safe / persisted-ambiguity exits are evaluated. */
  readonly earlyExitOnly?: boolean | undefined;
}

export interface LookupPlannerPort {
  plan(query: string, context?: LookupPlannerContext): Promise<LookupQueryPlan>;
}
