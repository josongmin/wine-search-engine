import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_RETRY_CONFIG,
  withRetryLabel,
} from '../llm-retry-config.js';

/**
 * Drift guard for the shared LLM retry envelope (SSoT: llm-retry-config.ts).
 *
 * Before this module the same five numeric values were copy-pasted into every
 * LLM adapter (OpenAI chat, Anthropic chat, ChatGPT OAuth, OpenAI structured).
 * These tests pin the envelope so a change in one place is a deliberate change
 * to the SSoT, not a silent per-adapter drift.
 */
describe('DEFAULT_LLM_RETRY_CONFIG (SSoT envelope)', () => {
  it('pins the shared backoff tuning', () => {
    expect(DEFAULT_LLM_RETRY_CONFIG).toStrictEqual({
      maxAttempts: 4,
      transientBackoffBaseMs: 250,
      transientBackoffCapMs: 2_000,
      rateLimitBackoffBaseMs: 2_000,
      rateLimitBackoffCapMs: 30_000,
    });
  });

  it('carries no label (label is provided per adapter)', () => {
    expect('label' in DEFAULT_LLM_RETRY_CONFIG).toBe(false);
  });

  it('is frozen so a consumer cannot mutate the shared base', () => {
    expect(Object.isFrozen(DEFAULT_LLM_RETRY_CONFIG)).toBe(true);
  });

  it('rate-limit regime backs off slower and longer than the transient regime', () => {
    // Domain invariant: 429 (TPM exhaustion) needs a longer recovery window
    // than a one-off 5xx / connection reset.
    expect(DEFAULT_LLM_RETRY_CONFIG.rateLimitBackoffBaseMs).toBeGreaterThan(
      DEFAULT_LLM_RETRY_CONFIG.transientBackoffBaseMs,
    );
    expect(DEFAULT_LLM_RETRY_CONFIG.rateLimitBackoffCapMs).toBeGreaterThan(
      DEFAULT_LLM_RETRY_CONFIG.transientBackoffCapMs,
    );
  });
});

describe('withRetryLabel', () => {
  it('produces a full RetryConfig: SSoT envelope + the given label', () => {
    expect(withRetryLabel('OpenAI chat')).toStrictEqual({
      ...DEFAULT_LLM_RETRY_CONFIG,
      label: 'OpenAI chat',
    });
  });

  it('keeps each provider label distinct while sharing the same numbers', () => {
    const openai = withRetryLabel('OpenAI chat');
    const anthropic = withRetryLabel('Anthropic chat');
    const chatgpt = withRetryLabel('ChatGPT OAuth chat');
    const structured = withRetryLabel('OpenAI structured');

    // Labels differ...
    const labels = [openai.label, anthropic.label, chatgpt.label, structured.label];
    expect(new Set(labels).size).toBe(labels.length);

    // ...but the numeric envelope is identical across all of them.
    for (const cfg of [openai, anthropic, chatgpt, structured]) {
      expect({
        maxAttempts: cfg.maxAttempts,
        transientBackoffBaseMs: cfg.transientBackoffBaseMs,
        transientBackoffCapMs: cfg.transientBackoffCapMs,
        rateLimitBackoffBaseMs: cfg.rateLimitBackoffBaseMs,
        rateLimitBackoffCapMs: cfg.rateLimitBackoffCapMs,
      }).toStrictEqual(DEFAULT_LLM_RETRY_CONFIG);
    }
  });

  it('applies a narrow override (key-pool single-attempt) without touching other fields', () => {
    const pool = withRetryLabel('OpenAI chat', { maxAttempts: 1 });
    expect(pool.maxAttempts).toBe(1);
    expect(pool.label).toBe('OpenAI chat');
    // All non-overridden fields still come from the SSoT.
    expect(pool.transientBackoffBaseMs).toBe(DEFAULT_LLM_RETRY_CONFIG.transientBackoffBaseMs);
    expect(pool.rateLimitBackoffCapMs).toBe(DEFAULT_LLM_RETRY_CONFIG.rateLimitBackoffCapMs);
  });

  it('does not mutate the shared base when an override is applied', () => {
    withRetryLabel('OpenAI chat', { maxAttempts: 1 });
    expect(DEFAULT_LLM_RETRY_CONFIG.maxAttempts).toBe(4);
  });
});
