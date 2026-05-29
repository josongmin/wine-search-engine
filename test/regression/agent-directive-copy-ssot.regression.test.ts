/**
 * SSoT regression: agent directive copy strings live in
 * `@domain/agent/copy/directive-copy.ts` (`AGENT_DIRECTIVE_COPY`).
 *
 * History: the `grounded_search_required` and `required_tool` instruction
 * strings were authored independently in
 *   - `src/application/agent/agent-contract-policy.ts`
 *   - `src/application/wine-search/wine-agent-loop-schemas.ts`
 *     (`WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH`)
 * Drift between the two would silently break unit tests asserting exact
 * directive strings and would cause inconsistent model behavior between
 * the legacy agent loop and the new wine-agent-loop runner.
 *
 * Invariants locked here:
 *  - The SSoT exposes both English and Korean copy variants for each
 *    directive kind the runner emits.
 *  - The wine-agent-loop `_ENGLISH` / `_KOREAN` bundles are byte-identical to
 *    the SSoT for `groundedSearch`, `relax`, `loopDetected`.
 *  - Parameterized templates (`requiredTool(tool)`,
 *    `pendingDrinkability(entityIds)`) produce identical output between
 *    the SSoT and the wine-agent-loop bundle for representative inputs
 *    (including Korean entity ids).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DIRECTIVE_COPY } from '@domain/agent/copy/directive-copy.js';
import {
  WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH,
  WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN,
} from '../../src/application/wine-search/wine-agent-loop-schemas.js';

describe('SSoT: AGENT_DIRECTIVE_COPY shape', () => {
  it('exposes English and Korean variants', () => {
    expect(AGENT_DIRECTIVE_COPY.english).toBeDefined();
    expect(AGENT_DIRECTIVE_COPY.korean).toBeDefined();
  });

  it('English groundedSearch matches the agent-contract-policy fixed string', () => {
    expect(AGENT_DIRECTIVE_COPY.english.groundedSearch).toBe(
      'This request still requires a grounded wine search before answering. Call search_hybrid first and answer only from the returned evidence.',
    );
  });

  it('English requiredTool template instantiates correctly for lookup_wine', () => {
    expect(AGENT_DIRECTIVE_COPY.english.requiredTool('lookup_wine')).toBe(
      'This request requires lookup_wine before answering. Call lookup_wine first and answer only from the returned evidence.',
    );
  });

  it('Korean groundedSearch is non-empty and contains a Hangul character', () => {
    expect(AGENT_DIRECTIVE_COPY.korean.groundedSearch.length).toBeGreaterThan(0);
    expect(/[ㄱ-힝]/u.test(AGENT_DIRECTIVE_COPY.korean.groundedSearch)).toBe(true);
  });

  it('English and Korean copy bundles expose identical key sets', () => {
    expect(Object.keys(AGENT_DIRECTIVE_COPY.english).sort()).toEqual(
      Object.keys(AGENT_DIRECTIVE_COPY.korean).sort(),
    );
  });
});

describe('SSoT: wine-agent-loop directive copy is byte-identical to SSoT', () => {
  it('English: relax, groundedSearch, loopDetected match the SSoT exactly', () => {
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.relax).toBe(
      AGENT_DIRECTIVE_COPY.english.relax,
    );
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.groundedSearch).toBe(
      AGENT_DIRECTIVE_COPY.english.groundedSearch,
    );
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.loopDetected).toBe(
      AGENT_DIRECTIVE_COPY.english.loopDetected,
    );
  });

  it('Korean: relax, groundedSearch, loopDetected match the SSoT exactly', () => {
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.relax).toBe(
      AGENT_DIRECTIVE_COPY.korean.relax,
    );
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.groundedSearch).toBe(
      AGENT_DIRECTIVE_COPY.korean.groundedSearch,
    );
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.loopDetected).toBe(
      AGENT_DIRECTIVE_COPY.korean.loopDetected,
    );
  });

  it('English requiredTool produces the same output as the SSoT for a sample tool name', () => {
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.requiredTool('search_hybrid')).toBe(
      AGENT_DIRECTIVE_COPY.english.requiredTool('search_hybrid'),
    );
  });

  it('Korean requiredTool produces the same output as the SSoT for a sample tool name', () => {
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.requiredTool('search_hybrid')).toBe(
      AGENT_DIRECTIVE_COPY.korean.requiredTool('search_hybrid'),
    );
  });

  it('English pendingDrinkability produces the same output as the SSoT for ASCII ids', () => {
    const ids: readonly string[] = ['wine-1', 'wine-2'];
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.pendingDrinkability(ids)).toBe(
      AGENT_DIRECTIVE_COPY.english.pendingDrinkability(ids),
    );
  });

  it('Korean pendingDrinkability produces the same output as the SSoT for Hangul-bearing ids', () => {
    // CLAUDE.md rule 5: regex-like helpers must work with Korean. The SSoT
    // template uses string concatenation only — there is no regex — so the
    // assertion mainly guarantees identical output.
    const ids: readonly string[] = ['오퍼스원-2018', 'wine-2'];
    expect(WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.pendingDrinkability(ids)).toBe(
      AGENT_DIRECTIVE_COPY.korean.pendingDrinkability(ids),
    );
  });

  it('English pendingDrinkability handles the empty-id edge case without throwing', () => {
    // Defensive: even when entityIds is empty (caller responsibility prevents
    // this in practice), the formatter should not throw.
    expect(() => AGENT_DIRECTIVE_COPY.english.pendingDrinkability([])).not.toThrow();
  });
});
