import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyBaseLogger } from 'fastify';
import { snapshotActivations } from './feature-activation-registry.js';

/**
 * Per-HTTP-request pipeline debug context.
 * Populated when a contract route handler runs under {@link runWithRequestPipelineDebug}
 * (typically after `X-Debug-Key` matched `HTTP_DEBUG_SECRET`).
 *
 * **Step names:** prefer `PipelineDebugStep` in `pipeline-debug-steps.ts` for new logs.
 */
interface RequestPipelineDebugContext {
  readonly requestId: string;
  readonly debugRequest: boolean;
  /** Fastify request logger (may be a child at level `debug` when debug mode is on). */
  readonly requestLog: FastifyBaseLogger;
}

const storage = new AsyncLocalStorage<RequestPipelineDebugContext>();

/**
 * Runs `fn` with pipeline debug context bound for the async continuation chain.
 */
export function runWithRequestPipelineDebug<T>(
  ctx: RequestPipelineDebugContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getRequestPipelineDebugContext(): RequestPipelineDebugContext | undefined {
  return storage.getStore();
}

/**
 * Truncates user query text for safe debug logs (no huge payloads).
 */
export function sanitizeQueryForDebug(raw: string, maxChars = 96): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars)}…`;
}

/**
 * Structured debug line for the search pipeline. No-ops unless the current request
 * had `debugRequest === true` (HTTP debug secret + matching header).
 *
 * Wave 2 — every emitted line carries `feature_activations`, a snapshot
 * of the global feature-flag registry, so operators can correlate a
 * pipeline event with the exact flag state at request time without
 * cross-referencing a separate startup log line.
 */
export function pipelineDebug(payload: Record<string, unknown>, msg: string): void {
  const ctx = storage.getStore();
  if (ctx?.debugRequest !== true) return;
  ctx.requestLog.debug(
    {
      pipeline_debug: true,
      request_id: ctx.requestId,
      feature_activations: snapshotActivations(),
      ...payload,
    },
    msg,
  );
}

/**
 * Shorthand for `pipelineDebug({ step, ...extra }, msg)` — keeps step names consistent.
 */
export function pipelineTrace(
  step: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  pipelineDebug(
    extra !== undefined ? { step, ...extra } : { step },
    msg,
  );
}
