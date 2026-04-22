import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';

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
