/**
 * RFC-021 T-PSA-05 — banned-surface proof rail.
 *
 * Prevents the legacy mixed/convenience taxonomy from drifting back onto the
 * PRODUCT / TOOL primary surface. This rail is registration- and contract-aware
 * (not a blind grep): it checks the active tool taxonomy, the live tool bundle
 * contract (names + LLM-facing descriptions), the agent system prompt copy, and
 * the public route mappers.
 *
 * Internal compatibility residue (`similar_items` as an internal retrieval mode,
 * the mixed solver, `CompareWinesAttemptInputSchema`, historical docs) is
 * intentionally retained and documented in
 * `docs/plans/jun-01-rfc-021-primitive-search-agent/banned-surface-allowlist.md`.
 * This rail deliberately scopes to product-facing surfaces so it does not fire
 * on allowlisted internal residue.
 *
 * Append-only (CLAUDE.md): never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_AGENT_TOOL_NAMES } from '@domain/agent/model/agent-tool-attempt-schema.js';
import {
  buildWineAgentLoopToolBundle,
  WINE_AGENT_LOOP_TOOL_NAMES,
} from '../../src/application/wine-search/wine-agent-loop-tool-bundle.js';
import type { WineAgentLoopToolPorts } from '../../src/application/wine-search/wine-agent-loop-schemas.js';

/** Legacy/convenience tool names that must never reappear as a product tool. */
const BANNED_TOOL_NAMES = [
  'search_wines',
  'compare_wines',
  'get_food_pairings',
  'check_drinking_window',
] as const;

/** Tokens that must not appear in LLM-facing tool descriptions / prompt copy as
 *  a product instruction (lane overrides smuggled through the body, etc.). */
const BANNED_COPY_TOKENS = [
  'search_wines',
  'compare_wines',
  'mode=mixed',
  'mode=hybrid',
  'retrieval_mode=mixed',
] as const;

function repoFile(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

const stubBundlePorts = {
  searchUseCase: { execute: async () => { throw new Error('unused'); } },
} as unknown as WineAgentLoopToolPorts;

describe('banned-surface guard — active agent tool taxonomy', () => {
  it('KNOWN_AGENT_TOOL_NAMES excludes every banned convenience/legacy tool', () => {
    for (const banned of BANNED_TOOL_NAMES) {
      expect(KNOWN_AGENT_TOOL_NAMES as readonly string[]).not.toContain(banned);
      expect(WINE_AGENT_LOOP_TOOL_NAMES as readonly string[]).not.toContain(banned);
    }
  });

  it('the active taxonomy is exactly the primitive set (incl. similar_to_entity)', () => {
    expect([...KNOWN_AGENT_TOOL_NAMES].sort()).toEqual(
      ['lookup_wine', 'search_hybrid', 'search_lexical', 'search_semantic', 'similar_to_entity'],
    );
  });
});

describe('banned-surface guard — live tool bundle contract', () => {
  const bundle = buildWineAgentLoopToolBundle(stubBundlePorts);

  it('no registered tool uses a banned name', () => {
    for (const tool of bundle.tools) {
      expect(BANNED_TOOL_NAMES as readonly string[]).not.toContain(tool.name);
    }
  });

  it('no LLM-facing tool description carries a banned product token', () => {
    for (const tool of bundle.tools) {
      for (const token of BANNED_COPY_TOKENS) {
        expect(tool.description).not.toContain(token);
      }
    }
  });
});

describe('banned-surface guard — agent runtime copy & public mappers', () => {
  it('the wine-agent-loop runtime (prompt + dispatch) names no banned tool', () => {
    const src = repoFile('src/application/wine-search/wine-agent-loop.ts');
    for (const banned of BANNED_TOOL_NAMES) {
      expect(src.includes(banned)).toBe(false);
    }
  });

  it('the agent tool bundle module names no banned tool outside its descriptions', () => {
    const src = repoFile('src/application/wine-search/wine-agent-loop-tool-bundle.ts');
    for (const banned of BANNED_TOOL_NAMES) {
      expect(src.includes(banned)).toBe(false);
    }
  });

  it('the public primitive route mappers expose no banned tool / lane override', () => {
    const src = repoFile('src/interface/http/routes/search-request-mappers.ts');
    for (const token of [...BANNED_TOOL_NAMES, 'mode=mixed', 'similar_items']) {
      expect(src.includes(token)).toBe(false);
    }
  });
});
