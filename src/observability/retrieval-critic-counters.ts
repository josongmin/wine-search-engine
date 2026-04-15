/**
 * ADR-015 Axis 2: retrieval-critic telemetry counters.
 *
 * Kept separate from `silent-skip-counters.ts` because critic signals are
 * authored intent — they mark decisions the critic made, not silent
 * skips. The shape mirrors `bundle-selector-counters.ts` for operator
 * familiarity.
 *
 * Named counters (exported for tests / audit grep):
 *   - RETRIEVAL_CRITIC_RETRY_COUNT
 *     Total retry iterations the executor performed (sum across requests).
 *   - RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT
 *     The executor hit `CRITIC_RETRY_MAX` without achieving coverage —
 *     the handoff to the ranker carried `critic_retries_exhausted` as a
 *     degradation reason. Alertable in ops.
 *   - RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT
 *   - RETRIEVAL_CRITIC_REWRITE_DECOMPOSE_COUNT
 *   - RETRIEVAL_CRITIC_REWRITE_EXPAND_SYNONYM_COUNT
 *   - RETRIEVAL_CRITIC_REWRITE_REFORMULATE_COUNT
 *     Per-rewrite-type counters — useful for verifying the critic's
 *     decision table preference for deterministic branches over the
 *     LLM-backed `reformulate` branch in production traffic.
 */

export type RetrievalCriticCounterKind =
  | 'RETRIEVAL_CRITIC_RETRY_COUNT'
  | 'RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT'
  | 'RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT'
  | 'RETRIEVAL_CRITIC_REWRITE_DECOMPOSE_COUNT'
  | 'RETRIEVAL_CRITIC_REWRITE_EXPAND_SYNONYM_COUNT'
  | 'RETRIEVAL_CRITIC_REWRITE_REFORMULATE_COUNT';

const COUNTER_KINDS: readonly RetrievalCriticCounterKind[] = [
  'RETRIEVAL_CRITIC_RETRY_COUNT',
  'RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT',
  'RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT',
  'RETRIEVAL_CRITIC_REWRITE_DECOMPOSE_COUNT',
  'RETRIEVAL_CRITIC_REWRITE_EXPAND_SYNONYM_COUNT',
  'RETRIEVAL_CRITIC_REWRITE_REFORMULATE_COUNT',
] as const;

export type CriticRewriteTypeForCounter =
  | 'relax'
  | 'decompose'
  | 'expand_synonym'
  | 'reformulate';

const REWRITE_TYPE_TO_COUNTER: Readonly<
  Record<CriticRewriteTypeForCounter, RetrievalCriticCounterKind>
> = {
  relax: 'RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT',
  decompose: 'RETRIEVAL_CRITIC_REWRITE_DECOMPOSE_COUNT',
  expand_synonym: 'RETRIEVAL_CRITIC_REWRITE_EXPAND_SYNONYM_COUNT',
  reformulate: 'RETRIEVAL_CRITIC_REWRITE_REFORMULATE_COUNT',
};

export interface RetrievalCriticCounter {
  increment(kind: RetrievalCriticCounterKind): void;
  incrementRewrite(rewriteType: CriticRewriteTypeForCounter): void;
  incrementRetriesExhausted(): void;
  snapshot(): Readonly<Record<RetrievalCriticCounterKind, number>>;
  reset(): void;
}

function createZeroedCounts(): Record<RetrievalCriticCounterKind, number> {
  const out = {} as Record<RetrievalCriticCounterKind, number>;
  for (const k of COUNTER_KINDS) out[k] = 0;
  return out;
}

export function createRetrievalCriticCounter(): RetrievalCriticCounter {
  const counts = new Map<RetrievalCriticCounterKind, number>(
    COUNTER_KINDS.map((k) => [k, 0] as const),
  );
  return {
    increment(kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    },
    incrementRewrite(rewriteType) {
      // Every concrete rewrite is also a retry iteration.
      counts.set(
        'RETRIEVAL_CRITIC_RETRY_COUNT',
        (counts.get('RETRIEVAL_CRITIC_RETRY_COUNT') ?? 0) + 1,
      );
      const kind = REWRITE_TYPE_TO_COUNTER[rewriteType];
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    },
    incrementRetriesExhausted() {
      counts.set(
        'RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT',
        (counts.get('RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT') ?? 0) + 1,
      );
    },
    snapshot() {
      const out = createZeroedCounts();
      for (const k of COUNTER_KINDS) out[k] = counts.get(k) ?? 0;
      return Object.freeze(out);
    },
    reset() {
      for (const k of COUNTER_KINDS) counts.set(k, 0);
    },
  };
}

/**
 * Process-wide shared instance. Tests may call `reset()` in `beforeEach`.
 */
export const globalRetrievalCriticCounter: RetrievalCriticCounter =
  createRetrievalCriticCounter();
