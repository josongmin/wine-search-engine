import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';

export interface OpenAiKeySlot {
  readonly apiKey: string;
  readonly breakerName: string;
  readonly circuitBreaker: CircuitBreaker;
}

interface OpenAiKeyPoolOptions {
  readonly baseBreakerName: string;
  readonly apiKey?: string | undefined;
  readonly apiKeys?: readonly string[] | undefined;
  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenMaxAttempts: number;
}

/**
 * Injectable monotonic clock used by OpenAiKeyPool for rate-limit cooldown
 * tracking. Tests pass a fake clock so `markRateLimited` / recovery can be
 * driven deterministically without real timers.
 */
export interface OpenAiKeyPoolClock {
  now(): number;
}

/** Default rate-limit cooldown when none provided (60s — matches OpenAI 429 backoff guidance). */
export const DEFAULT_OPENAI_KEY_POOL_COOLDOWN_MS = 60_000;

export interface OpenAiKeyPoolConstructorOptions extends OpenAiKeyPoolOptions {
  /** Cooldown window after `markRateLimited` before the key becomes acquirable again. */
  readonly rateLimitCooldownMs?: number;
  /** Injectable clock; defaults to `Date.now`-backed wall-clock. */
  readonly clock?: OpenAiKeyPoolClock;
}

export interface OpenAiKeyPoolStats {
  readonly keyCount: number;
  readonly exhaustedCount: number;
  readonly totalAcquires: number;
}

const OPENAI_POOL_ERROR_PREVIEW_CHARS = 200;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_5XX_MIN = 500;
const HTTP_STATUS_5XX_MAX_EXCLUSIVE = 600;

export function normalizeOpenAiApiKeys(
  apiKey: string | undefined,
  apiKeys: readonly string[] | undefined,
): readonly string[] {
  const deduped = new Set<string>();
  const ordered: string[] = [];
  for (const key of [apiKey, ...(apiKeys ?? [])]) {
    const trimmed = key?.trim();
    if (trimmed === undefined || trimmed.length === 0 || deduped.has(trimmed)) {
      continue;
    }
    deduped.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

export function createOpenAiKeyPool(options: OpenAiKeyPoolOptions): readonly OpenAiKeySlot[] {
  const keys = normalizeOpenAiApiKeys(options.apiKey, options.apiKeys);
  if (keys.length === 0) {
    throw new Error('OpenAI adapter requires at least one API key');
  }

  return keys.map((apiKey, index) => {
    const breakerName =
      keys.length === 1
        ? options.baseBreakerName
        : `${options.baseBreakerName}:key-${index + 1}`;
    const circuitBreaker = createCircuitBreaker({
      name: breakerName,
      failureThreshold: options.failureThreshold,
      recoveryTimeoutMs: options.recoveryTimeoutMs,
      halfOpenMaxAttempts: options.halfOpenMaxAttempts,
    });
    globalCircuitBreakerRegistry.register(breakerName, circuitBreaker);
    return { apiKey, breakerName, circuitBreaker };
  });
}

export function orderedOpenAiKeySlots(
  slots: readonly OpenAiKeySlot[],
  startIndex: number,
): readonly OpenAiKeySlot[] {
  if (slots.length === 0) return [];
  return Array.from({ length: slots.length }, (_, offset) => {
    const slot = slots[(startIndex + offset) % slots.length];
    if (slot === undefined) {
      throw new Error('OpenAI key pool slot index out of bounds');
    }
    return slot;
  });
}

export function isOpenAiKeyPoolRotatableError(err: unknown): boolean {
  if (err instanceof CircuitBreakerOpenError) return true;

  const status = extractHttpStatus(err);
  if (status === undefined) return false;
  if (status === HTTP_STATUS_UNAUTHORIZED) return true;
  if (status === HTTP_STATUS_FORBIDDEN) return true;
  if (status === HTTP_STATUS_REQUEST_TIMEOUT) return true;
  if (status === HTTP_STATUS_TOO_MANY_REQUESTS) return true;
  return status >= HTTP_STATUS_5XX_MIN && status < HTTP_STATUS_5XX_MAX_EXCLUSIVE;
}

export function openAiKeyPoolExhaustedError(
  label: string,
  keyCount: number,
  errors: readonly unknown[],
): Error {
  const last = errors.at(-1);
  const suffix =
    last instanceof Error
      ? ` Last error: ${last.message.slice(0, OPENAI_POOL_ERROR_PREVIEW_CHARS)}`
      : '';
  return new Error(`${label} key pool exhausted (${keyCount} keys attempted).${suffix}`);
}

const DEFAULT_CLOCK: OpenAiKeyPoolClock = { now: () => Date.now() };

/**
 * Higher-level pool wrapper providing:
 *  - `acquire()` round-robin rotation that skips rate-limited keys
 *  - `markRateLimited(apiKey)` to record a cooldown window
 *  - `getStats()` health snapshot
 *
 * Backward-compat: this class composes the existing
 * `createOpenAiKeyPool` slot factory and is additive — existing functional
 * consumers (chat-llm, embedding-service, injection-classifier) remain
 * unchanged. Tests can drive cooldowns deterministically by passing a fake
 * `OpenAiKeyPoolClock`.
 */
export class OpenAiKeyPool {
  private readonly slots: readonly OpenAiKeySlot[];
  private readonly cooldownMs: number;
  private readonly clock: OpenAiKeyPoolClock;
  /** When each slot exits its rate-limit cooldown (ms in clock domain). 0 = healthy. */
  private readonly cooldownUntil: number[];
  private nextIndex = 0;
  private totalAcquires = 0;

  constructor(options: OpenAiKeyPoolConstructorOptions) {
    this.slots = createOpenAiKeyPool({
      baseBreakerName: options.baseBreakerName,
      apiKey: options.apiKey,
      apiKeys: options.apiKeys,
      failureThreshold: options.failureThreshold,
      recoveryTimeoutMs: options.recoveryTimeoutMs,
      halfOpenMaxAttempts: options.halfOpenMaxAttempts,
    });
    this.cooldownMs =
      options.rateLimitCooldownMs ?? DEFAULT_OPENAI_KEY_POOL_COOLDOWN_MS;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.cooldownUntil = this.slots.map(() => 0);
  }

  /** Underlying slots (read-only) for callers that still want direct access. */
  get keySlots(): readonly OpenAiKeySlot[] {
    return this.slots;
  }

  /**
   * Acquire the next available key using round-robin, skipping any slot
   * still inside its rate-limit cooldown. Returns `null` if all slots are
   * exhausted.
   */
  acquire(): OpenAiKeySlot | null {
    const now = this.clock.now();
    const n = this.slots.length;
    for (let offset = 0; offset < n; offset += 1) {
      const idx = (this.nextIndex + offset) % n;
      const until = this.cooldownUntil[idx] ?? 0;
      if (until <= now) {
        this.nextIndex = (idx + 1) % n;
        this.totalAcquires += 1;
        const slot = this.slots[idx];
        if (slot === undefined) {
          throw new Error('OpenAI key pool slot index out of bounds');
        }
        return slot;
      }
    }
    return null;
  }

  /**
   * Mark the slot owning `apiKey` as rate-limited; it will be skipped by
   * `acquire()` until `cooldownMs` has elapsed against the injected clock.
   * Silently no-ops if the key is not in the pool — defensive against
   * stale references from outer rotation loops.
   */
  markRateLimited(apiKey: string): void {
    const idx = this.slots.findIndex((s) => s.apiKey === apiKey);
    if (idx < 0) return;
    this.cooldownUntil[idx] = this.clock.now() + this.cooldownMs;
  }

  /** Snapshot of pool health. `exhaustedCount` is evaluated against the current clock. */
  getStats(): OpenAiKeyPoolStats {
    const now = this.clock.now();
    let exhaustedCount = 0;
    for (const until of this.cooldownUntil) {
      if (until > now) exhaustedCount += 1;
    }
    return {
      keyCount: this.slots.length,
      exhaustedCount,
      totalAcquires: this.totalAcquires,
    };
  }
}

function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const statusField = (err as Record<string, unknown>)['status'];
  if (typeof statusField === 'number' && Number.isFinite(statusField)) {
    return statusField;
  }

  if (err instanceof Error) {
    const match = err.message.match(/HTTP\s+(\d{3})/);
    if (match?.[1] !== undefined) {
      const status = Number.parseInt(match[1], 10);
      if (Number.isFinite(status)) return status;
    }
  }

  return undefined;
}
