/**
 * Circuit-breaker wiring tests for AnthropicLLMInjectionClassifier.
 *
 * The classifier wraps the Anthropic SDK's `messages.create` call inside
 * `runUnderLlmBreaker`. We mock the SDK module so tests control the
 * outcome of every call without hitting the network.
 *
 * Behaviors under test:
 *   1. A normal (successful) call keeps the breaker CLOSED.
 *   2. Five consecutive 5xx failures trip the breaker; the next call
 *      fast-fails with CircuitBreakerOpenError.
 *   3. Repeated 400 (non-429 4xx) errors do NOT trip the breaker — the
 *      caller keeps seeing the raw SDK error rather than a breaker error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';

// Module-level mock for the Anthropic SDK. The constructor is captured
// so each test can override `messages.create` behavior per-instance.
const messagesCreateMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    public readonly messages = { create: messagesCreateMock };
  }
  return { Anthropic };
});

// Import AFTER vi.mock so the mocked SDK is used.
import { AnthropicLLMInjectionClassifier } from '../anthropic-llm-injection-classifier.js';

function makeSuccessResponse(isInjection: boolean): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ is_injection: isInjection }) }],
  };
}

function makeHttpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function newClassifier(): AnthropicLLMInjectionClassifier {
  return new AnthropicLLMInjectionClassifier('sk-ant-test');
}

async function classifyIgnoringError(
  classifier: AnthropicLLMInjectionClassifier,
  query = 'find a Bordeaux under 50',
): Promise<unknown> {
  try {
    return await classifier.classify(query);
  } catch (err) {
    return err;
  }
}

describe('AnthropicLLMInjectionClassifier circuit breaker', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays CLOSED on normal successful calls', async () => {
    messagesCreateMock.mockResolvedValue(makeSuccessResponse(false));
    const classifier = newClassifier();
    expect(await classifier.classify('find a Bordeaux')).toBe(false);
    expect(await classifier.classify('find a Burgundy')).toBe(false);
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('opens after 5 consecutive 5xx failures and fast-fails the next call', async () => {
    vi.useFakeTimers();
    messagesCreateMock.mockRejectedValue(makeHttpError(503));
    const classifier = newClassifier();

    // The classifier's internal retry loop sleeps on 503; fake timers
    // advance past every sleep. Each call to classify() counts as ONE
    // breaker-level invocation — the internal retries are wrapped inside
    // a single runUnderLlmBreaker call (the breaker sits INSIDE
    // classifyOnce, so each retry attempt records one failure). That
    // means ~2 classify() calls already exceed the 5-failure threshold
    // (each classify = up to 3 internal attempts = up to 3 breaker
    // failures). We drive it with five classify() calls to be safe.
    for (let i = 0; i < 5; i++) {
      const p = classifyIgnoringError(classifier);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await p;
      expect(err).toBeInstanceOf(Error);
    }

    // After the breaker opens, the next classify() must fast-fail with
    // CircuitBreakerOpenError without calling messages.create again.
    const callsBefore = messagesCreateMock.mock.calls.length;
    const p = classifyIgnoringError(classifier);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await p;
    expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    expect(messagesCreateMock.mock.calls.length).toBe(callsBefore);
  });

  it('does NOT open on repeated 400 errors — caller fault', async () => {
    messagesCreateMock.mockRejectedValue(makeHttpError(400));
    const classifier = newClassifier();

    // Ten classify() calls. The classifier does not retry on 400 (it's
    // not in the retriable set), so each call invokes the SDK exactly
    // once. If 400 counted as a service failure, the breaker would open
    // after 5 and subsequent calls would throw CircuitBreakerOpenError.
    for (let i = 0; i < 10; i++) {
      const err = await classifyIgnoringError(classifier);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as Error & { status?: number }).status).toBe(400);
    }
    expect(messagesCreateMock.mock.calls.length).toBe(10);
  });
});
