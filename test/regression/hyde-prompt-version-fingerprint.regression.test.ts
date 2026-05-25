/**
 * Regression: HyDE system prompt version + fingerprint governance.
 *
 * Why
 * ---
 * The HyDE prompt seeds a *dense vector* into the retrieval combine. Any
 * silent edit to the prompt body shifts the embedding distribution and
 * invalidates historical bench replays. This test pins:
 *
 *  1. `HYDE_PROMPT_VERSION` to a known value (`'v1'`). Bumping the
 *     constant requires editing this test — a deliberate two-file change
 *     that no accidental rewording can sneak past.
 *  2. The deterministic short fingerprint of the prompt text. If anyone
 *     edits a comma or pluralises a word in the prompt, the fingerprint
 *     changes and this test fails LOUDLY — the engineer is then forced
 *     to either revert or bump the version constant.
 *  3. The fingerprint algorithm itself: pure function of its input,
 *     identical output across calls / processes.
 *
 * Append-only per CLAUDE.md regression-test discipline.
 *
 * If you intentionally change the prompt:
 *   - Bump `HYDE_PROMPT_VERSION` in `hyde-system-prompt.ts`.
 *   - Recompute the fingerprint (run `computeHydePromptFingerprint` on
 *     the new text) and update `LOCKED_HYDE_PROMPT_FINGERPRINT` below.
 *   - Update `LOCKED_HYDE_PROMPT_VERSION` to the new version string.
 *   - Note the change in the relevant RFC / changelog so bench eval
 *     comparisons against historical embeddings are interpreted right.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  HYDE_DOC_MAX_CHARS,
  HYDE_PROMPT_VERSION,
  HYDE_SYSTEM_PROMPT,
  HYDE_SYSTEM_PROMPT_FINGERPRINT,
  computeHydePromptFingerprint,
} from '../../src/domain/retrieval/service/prompts/hyde-system-prompt.js';
import {
  HYDE_PROMPT_VERSION as HYDE_PROMPT_VERSION_REEXPORT,
  HYDE_SYSTEM_PROMPT_FINGERPRINT as HYDE_SYSTEM_PROMPT_FINGERPRINT_REEXPORT,
  createHydeGenerator,
} from '../../src/domain/retrieval/service/hyde-generator.js';
import type {
  StructuredLlmPort,
  ExecuteRequest,
  SynthesizeRequest,
  SynthesizeResult,
} from '../../src/domain/ai/port/structured-llm.port.js';

/**
 * Locked version + fingerprint pair. These two values MUST move together —
 * a fingerprint change without a version bump means the prompt was edited
 * silently. A version bump without a fingerprint change means the version
 * was bumped without actually changing the prompt body (also a smell).
 *
 * Computed against the v1 prompt body using SHA-256 truncated to 16 hex
 * chars. Recompute when intentionally bumping the version.
 */
const LOCKED_HYDE_PROMPT_VERSION = 'v1';
const LOCKED_HYDE_PROMPT_FINGERPRINT = '98682b23de4b561f';

describe('hyde-prompt-version-fingerprint regression', () => {
  it('HYDE_PROMPT_VERSION is locked at the documented value', () => {
    expect(HYDE_PROMPT_VERSION).toBe(LOCKED_HYDE_PROMPT_VERSION);
  });

  it('HYDE_SYSTEM_PROMPT is a non-empty string with the v1 body length', () => {
    expect(typeof HYDE_SYSTEM_PROMPT).toBe('string');
    expect(HYDE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    // The v1 body interpolates `HYDE_DOC_MAX_CHARS`; if that constant
    // moves OR the wording changes, the length shifts and this is the
    // first cheap signal something is off.
    expect(HYDE_SYSTEM_PROMPT).toContain(String(HYDE_DOC_MAX_CHARS));
    expect(HYDE_SYSTEM_PROMPT).toContain('sommelier');
    expect(HYDE_SYSTEM_PROMPT).toContain('Output strictly JSON');
  });

  it('computeHydePromptFingerprint is deterministic — same input → same output', () => {
    const a = computeHydePromptFingerprint('hello world');
    const b = computeHydePromptFingerprint('hello world');
    expect(a).toBe(b);
    // Different inputs differ.
    expect(computeHydePromptFingerprint('hello world!')).not.toBe(a);
  });

  it('computeHydePromptFingerprint matches the documented algorithm (SHA-256 / 16 hex chars)', () => {
    const input = 'wine-search-engine governance probe';
    const expected = createHash('sha256')
      .update(input, 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(computeHydePromptFingerprint(input)).toBe(expected);
    // Format invariants.
    expect(computeHydePromptFingerprint(input)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('HYDE_SYSTEM_PROMPT_FINGERPRINT is locked — any text drift trips this', () => {
    // Recompute from source to guard against the constant getting stale
    // (e.g. someone hand-edits the exported value).
    expect(HYDE_SYSTEM_PROMPT_FINGERPRINT).toBe(
      computeHydePromptFingerprint(HYDE_SYSTEM_PROMPT),
    );
    expect(HYDE_SYSTEM_PROMPT_FINGERPRINT).toBe(LOCKED_HYDE_PROMPT_FINGERPRINT);
  });

  it('locked (version, fingerprint) pair must move together — drift detection', () => {
    // The invariant: if the fingerprint matches the locked value, the
    // version MUST match the locked version (and vice versa). This test
    // is the canonical place engineers update when intentionally
    // bumping the prompt. If only one side is updated, the build fails.
    if (HYDE_SYSTEM_PROMPT_FINGERPRINT === LOCKED_HYDE_PROMPT_FINGERPRINT) {
      expect(HYDE_PROMPT_VERSION).toBe(LOCKED_HYDE_PROMPT_VERSION);
    }
    if (HYDE_PROMPT_VERSION === LOCKED_HYDE_PROMPT_VERSION) {
      expect(HYDE_SYSTEM_PROMPT_FINGERPRINT).toBe(
        LOCKED_HYDE_PROMPT_FINGERPRINT,
      );
    }
  });

  it('hyde-generator re-exports the same governance constants', () => {
    // Downstream observability / tracing should be able to read these
    // from the generator module without reaching into the prompts/
    // subdirectory. Confirm the re-exports are identity-equal.
    expect(HYDE_PROMPT_VERSION_REEXPORT).toBe(HYDE_PROMPT_VERSION);
    expect(HYDE_SYSTEM_PROMPT_FINGERPRINT_REEXPORT).toBe(
      HYDE_SYSTEM_PROMPT_FINGERPRINT,
    );
  });

  it('createHydeGenerator() instance exposes promptVersion + promptFingerprint metadata', () => {
    const port: StructuredLlmPort = {
      analyze: (async () => {
        throw new Error('not used in this test');
      }) as StructuredLlmPort['analyze'],
      execute: (_req: ExecuteRequest) => {
        throw new Error('not used');
      },
      synthesize: <
        TSchema extends Parameters<StructuredLlmPort['synthesize']>[0]['schema'],
      >(
        _req: SynthesizeRequest<TSchema>,
      ): Promise<SynthesizeResult<unknown>> => {
        throw new Error('not used');
      },
    };
    const gen = createHydeGenerator({ structuredLlm: port, model: 'gpt-5-mini' });
    expect(gen.promptVersion).toBe(HYDE_PROMPT_VERSION);
    expect(gen.promptFingerprint).toBe(HYDE_SYSTEM_PROMPT_FINGERPRINT);
  });
});
