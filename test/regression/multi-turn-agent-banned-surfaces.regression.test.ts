import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_AGENT_STEPS_CAP } from '../../src/interface/http/constants.js';
import { AGENT_MAX_STEPS_HARD_CAP } from '../../src/domain/agent/model/agent-config.js';

/**
 * T-MTA-07 — banned legacy surface rail for the multi-turn agent cutover.
 *
 * The README ban list (docs/plans/may-30-multi-turn-agent/tickets/README.md
 * §공통금지사항) enumerates surfaces that must be GONE after the cutover. This
 * rail asserts they are absent in BOTH code (no symbol) and structure (no live
 * file). It is intentionally strict: a future re-introduction of any of these
 * fails here, not silently in production.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('multi-turn agent — banned legacy surfaces (T-MTA-07)', () => {
  it('removes the dead legacy /v1/agent query-contract route + contract files', () => {
    expect(existsSync(path.join(SRC, 'interface/http/routes/wine-search.route.ts'))).toBe(false);
    expect(existsSync(path.join(SRC, 'interface/http/routes/wine-search.contract.ts'))).toBe(false);
  });

  it('removes the route/facade single-`query` adapter from the canonical path', () => {
    const route = read('src/interface/http/routes/agent.route.ts');
    const localFacade = read('src/infrastructure/cli/local/local-agent-facade.ts');
    for (const src of [route, localFacade]) {
      expect(src).not.toContain('extractLatestUserMessage');
      expect(src).not.toContain('adaptAgentRunBodyToWineSearch');
    }
  });

  it('does NOT wire the process-local session store in the production container', () => {
    const container = read('src/config/container.ts');
    // The process-local store is a TEST SEAM ONLY — production wires SQLite.
    expect(container).not.toContain('createProcessLocalAgentSessionStore');
    expect(container).toContain('createSqliteAgentSessionStore');
  });

  it('purges external `wine-search` CLI facade/DTO naming', () => {
    const cliDirs = [
      path.join(SRC, 'application/cli'),
      path.join(SRC, 'infrastructure/cli'),
      path.join(SRC, 'interface/cli'),
    ];
    const bannedSymbols = [
      'WineSearchFacadePort',
      'LocalWineSearchFacade',
      'RemoteWineSearchFacade',
    ];
    const bannedPaths = [
      'cli/dto/wine-search.dto',
      'wine-search-facade.port',
      'local-wine-search-facade',
      'remote-wine-search-facade',
    ];
    for (const dir of cliDirs) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        for (const sym of bannedSymbols) {
          expect(src, `${file} must not reference ${sym}`).not.toContain(sym);
        }
        for (const p of bannedPaths) {
          expect(src, `${file} must not import ${p}`).not.toContain(p);
        }
      }
    }
  });

  it('the HTTP step cap is the same value as the orchestrator hard cap (SSoT, no drift)', () => {
    // The orchestrator clamp is the real runtime ceiling; the HTTP edge cap is
    // a defense-in-depth mirror. They must never diverge (rule 30).
    expect(MAX_AGENT_STEPS_CAP).toBe(AGENT_MAX_STEPS_HARD_CAP);
  });

  it('canonical single-shot front door is /v1/agent (no /v1/agent/run dual door)', () => {
    const route = read('src/interface/http/routes/agent.route.ts');
    expect(route).toContain("url: '/v1/agent'");
    expect(route).not.toContain("url: '/v1/agent/run'");
  });
});
