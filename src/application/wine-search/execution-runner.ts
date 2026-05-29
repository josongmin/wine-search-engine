/**
 * ExecutionRunner — executes a typed `ExecutionPlan` against injected use
 * cases.
 *
 * The runner is the only Plan-then-Execute component that talks to use
 * cases. It owns:
 *  - per-step timeout (Promise.race + AbortController),
 *  - abort propagation (caller's `abortSignal` chained to a local
 *    controller so timeouts can selectively cancel a single leg),
 *  - parallel fan-out for `parallel-search` (Promise.all with shared abort),
 *  - structured logging tagged with `requestId` + `planKind`,
 *  - mapping of caller errors into the `ExecutionOutcome` discriminated
 *    union (rejected / error / multi-step-required).
 *
 * The runner does **not** know about wire formats (HTTP, gRPC), use-case
 * deps wiring, or planning. It accepts ports — caller-side adapters wire
 * them to real `SearchUseCase` / `DecomposedSearchUseCase` instances.
 * This is the same DI seam used
 * throughout the application layer.
 *
 * NOTE: the runner reuses `withTimeout` from
 * `agent-tool-execution-support.ts` (SSoT — CLAUDE.md rule 30). Do not
 * duplicate the timeout race here.
 */

import { bootstrapLogger } from '@shared/bootstrap-logger.js';
import { abortError, isAbortError, throwIfAborted } from '@shared/cooperative-abort.js';
import type { SearchResponseV1 } from '@domain/response/model/search-response.js';
import { withTimeout } from '../agent/agent-tool-execution-support.js';
import type {
  ExecutionPlan,
  MultiStepHandoff,
  PlanRejectReason,
  SearchUseCaseInput,
} from './execution-plan-schemas.js';
import { DETERMINISTIC_ROUTER_DEFAULT_PER_STEP_TIMEOUT_MS } from './execution-plan-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Soft upper bound on per-step timeout. The plan schema validates against
 *  `DETERMINISTIC_ROUTER_MAX_PER_STEP_TIMEOUT_MS`; this is a runtime guard
 *  in case the caller bypasses the schema. */
const RUNNER_MAX_PER_STEP_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Ports — caller-side adapters wire these to use cases. We keep them in
// the runner module (not in /port) because they are runner-local types,
// shaped by what the runner needs, not what use cases expose.
// ---------------------------------------------------------------------------

export interface SearchUseCasePort {
  execute(
    input: SearchUseCaseInput,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<SearchResponseV1>;
}

// ---------------------------------------------------------------------------
// Outcome — discriminated union
// ---------------------------------------------------------------------------

export type ExecutionOutcome =
  | { readonly kind: 'search-result'; readonly result: SearchResponseV1 }
  | { readonly kind: 'parallel-results'; readonly results: readonly SearchResponseV1[] }
  | { readonly kind: 'multi-step-required'; readonly handoff: MultiStepHandoff }
  | { readonly kind: 'rejected'; readonly reason: PlanRejectReason }
  | { readonly kind: 'error'; readonly cause: Error };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ExecutionRunnerDeps {
  readonly searchUseCase: SearchUseCasePort;
}

interface ExecutionRunnerContext {
  readonly requestId: string;
  readonly abortSignal?: AbortSignal | undefined;
  /** Per-step timeout. Bounded at construction to keep a runaway plan from
   *  pinning a worker. Defaults to `DETERMINISTIC_ROUTER_DEFAULT_PER_STEP_TIMEOUT_MS`. */
  readonly perStepTimeoutMs: number;
}

export class ExecutionRunner {
  constructor(private readonly deps: ExecutionRunnerDeps) {}

  async run(
    plan: ExecutionPlan,
    ctx: ExecutionRunnerContext,
  ): Promise<ExecutionOutcome> {
    const perStepTimeoutMs = this.resolvePerStepTimeoutMs(ctx.perStepTimeoutMs);
    const logCtx = { requestId: ctx.requestId, planKind: plan.kind };

    try {
      throwIfAborted(ctx.abortSignal, 'Execution runner aborted before start');

      // Exhaustive switch on `plan.kind` — discriminated against the SSoT
      // `ExecutionPlanKind` (CLAUDE.md rule 30, `execution-plan-schemas.ts`).
      // The `default: never` assertion fails at `tsc` if a new plan kind is
      // added to the SSoT tuple but not handled here.
      switch (plan.kind) {
        case 'single-search':
          return await this.runSingleSearch(plan.searchInput, ctx, perStepTimeoutMs, logCtx);
        case 'parallel-search':
          return await this.runParallelSearch(plan.searches, ctx, perStepTimeoutMs, logCtx);
        case 'multi-step':
          bootstrapLogger.info(logCtx, '[ExecutionRunner] handoff to WineAgentLoop');
          return { kind: 'multi-step-required', handoff: plan.handoff };
        case 'reject':
          bootstrapLogger.info({ ...logCtx, reason: plan.reason }, '[ExecutionRunner] plan rejected');
          return { kind: 'rejected', reason: plan.reason };
        default: {
          const _exhaustive: never = plan;
          throw new Error(`ExecutionRunner: unhandled plan kind in dispatch switch: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const errKind = isAbortError(err) ? 'aborted' : 'error';
      bootstrapLogger.warn(
        { ...logCtx, err: cause.message, errKind },
        '[ExecutionRunner] plan execution failed',
      );
      return { kind: 'error', cause };
    }
  }

  // -------------------------------------------------------------------------
  // Plan-kind branches
  // -------------------------------------------------------------------------

  private async runSingleSearch(
    input: SearchUseCaseInput,
    ctx: ExecutionRunnerContext,
    perStepTimeoutMs: number,
    logCtx: { readonly requestId: string; readonly planKind: ExecutionPlan['kind'] },
  ): Promise<ExecutionOutcome> {
    const result = await this.runWithStepTimeout(
      (signal) => this.deps.searchUseCase.execute(input, ctx.requestId, { abortSignal: signal }),
      ctx,
      perStepTimeoutMs,
      'search',
    );
    bootstrapLogger.info(logCtx, '[ExecutionRunner] single-search done');
    return { kind: 'search-result', result };
  }

  private async runParallelSearch(
    searches: readonly SearchUseCaseInput[],
    ctx: ExecutionRunnerContext,
    perStepTimeoutMs: number,
    logCtx: { readonly requestId: string; readonly planKind: ExecutionPlan['kind'] },
  ): Promise<ExecutionOutcome> {
    const results = await Promise.all(
      searches.map((input, idx) =>
        this.runWithStepTimeout(
          (signal) => this.deps.searchUseCase.execute(input, `${ctx.requestId}-p${idx}`, { abortSignal: signal }),
          ctx,
          perStepTimeoutMs,
          `parallel-search[${idx}]`,
        ),
      ),
    );
    bootstrapLogger.info(
      { ...logCtx, slots: results.length },
      '[ExecutionRunner] parallel-search done',
    );
    return { kind: 'parallel-results', results };
  }

  // -------------------------------------------------------------------------
  // Per-step timeout / abort propagation
  //
  // We construct a per-step AbortController that:
  //   - listens to the caller's outer signal (so caller cancel cascades),
  //   - is aborted by `withTimeout` if the step exceeds its budget.
  // The work function receives the local signal so the use case can
  // cooperatively cancel.
  // -------------------------------------------------------------------------

  private async runWithStepTimeout<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ctx: ExecutionRunnerContext,
    timeoutMs: number,
    stepLabel: string,
  ): Promise<T> {
    const local = new AbortController();
    const outerSignal = ctx.abortSignal;
    let cleanupListener: (() => void) | undefined;

    if (outerSignal !== undefined) {
      const onAbort = (): void => {
        local.abort(abortError(`Execution runner step "${stepLabel}" aborted by caller`));
      };
      if (outerSignal.aborted) {
        onAbort();
      } else {
        outerSignal.addEventListener('abort', onAbort);
        cleanupListener = (): void => { outerSignal.removeEventListener('abort', onAbort); };
      }
    }

    try {
      return await withTimeout(
        work(local.signal),
        timeoutMs,
        `Execution runner step "${stepLabel}" timed out after ${timeoutMs}ms`,
      );
    } finally {
      cleanupListener?.();
    }
  }

  private resolvePerStepTimeoutMs(input: number): number {
    if (!Number.isFinite(input) || input <= 0) {
      return DETERMINISTIC_ROUTER_DEFAULT_PER_STEP_TIMEOUT_MS;
    }
    if (input > RUNNER_MAX_PER_STEP_TIMEOUT_MS) {
      return RUNNER_MAX_PER_STEP_TIMEOUT_MS;
    }
    return Math.floor(input);
  }
}

