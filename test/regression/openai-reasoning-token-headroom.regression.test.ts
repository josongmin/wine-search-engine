/**
 * Regression: OpenAI reasoning-model token headroom.
 *
 * Reasoning models (gpt-5*, o1*, o3*, o4*) consume internal reasoning
 * tokens BEFORE emitting visible output. OpenAI's `max_completion_tokens`
 * caps the COMBINED total of (reasoning_tokens + output_tokens), so a
 * caller asking for "300 output tokens" on gpt-5-mini routinely hits
 * `finish_reason="length"` once reasoning eats the budget. Symptom in
 * the bench: `StructuredLlmPartialOutputError: max_completion_tokens
 * before tool_use complete` on analyze / synthesize, empty refusal text
 * from the chat path, and 0-byte responses from the injection classifier.
 *
 * `openai-reasoning-params.ts` centralizes the fix so all three OpenAI
 * adapters (structured / chat / injection-classifier) compute the same
 * headroom. This test pins:
 *
 *  1. Reasoning detection by prefix (gpt-5*, o1*, o3*, o4*; gpt-4o NOT).
 *  2. Non-reasoning models pass max_completion_tokens through unchanged.
 *  3. Reasoning models add the env-configurable headroom (default 8192).
 *  4. Env override `WINE_SEARCH_REASONING_HEADROOM_TOKENS` honoured.
 *  5. `reasoning_effort` resolves per-mode for reasoning models.
 *  6. `reasoning_effort` returns undefined for non-reasoning models
 *     (must be omitted from the request body — gpt-4o rejects it).
 *  7. `WINE_SEARCH_REASONING_EFFORT` env override applied across modes.
 *  8. Invalid env override values fall through to per-mode defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isReasoningModel,
  resolveCompletionTokens,
  resolveReasoningEffort,
} from '../../src/infrastructure/ai/openai-reasoning-params.js';

describe('openai-reasoning-params — reasoning headroom + effort', () => {
  const originalHeadroom = process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'];
  const originalEffort = process.env['WINE_SEARCH_REASONING_EFFORT'];

  beforeEach(() => {
    delete process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'];
    delete process.env['WINE_SEARCH_REASONING_EFFORT'];
  });
  afterEach(() => {
    if (originalHeadroom === undefined) {
      delete process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'];
    } else {
      process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = originalHeadroom;
    }
    if (originalEffort === undefined) {
      delete process.env['WINE_SEARCH_REASONING_EFFORT'];
    } else {
      process.env['WINE_SEARCH_REASONING_EFFORT'] = originalEffort;
    }
  });

  describe('isReasoningModel', () => {
    it('detects gpt-5 family (gpt-5, gpt-5-mini, gpt-5.4, gpt-5.4-nano)', () => {
      expect(isReasoningModel('gpt-5')).toBe(true);
      expect(isReasoningModel('gpt-5-mini')).toBe(true);
      expect(isReasoningModel('gpt-5.4')).toBe(true);
      expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
    });

    it('detects o-series (o1-preview, o1-mini, o3-mini, o4-preview)', () => {
      expect(isReasoningModel('o1-preview')).toBe(true);
      expect(isReasoningModel('o1-mini')).toBe(true);
      expect(isReasoningModel('o3-mini')).toBe(true);
      expect(isReasoningModel('o4-preview')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isReasoningModel('GPT-5-MINI')).toBe(true);
      expect(isReasoningModel('O1-MINI')).toBe(true);
    });

    it('rejects gpt-4o family and earlier', () => {
      expect(isReasoningModel('gpt-4o')).toBe(false);
      expect(isReasoningModel('gpt-4o-mini')).toBe(false);
      expect(isReasoningModel('gpt-4-turbo')).toBe(false);
      expect(isReasoningModel('gpt-3.5-turbo')).toBe(false);
    });

    it('rejects bare ambiguous prefixes (o, gpt)', () => {
      expect(isReasoningModel('opus')).toBe(false);
      expect(isReasoningModel('claude-sonnet-4-6')).toBe(false);
    });
  });

  describe('resolveCompletionTokens', () => {
    it('non-reasoning model: pass-through unchanged', () => {
      expect(resolveCompletionTokens('gpt-4o-mini', 300)).toBe(300);
      expect(resolveCompletionTokens('gpt-3.5-turbo', 1024)).toBe(1024);
    });

    it('reasoning model: adds default headroom (8192)', () => {
      expect(resolveCompletionTokens('gpt-5-mini', 300)).toBe(300 + 8192);
      expect(resolveCompletionTokens('o1-preview', 1024)).toBe(1024 + 8192);
    });

    it('honours WINE_SEARCH_REASONING_HEADROOM_TOKENS env override', () => {
      process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = '4096';
      expect(resolveCompletionTokens('gpt-5-mini', 300)).toBe(300 + 4096);
      expect(resolveCompletionTokens('gpt-4o-mini', 300)).toBe(300); // non-reasoning still pass-through
    });

    it('rejects invalid env values (falls back to default)', () => {
      process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = 'banana';
      expect(resolveCompletionTokens('gpt-5-mini', 300)).toBe(300 + 8192);
      process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = '-100';
      expect(resolveCompletionTokens('gpt-5-mini', 300)).toBe(300 + 8192);
      process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = '0';
      expect(resolveCompletionTokens('gpt-5-mini', 300)).toBe(300 + 8192);
    });
  });

  describe('resolveReasoningEffort', () => {
    it('non-reasoning model: returns undefined (param must be omitted for gpt-4o)', () => {
      expect(resolveReasoningEffort('gpt-4o-mini', 'analyze')).toBeUndefined();
      expect(resolveReasoningEffort('gpt-4o-mini', 'execute')).toBeUndefined();
      expect(resolveReasoningEffort('gpt-4o-mini', 'synthesize')).toBeUndefined();
      expect(resolveReasoningEffort('gpt-4o-mini', 'classify')).toBeUndefined();
      expect(resolveReasoningEffort('gpt-4o-mini', 'chat')).toBeUndefined();
    });

    it('reasoning model: per-mode defaults (all `low` except synthesize=medium — universally supported)', () => {
      expect(resolveReasoningEffort('gpt-5-mini', 'analyze')).toBe('low');
      expect(resolveReasoningEffort('gpt-5-mini', 'execute')).toBe('low');
      expect(resolveReasoningEffort('gpt-5-mini', 'synthesize')).toBe('medium');
      expect(resolveReasoningEffort('gpt-5-mini', 'classify')).toBe('low');
      expect(resolveReasoningEffort('gpt-5-mini', 'chat')).toBe('low');
    });

    it('honours WINE_SEARCH_REASONING_EFFORT env override (uniform across modes)', () => {
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'high';
      expect(resolveReasoningEffort('gpt-5-mini', 'analyze')).toBe('high');
      expect(resolveReasoningEffort('gpt-5-mini', 'execute')).toBe('high');
      expect(resolveReasoningEffort('gpt-5-mini', 'synthesize')).toBe('high');
      expect(resolveReasoningEffort('gpt-5-mini', 'classify')).toBe('high');
      expect(resolveReasoningEffort('gpt-5-mini', 'chat')).toBe('high');
    });

    it('rejects invalid env override values (falls back to per-mode default)', () => {
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'extreme';
      expect(resolveReasoningEffort('gpt-5-mini', 'analyze')).toBe('low');
      expect(resolveReasoningEffort('gpt-5-mini', 'synthesize')).toBe('medium');
    });

    it('accepts deployment-specific values via env override (none, minimal, xhigh)', () => {
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'none';
      expect(resolveReasoningEffort('gpt-5-mini', 'classify')).toBe('none');
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'minimal';
      expect(resolveReasoningEffort('gpt-5-mini', 'analyze')).toBe('minimal');
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'xhigh';
      expect(resolveReasoningEffort('gpt-5-mini', 'synthesize')).toBe('xhigh');
    });

    it('env override does NOT affect non-reasoning models (still omitted)', () => {
      process.env['WINE_SEARCH_REASONING_EFFORT'] = 'high';
      expect(resolveReasoningEffort('gpt-4o-mini', 'synthesize')).toBeUndefined();
    });
  });
});
