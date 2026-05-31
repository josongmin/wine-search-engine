import { describe, expect, it } from 'vitest';
import { ClaudeStructuredLlmAdapter } from '../claude-structured-llm-adapter.js';
import { OpenAIStructuredLlmAdapter } from '../openai-structured-llm-adapter.js';

/**
 * T-MTA-06 — no-singleton rule for provider conversational state.
 *
 * Structured-LLM adapters are process-wide singletons (one per provider,
 * shared across every concurrent session). They MUST hold only immutable
 * config + shared resilience primitives — NEVER per-conversation state
 * (continuation handles, message history, session ids, prompt-cache cursors).
 * Such state belongs on the session-owned `AgentRuntimeSessionState` seam.
 *
 * This is the enforcement rail: if someone adds a `private continuationState`
 * (or similar) field to an adapter, this test fails. The guard is structural
 * (instance own-property names) so it catches the mistake at the field level,
 * before any cross-session corruption can ship.
 */

const FORBIDDEN_FIELD_PATTERN = /continuation|conversation|session|history|messages|turn|transcript|lastResponse|pendingResult/i;

const CLAUDE_ALLOWED_FIELDS = new Set([
  'apiKey',
  'defaultModel',
  'httpTimeoutMs',
  'endpoint',
  'circuitBreaker',
]);

const OPENAI_ALLOWED_FIELDS = new Set([
  'apiKey',
  'defaultModel',
  'httpTimeoutMs',
  'baseUrl',
  'circuitBreaker',
]);

describe('provider adapters — no singleton conversational state (T-MTA-06)', () => {
  it('ClaudeStructuredLlmAdapter exposes only immutable config fields', () => {
    const adapter = new ClaudeStructuredLlmAdapter({ apiKey: 'sk-test', httpTimeoutMs: 1_000 });
    const fields = Object.getOwnPropertyNames(adapter);
    for (const field of fields) {
      expect(field).not.toMatch(FORBIDDEN_FIELD_PATTERN);
      expect(CLAUDE_ALLOWED_FIELDS.has(field)).toBe(true);
    }
  });

  it('OpenAIStructuredLlmAdapter exposes only immutable config fields', () => {
    const adapter = new OpenAIStructuredLlmAdapter({ apiKey: 'sk-test', httpTimeoutMs: 1_000 });
    const fields = Object.getOwnPropertyNames(adapter);
    for (const field of fields) {
      expect(field).not.toMatch(FORBIDDEN_FIELD_PATTERN);
      expect(OPENAI_ALLOWED_FIELDS.has(field)).toBe(true);
    }
  });

  it('two adapter instances share no mutable cross-talk surface', () => {
    const a = new ClaudeStructuredLlmAdapter({ apiKey: 'sk-a', httpTimeoutMs: 1_000 });
    const b = new ClaudeStructuredLlmAdapter({ apiKey: 'sk-b', httpTimeoutMs: 1_000 });
    // Distinct instances; no shared mutable conversational field to leak across.
    expect(a).not.toBe(b);
    for (const field of Object.getOwnPropertyNames(a)) {
      expect(field).not.toMatch(FORBIDDEN_FIELD_PATTERN);
    }
  });
});
