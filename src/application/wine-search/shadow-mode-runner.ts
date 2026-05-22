/**
 * ShadowModeRunner — executes the legacy `AgentOrchestrator` and the new
 * `WineSearchOrchestrator` against the same query in parallel, then emits a
 * structured diff report.
 *
 * Invariants:
 *  1. Both orchestrators are launched via `Promise.allSettled` — neither
 *     blocks the other (the runner total wall-time is `max(legacy, wineSearch)
 *     + overhead`, NOT the sum).
 *  2. Each side gets its own child `AbortController` derived from the optional
 *     caller signal. A timeout on one side fires *only* its own controller,
 *     leaving the other free to complete.
 *  3. Each side is wrapped with a deterministic timeout. The timer is cleared
 *     in `finally` so the test process can exit cleanly.
 *  4. The runner is PURE orchestration — it has no side effects beyond
 *     calling the injected orchestrators and the injected clock. JSONL
 *     persistence happens in the CLI script, not here.
 *  5. The clock is injected (`deps.clock.now`) so tests can pin time.
 *  6. The Zod schema (`ShadowModeReportSchema`) is parsed before return —
 *     a report-shape violation is a runner bug, not a user issue.
 *  7. No `as DomainType` casts on external data. All branches that ingest
 *     `AgentResult` / `WineSearchResult` field values flow through a single
 *     adapter (`toLegacyOutcome` / `toWineSearchOutcome`) that performs
 *     defensive runtime narrowing.
 */

import { randomUUID } from 'node:crypto';
import type { AgentResult } from '@domain/agent/model/agent-result.js';
import type { AgentStep, AgentToolCall } from '@domain/agent/model/agent-step.js';
import type { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import {
  ShadowModeReportSchema,
  SHADOW_MODE_DEFAULT_TIMEOUT_MS,
  SHADOW_MODE_ANSWER_PREVIEW_CHARS,
  SHADOW_MODE_MAX_ANSWER_CHARS,
  SHADOW_MODE_MAX_ERROR_MESSAGE_CHARS,
  SHADOW_MODE_MAX_TOOL_NAMES,
  SHADOW_MODE_OBSERVATION_MAX_CHARS,
  SHADOW_MODE_OBSERVATIONS_MAX,
  type ShadowModeOrchestratorOutcome,
  type ShadowModeOrchestratorStatus,
  type ShadowModeReport,
} from './shadow-mode-schemas.js';
import { computeShadowModeDiff } from './shadow-mode-diff.js';
import type { WineSearchResult } from './wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Minimum admissible per-side timeout (ms). 1 second floor protects callers
 *  from passing pathological 0/negative values that would race the LLM call. */
const SHADOW_MODE_MIN_TIMEOUT_MS = 1_000;

/** Truncation suffix on long error messages (kept inline in the report). */
const ERROR_MESSAGE_TRUNCATION_TAIL = '…';

/** String tag used when no termination reason can be inferred from an error
 *  result (legacy and new orchestrators both raise structured errors so this
 *  is only reached on truly unexpected throws). */
const TERMINATION_REASON_UNKNOWN = 'error';

/** Empty token-usage shape — used when an orchestrator never completed. */
const ZERO_TOKEN_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 });

// ---------------------------------------------------------------------------
// Structural contract for WineSearchOrchestrator
// ---------------------------------------------------------------------------

/**
 * Structural type for the new orchestrator. We do NOT import the concrete
 * class because Track A has landed the result schema but not yet the
 * orchestrator class itself — we write against the contract so the runner is
 * ready the moment Track A ships. Any class with this `execute()` shape is
 * accepted.
 */
export interface WineSearchOrchestratorLike {
  execute(input: {
    readonly query: string;
    readonly requestId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<WineSearchResult>;
}

// ---------------------------------------------------------------------------
// Logger contract — narrow Pick of pino interface so tests do not need pino.
// ---------------------------------------------------------------------------

export interface ShadowModeLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: ShadowModeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface ShadowModeClock {
  readonly now: () => number;
}

const wallClock: ShadowModeClock = {
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ShadowModeRunnerDeps {
  readonly legacyOrchestrator: AgentOrchestrator;
  readonly wineSearchOrchestrator: WineSearchOrchestratorLike;
  readonly logger?: ShadowModeLogger;
  readonly clock?: ShadowModeClock;
}

interface ShadowModeRunOnceInput {
  readonly query: string;
  readonly requestId: string;
  readonly scenarioId?: string;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * Internal envelope returned by the per-side runners. Wraps the orchestrator
 * result with status + duration so the outer differ does not need to know
 * how each side reports timeout / abort.
 */
interface PerSideEnvelope<T> {
  readonly status: ShadowModeOrchestratorStatus;
  readonly result?: T;
  readonly errorMessage?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export class ShadowModeRunner {
  private readonly logger: ShadowModeLogger;
  private readonly clock: ShadowModeClock;

  constructor(private readonly deps: ShadowModeRunnerDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.clock = deps.clock ?? wallClock;
  }

  async runOnce(input: ShadowModeRunOnceInput): Promise<ShadowModeReport> {
    const timeoutMs = Math.max(
      SHADOW_MODE_MIN_TIMEOUT_MS,
      input.timeoutMs ?? SHADOW_MODE_DEFAULT_TIMEOUT_MS,
    );

    // Each side gets its own controller. Caller signal aborts both.
    const legacyController = new AbortController();
    const wineSearchController = new AbortController();
    const onCallerAbort = (): void => {
      legacyController.abort();
      wineSearchController.abort();
    };
    if (input.abortSignal !== undefined) {
      if (input.abortSignal.aborted) {
        onCallerAbort();
      } else {
        input.abortSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    try {
      const [legacyEnvelope, wineSearchEnvelope] = await Promise.all([
        this.runLegacy(input, legacyController, timeoutMs),
        this.runWineSearch(input, wineSearchController, timeoutMs),
      ]);

      const legacyOutcome = toLegacyOutcome(legacyEnvelope);
      const wineSearchOutcome = toWineSearchOutcome(wineSearchEnvelope);
      const diff = computeShadowModeDiff(legacyOutcome, wineSearchOutcome);

      const reportInput: Record<string, unknown> = {
        requestId: input.requestId,
        query: input.query,
        queryPreview: previewString(input.query, SHADOW_MODE_ANSWER_PREVIEW_CHARS),
        legacy: legacyOutcome,
        wineSearch: wineSearchOutcome,
        diff,
      };
      if (input.scenarioId !== undefined) {
        reportInput['scenarioId'] = input.scenarioId;
      }

      const parsed = ShadowModeReportSchema.safeParse(reportInput);
      if (!parsed.success) {
        // This is a contract violation in the runner itself — log and throw.
        this.logger.error(
          {
            component: 'ShadowModeRunner',
            requestId: input.requestId,
            issues: parsed.error.issues.slice(0, 3).map((iss) => ({
              path: iss.path.join('.'),
              message: iss.message,
            })),
          },
          'shadow-mode report failed schema validation',
        );
        throw new Error(
          `[shadow-mode-runner] internal contract violation: ${parsed.error.issues
            .slice(0, 3)
            .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
            .join('; ')}`,
        );
      }

      if (diff.divergent) {
        this.logger.warn(
          {
            component: 'ShadowModeRunner',
            requestId: input.requestId,
            reasons: diff.divergentReasons,
            similarity: diff.answerSimilarity,
          },
          'shadow-mode divergence detected',
        );
      } else {
        this.logger.info(
          {
            component: 'ShadowModeRunner',
            requestId: input.requestId,
            similarity: diff.answerSimilarity,
            durationDeltaMs: diff.durationDeltaMs,
          },
          'shadow-mode parity confirmed',
        );
      }

      return parsed.data;
    } finally {
      if (input.abortSignal !== undefined) {
        input.abortSignal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-side runners
  // -------------------------------------------------------------------------

  private async runLegacy(
    input: ShadowModeRunOnceInput,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<PerSideEnvelope<AgentResult>> {
    const startedAt = this.clock.now();
    // `timeoutState.timedOut` is mutated by an async setTimeout callback —
    // boxing it in an object prevents TS from narrowing the variable away in
    // the catch block (it cannot see the async mutation).
    const timeoutState: { timedOut: boolean } = { timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<AgentResult>((resolve, reject) => {
        timer = setTimeout(() => {
          timeoutState.timedOut = true;
          controller.abort();
          reject(new ShadowModeTimeoutError('legacy_agent timed out'));
        }, timeoutMs);
        this.deps.legacyOrchestrator
          .execute(input.query, input.requestId, undefined, controller.signal)
          .then(resolve)
          .catch(reject);
      });
      return {
        status: 'ok',
        result,
        startedAt,
        finishedAt: this.clock.now(),
      };
    } catch (err) {
      return this.classifyPerSideError(err, timeoutState, controller, startedAt);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async runWineSearch(
    input: ShadowModeRunOnceInput,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<PerSideEnvelope<WineSearchResult>> {
    const startedAt = this.clock.now();
    const timeoutState: { timedOut: boolean } = { timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<WineSearchResult>((resolve, reject) => {
        timer = setTimeout(() => {
          timeoutState.timedOut = true;
          controller.abort();
          reject(new ShadowModeTimeoutError('wine_search timed out'));
        }, timeoutMs);
        this.deps.wineSearchOrchestrator
          .execute({
            query: input.query,
            requestId: input.requestId,
            abortSignal: controller.signal,
          })
          .then(resolve)
          .catch(reject);
      });
      return {
        status: 'ok',
        result,
        startedAt,
        finishedAt: this.clock.now(),
      };
    } catch (err) {
      return this.classifyPerSideError(err, timeoutState, controller, startedAt);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Classify a per-side error into a {@link PerSideEnvelope} of the right
   * status. Shared between the legacy and wine-search runners so the timeout
   * / abort / error decision tree lives in one place.
   */
  private classifyPerSideError<T>(
    err: unknown,
    timeoutState: { timedOut: boolean },
    controller: AbortController,
    startedAt: number,
  ): PerSideEnvelope<T> {
    const finishedAt = this.clock.now();
    if (timeoutState.timedOut) {
      return { status: 'timeout', startedAt, finishedAt, errorMessage: 'timeout' };
    }
    if (controller.signal.aborted) {
      return {
        status: 'aborted',
        startedAt,
        finishedAt,
        errorMessage: 'aborted',
      };
    }
    return {
      status: 'error',
      startedAt,
      finishedAt,
      errorMessage: extractErrorMessage(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-scoped; exported only where tests need them).
// ---------------------------------------------------------------------------

/**
 * Sentinel error class so the per-side runners can distinguish a real
 * orchestrator error from our own timeout race.
 */
class ShadowModeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowModeTimeoutError';
  }
}

/**
 * Generate a request id suitable for tests / CLI scripts. Wraps
 * `crypto.randomUUID()` (CLAUDE.md schema-quality bar: no `Math.random()` for
 * id generation).
 */
export function generateShadowModeRequestId(): string {
  return `shadow-${randomUUID()}`;
}

function previewString(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const cutoff = Math.max(0, maxChars - ERROR_MESSAGE_TRUNCATION_TAIL.length);
  return `${input.slice(0, cutoff)}${ERROR_MESSAGE_TRUNCATION_TAIL}`;
}

function truncateMessage(input: string): string {
  if (input.length <= SHADOW_MODE_MAX_ERROR_MESSAGE_CHARS) return input;
  const cutoff = Math.max(0, SHADOW_MODE_MAX_ERROR_MESSAGE_CHARS - ERROR_MESSAGE_TRUNCATION_TAIL.length);
  return `${input.slice(0, cutoff)}${ERROR_MESSAGE_TRUNCATION_TAIL}`;
}

function truncateAnswer(input: string): string {
  if (input.length <= SHADOW_MODE_MAX_ANSWER_CHARS) return input;
  const cutoff = Math.max(0, SHADOW_MODE_MAX_ANSWER_CHARS - ERROR_MESSAGE_TRUNCATION_TAIL.length);
  return `${input.slice(0, cutoff)}${ERROR_MESSAGE_TRUNCATION_TAIL}`;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return truncateMessage(err.message);
  if (typeof err === 'string') return truncateMessage(err);
  return 'unknown error';
}

/**
 * Walk an `AgentResult.steps[]` array and emit the ordered list of tool
 * names. Handles both the legacy `step.action` (single tool call) and the
 * newer `step.actionPairs` (parallel batch) shapes.
 *
 * Migration fallback (CLAUDE.md rule 31): `step.actions` is `@deprecated`
 * in the domain model but historical AgentResult traces in some test
 * fixtures still carry it. We prefer `actionPairs` when present and only
 * read the deprecated `actions` array as a fallback for those fixtures.
 */
function extractLegacyToolNames(steps: readonly AgentStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (names.length >= SHADOW_MODE_MAX_TOOL_NAMES) break;
    const action = step.action;
    if (action !== undefined) {
      names.push(action.tool);
    }
    const pairs = step.actionPairs;
    if (pairs !== undefined) {
      for (const pair of pairs) {
        if (names.length >= SHADOW_MODE_MAX_TOOL_NAMES) break;
        names.push(pair.action.tool);
      }
      continue;
    }
    // TODO(cleanup): remove deprecated `step.actions` fallback once all
    // fixtures use `actionPairs`. The domain model retains it for
    // backward-compat only.
    const fallbackBatch: readonly AgentToolCall[] = readDeprecatedActions(step);
    for (const a of fallbackBatch) {
      if (names.length >= SHADOW_MODE_MAX_TOOL_NAMES) break;
      names.push(a.tool);
    }
  }
  return names;
}

/**
 * Read the deprecated `step.actions` field with a single suppressed-deprecation
 * access. Isolating the read here keeps the `@typescript-eslint/no-deprecated`
 * lint scope to one line, which is permissible during migration windows per
 * CLAUDE.md rule 31.
 */
function readDeprecatedActions(step: AgentStep): readonly AgentToolCall[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- migration fallback for older fixtures.
  return step.actions ?? [];
}

function extractWineSearchToolNames(
  steps: WineSearchResult['executionSteps'],
): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (names.length >= SHADOW_MODE_MAX_TOOL_NAMES) break;
    const calls = step.toolCalls;
    if (calls === undefined) continue;
    for (const call of calls) {
      if (names.length >= SHADOW_MODE_MAX_TOOL_NAMES) break;
      names.push(call.name);
    }
  }
  return names;
}

/**
 * Step-source allowlist for observation extraction. Only the runner /
 * mini_loop phases dispatch tools and therefore carry grounded
 * observations; analyzer / router / synthesizer phases are framework
 * bookkeeping (parity with `bench-scorer-adapter.SCORER_STEP_SOURCES`).
 *
 * Allocated at module scope (CLAUDE.md rule 16) so the Set is not rebuilt
 * on every call.
 */
const SHADOW_MODE_OBSERVATION_STEP_SOURCES: ReadonlySet<
  WineSearchResult['executionSteps'][number]['source']
> = new Set(['runner', 'mini_loop']);

/**
 * Walk a `WineSearchResult.executionSteps` array and emit the ordered list
 * of grounded observation strings. Only runner / mini_loop sourced steps are
 * inspected; analyzer / router / synthesizer phases never carry grounding
 * (CLAUDE.md rule 23: filter narrowly, document the gate).
 *
 * Empty strings are dropped — they carry no signal and would dilute the
 * scorer's `contextRecall` / `faithfulness` dimensions. Each retained string
 * is truncated to `SHADOW_MODE_OBSERVATION_MAX_CHARS` (mirrors the HTTP wire
 * boundary `STEP_OBSERVATION_MAX_CHARS` and the upstream orchestrator bound
 * `ORCHESTRATOR_OBSERVATION_MAX_CHARS` — same byte ceiling at every layer).
 *
 * The aggregate list is capped at `SHADOW_MODE_OBSERVATIONS_MAX`. Truncation
 * happens before serialization so the Zod schema's `.max()` invariant always
 * holds without retries.
 */
function extractWineSearchObservations(
  steps: WineSearchResult['executionSteps'],
): string[] {
  const observations: string[] = [];
  for (const step of steps) {
    if (observations.length >= SHADOW_MODE_OBSERVATIONS_MAX) break;
    if (!SHADOW_MODE_OBSERVATION_STEP_SOURCES.has(step.source)) continue;
    const obs = step.observations;
    if (obs === undefined) continue;
    for (const o of obs) {
      if (observations.length >= SHADOW_MODE_OBSERVATIONS_MAX) break;
      if (o.length === 0) continue;
      observations.push(truncateObservation(o));
    }
  }
  return observations;
}

/**
 * Walk an `AgentResult` and emit grounded observation strings.
 *
 * Prefers typed `evidenceFrames[].observationSnapshot` when present
 * (ADR-009 Phase 0) — the snapshots are byte-equivalent to what the LLM
 * saw but sourced from a structured frame. Falls back to step-level
 * `actionPairs[].observation` (parallel batches) and `step.observation`
 * (single tool call) otherwise.
 *
 * Parity with `bench-scorer-adapter.extractLegacyObservations` so the
 * legacy projection AND the shadow-mode outcome see the SAME grounded
 * surface (cutover gate invariant).
 */
function extractLegacyObservations(result: AgentResult): string[] {
  const observations: string[] = [];
  const frames = result.evidenceFrames;
  if (frames !== undefined && frames.length > 0) {
    for (const f of frames) {
      if (observations.length >= SHADOW_MODE_OBSERVATIONS_MAX) break;
      if (f.observationSnapshot.length === 0) continue;
      observations.push(truncateObservation(f.observationSnapshot));
    }
    return observations;
  }
  for (const step of result.steps) {
    if (observations.length >= SHADOW_MODE_OBSERVATIONS_MAX) break;
    const pairs = step.actionPairs;
    if (pairs !== undefined) {
      for (const p of pairs) {
        if (observations.length >= SHADOW_MODE_OBSERVATIONS_MAX) break;
        if (p.observation.length === 0) continue;
        observations.push(truncateObservation(p.observation));
      }
      continue;
    }
    if (step.observation !== undefined && step.observation.length > 0) {
      observations.push(truncateObservation(step.observation));
    }
  }
  return observations;
}

function truncateObservation(input: string): string {
  if (input.length <= SHADOW_MODE_OBSERVATION_MAX_CHARS) return input;
  const cutoff = Math.max(0, SHADOW_MODE_OBSERVATION_MAX_CHARS - ERROR_MESSAGE_TRUNCATION_TAIL.length);
  return `${input.slice(0, cutoff)}${ERROR_MESSAGE_TRUNCATION_TAIL}`;
}

/**
 * Adapt a per-side envelope from the legacy agent into the orchestrator-
 * agnostic `ShadowModeOrchestratorOutcome` shape consumed by the differ.
 */
function toLegacyOutcome(
  envelope: PerSideEnvelope<AgentResult>,
): ShadowModeOrchestratorOutcome {
  const duration = Math.max(0, envelope.finishedAt - envelope.startedAt);
  if (envelope.status !== 'ok' || envelope.result === undefined) {
    const outcome: ShadowModeOrchestratorOutcome = {
      orchestrator: 'legacy_agent',
      status: envelope.status,
      toolCallCount: 0,
      toolNames: [],
      terminationReason: envelope.status === 'ok'
        ? TERMINATION_REASON_UNKNOWN
        : envelope.status,
      totalDurationMs: Math.trunc(duration),
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      observations: [],
      ...(envelope.errorMessage !== undefined
        ? { errorMessage: truncateMessage(envelope.errorMessage) }
        : {}),
    };
    return outcome;
  }
  const result = envelope.result;
  const toolNames = extractLegacyToolNames(result.steps);
  const observations = extractLegacyObservations(result);
  return {
    orchestrator: 'legacy_agent',
    status: 'ok',
    answer: truncateAnswer(result.answer),
    toolCallCount: Math.max(0, Math.trunc(result.toolCallCount)),
    toolNames,
    terminationReason: result.terminationReason,
    totalDurationMs: Math.max(0, Math.trunc(result.totalDurationMs)),
    tokenUsage: {
      inputTokens: Math.max(0, Math.trunc(result.totalTokens.input)),
      outputTokens: Math.max(0, Math.trunc(result.totalTokens.output)),
    },
    observations,
  };
}

/**
 * Adapt a per-side envelope from the new orchestrator into the same
 * orchestrator-agnostic outcome shape.
 */
function toWineSearchOutcome(
  envelope: PerSideEnvelope<WineSearchResult>,
): ShadowModeOrchestratorOutcome {
  const duration = Math.max(0, envelope.finishedAt - envelope.startedAt);
  if (envelope.status !== 'ok' || envelope.result === undefined) {
    const outcome: ShadowModeOrchestratorOutcome = {
      orchestrator: 'wine_search',
      status: envelope.status,
      toolCallCount: 0,
      toolNames: [],
      terminationReason: envelope.status === 'ok'
        ? TERMINATION_REASON_UNKNOWN
        : envelope.status,
      totalDurationMs: Math.trunc(duration),
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      observations: [],
      ...(envelope.errorMessage !== undefined
        ? { errorMessage: truncateMessage(envelope.errorMessage) }
        : {}),
    };
    return outcome;
  }
  const result = envelope.result;
  const toolNames = extractWineSearchToolNames(result.executionSteps);
  const observations = extractWineSearchObservations(result.executionSteps);
  return {
    orchestrator: 'wine_search',
    status: 'ok',
    answer: truncateAnswer(result.answer),
    layer: result.layer,
    toolCallCount: toolNames.length,
    toolNames,
    terminationReason: result.terminationReason,
    totalDurationMs: Math.max(0, Math.trunc(result.totalDurationMs)),
    tokenUsage: {
      inputTokens: Math.max(0, Math.trunc(result.tokenUsage.inputTokens)),
      outputTokens: Math.max(0, Math.trunc(result.tokenUsage.outputTokens)),
      cacheReadTokens: Math.max(0, Math.trunc(result.tokenUsage.cacheReadTokens)),
      cacheCreationTokens: Math.max(0, Math.trunc(result.tokenUsage.cacheCreationTokens)),
    },
    observations,
  };
}
