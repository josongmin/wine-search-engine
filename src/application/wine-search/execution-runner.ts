/**
 * ExecutionRunner — executes a typed `ExecutionPlan` against injected use
 * cases.
 *
 * The runner is the only Plan-then-Execute component that talks to use
 * cases. It owns:
 *  - per-step timeout (Promise.race + AbortController),
 *  - abort propagation (caller's `abortSignal` chained to a local
 *    controller so timeouts can selectively cancel a single leg),
 *  - parallel fan-out for `parallel-search` and `search-then-drinkability`
 *    (Promise.all with shared abort),
 *  - structured logging tagged with `requestId` + `planKind`,
 *  - mapping of caller errors into the `ExecutionOutcome` discriminated
 *    union (rejected / error / multi-step-required).
 *
 * The runner does **not** know about wire formats (HTTP, gRPC), use-case
 * deps wiring, or planning. It accepts ports — caller-side adapters wire
 * them to real `SearchUseCase` / `DecomposedSearchUseCase` /
 * `DrinkingWindowUseCase` instances. This is the same DI seam used
 * throughout the application layer.
 *
 * NOTE: the runner reuses `withTimeout` from
 * `agent-tool-execution-support.ts` (SSoT — CLAUDE.md rule 30). Do not
 * duplicate the timeout race here.
 */

import { bootstrapLogger } from '@shared/bootstrap-logger.js';
import { abortError, isAbortError, throwIfAborted } from '@shared/cooperative-abort.js';
import type { ComparisonSearchResponse } from '@domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '@domain/response/model/result-item.js';
import type { SearchResponseV1 } from '@domain/response/model/search-response.js';
import { withTimeout } from '../agent/agent-tool-execution-support.js';
import type {
  ComparisonUseCaseInput,
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

export interface ComparisonUseCasePort {
  execute(
    input: ComparisonUseCaseInput,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<ComparisonSearchResponse>;
}

export interface DrinkabilityProbe {
  readonly entityId: string;
  readonly targetYear: number;
  readonly window: DrinkingWindowBlock;
}

export interface DrinkabilityUseCasePort {
  /** Probe a single entity (from the search result set) for drinkability.
   *  Returns `undefined` when the entity carries no drinkability
   *  projection. The runner fans these out in parallel. */
  probe(
    entityId: string,
    targetYear: number,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<DrinkabilityProbe | undefined>;
}

// ---------------------------------------------------------------------------
// Outcome — discriminated union
// ---------------------------------------------------------------------------

export type ExecutionOutcome =
  | { readonly kind: 'search-result'; readonly result: SearchResponseV1 }
  | { readonly kind: 'comparison-result'; readonly result: ComparisonSearchResponse }
  | { readonly kind: 'parallel-results'; readonly results: readonly SearchResponseV1[] }
  | {
    readonly kind: 'search-then-drinkability';
    readonly search: SearchResponseV1;
    readonly drinkability: readonly DrinkabilityProbe[];
  }
  | { readonly kind: 'multi-step-required'; readonly handoff: MultiStepHandoff }
  | { readonly kind: 'rejected'; readonly reason: PlanRejectReason }
  | { readonly kind: 'error'; readonly cause: Error };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ExecutionRunnerDeps {
  readonly searchUseCase: SearchUseCasePort;
  readonly comparisonUseCase?: ComparisonUseCasePort | undefined;
  readonly drinkabilityUseCase?: DrinkabilityUseCasePort | undefined;
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

      // F-FailClosed: when the operator has disabled the tool that this
      // plan-kind depends on, fall back to a single-search degradation
      // (when possible) or a 'rejected' outcome. The disabled set is
      // sourced once per process at module load — same env var the
      // mini-loop dispatcher reads.
      if (planRequiresDisabledTool(plan)) {
        bootstrapLogger.warn(
          { ...logCtx, planKind: plan.kind },
          '[ExecutionRunner] plan requires a disabled tool — degrading via single-search fallback or rejecting',
        );
        const degraded = degradeDisabledPlan(plan);
        if (degraded !== null) {
          return await this.runSingleSearch(degraded, ctx, perStepTimeoutMs, logCtx);
        }
        return { kind: 'rejected', reason: 'tool_unavailable' };
      }

      // Exhaustive switch on `plan.kind` — discriminated against the SSoT
      // `ExecutionPlanKind` (CLAUDE.md rule 30, `execution-plan-schemas.ts`).
      // The `default: never` assertion fails at `tsc` if a new plan kind is
      // added to the SSoT tuple but not handled here.
      switch (plan.kind) {
        case 'single-search':
          return await this.runSingleSearch(plan.searchInput, ctx, perStepTimeoutMs, logCtx);
        case 'parallel-search':
          return await this.runParallelSearch(plan.searches, ctx, perStepTimeoutMs, logCtx);
        case 'comparison':
          return await this.runComparison(plan.comparisonInput, ctx, perStepTimeoutMs, logCtx);
        case 'search-then-drinkability':
          return await this.runSearchThenDrinkability(
            plan.searchInput,
            plan.drinkabilityTemplate.targetYear,
            plan.drinkabilityTemplate.maxAnchors,
            ctx,
            perStepTimeoutMs,
            logCtx,
          );
        case 'multi-step':
          bootstrapLogger.info(logCtx, '[ExecutionRunner] handoff to MiniLoop');
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

  private async runComparison(
    input: ComparisonUseCaseInput,
    ctx: ExecutionRunnerContext,
    perStepTimeoutMs: number,
    logCtx: { readonly requestId: string; readonly planKind: ExecutionPlan['kind'] },
  ): Promise<ExecutionOutcome> {
    if (this.deps.comparisonUseCase === undefined) {
      throw new Error('comparisonUseCase port not wired');
    }
    const comparisonUseCase = this.deps.comparisonUseCase;
    const result = await this.runWithStepTimeout(
      (signal) => comparisonUseCase.execute(input, ctx.requestId, { abortSignal: signal }),
      ctx,
      perStepTimeoutMs,
      'comparison',
    );
    bootstrapLogger.info(logCtx, '[ExecutionRunner] comparison done');
    return { kind: 'comparison-result', result };
  }

  private async runSearchThenDrinkability(
    searchInput: SearchUseCaseInput,
    targetYear: number,
    maxAnchors: number,
    ctx: ExecutionRunnerContext,
    perStepTimeoutMs: number,
    logCtx: { readonly requestId: string; readonly planKind: ExecutionPlan['kind'] },
  ): Promise<ExecutionOutcome> {
    const search = await this.runWithStepTimeout(
      (signal) => this.deps.searchUseCase.execute(searchInput, ctx.requestId, { abortSignal: signal }),
      ctx,
      perStepTimeoutMs,
      'search-leg',
    );
    throwIfAborted(ctx.abortSignal, 'Execution runner aborted before drinkability fan-out');

    if (this.deps.drinkabilityUseCase === undefined) {
      bootstrapLogger.warn(
        logCtx,
        '[ExecutionRunner] drinkabilityUseCase port not wired — returning search only',
      );
      return {
        kind: 'search-then-drinkability',
        search,
        drinkability: [],
      };
    }

    const drinkability = await this.fanOutDrinkability(
      search,
      targetYear,
      maxAnchors,
      ctx,
      perStepTimeoutMs,
    );
    bootstrapLogger.info(
      { ...logCtx, drinkabilityCount: drinkability.length },
      '[ExecutionRunner] search-then-drinkability done',
    );
    return { kind: 'search-then-drinkability', search, drinkability };
  }

  private async fanOutDrinkability(
    search: SearchResponseV1,
    targetYear: number,
    maxAnchors: number,
    ctx: ExecutionRunnerContext,
    perStepTimeoutMs: number,
  ): Promise<readonly DrinkabilityProbe[]> {
    if (this.deps.drinkabilityUseCase === undefined) {
      return [];
    }
    const drinkabilityUseCase = this.deps.drinkabilityUseCase;
    const probes = search.results.slice(0, maxAnchors).map((r, idx) =>
      this.runWithStepTimeout(
        (signal) => drinkabilityUseCase.probe(r.entity.entityId, targetYear, `${ctx.requestId}-dw${idx}`, { abortSignal: signal }),
        ctx,
        perStepTimeoutMs,
        `drinkability[${idx}]`,
      ),
    );
    const settled = await Promise.all(probes);
    return settled.filter((p): p is DrinkabilityProbe => p !== undefined);
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

// ---------------------------------------------------------------------------
// F-FailClosed helpers — env-gated, module-scope.
// ---------------------------------------------------------------------------

/** Env-gated disabled-tools set, read once per process. Mirrors mini-loop. */
const RUNNER_DISABLED_TOOLS: ReadonlySet<string> = new Set(
  (process.env['WINE_SEARCH_DISABLED_TOOLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

/** Plan-kind → underlying tool the disabled-set should consult. */
function planRequiresDisabledTool(plan: ExecutionPlan): boolean {
  if (RUNNER_DISABLED_TOOLS.size === 0) return false;
  switch (plan.kind) {
    case 'comparison':
      return RUNNER_DISABLED_TOOLS.has('compare_wines');
    case 'search-then-drinkability':
      return RUNNER_DISABLED_TOOLS.has('check_drinking_window');
    default:
      return false;
  }
}

/**
 * For plan kinds whose dependency is disabled, emit a degraded
 * `single-search` plan that still has a chance of producing a useful
 * answer (the user's query intent is captured in the underlying
 * `searchInput`). Returns `null` for `comparison`, where there is no
 * single search query to fall back to — the orchestrator must surface
 * the `tool_unavailable` reject directly.
 */
function degradeDisabledPlan(plan: ExecutionPlan): SearchUseCaseInput | null {
  switch (plan.kind) {
    case 'search-then-drinkability':
      return plan.searchInput;
    case 'comparison':
      return null;
    default:
      return null;
  }
}
