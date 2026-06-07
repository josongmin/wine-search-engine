/**
 * V2-only lookup cutover guard (replaces the former compatibility-seam rail).
 *
 * The breaking V2-only cutover removed `POST /v1/lookup/wine`, the
 * `LookupWineV2CompatibilityUseCase`, `lookupAuthorityMode`, and the
 * `primitiveRoute: 'lookup_wine'` SearchUseCase arm. EntityLookupV2
 * (`POST /v2/entity-lookup`) is now the sole lookup authority across HTTP, CLI,
 * and the agent.
 *
 * This rail fails closed if any of the removed surfaces reappear — a structural
 * tripwire against silent re-introduction of the dual-authority split.
 *
 * Append-only intent preserved: the guard still exists, now asserting the
 * post-cutover invariant (absence) instead of the pre-cutover seam.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('V2-only lookup cutover — removed surfaces stay removed', () => {
  it('the LookupWineV2Compatibility use case file is deleted', () => {
    expect(existsSync(join(process.cwd(), 'src/application/search/lookup-wine-v2-compatibility.usecase.ts'))).toBe(false);
  });

  it('SearchUseCase no longer carries a lookup_wine arm or lookupAuthorityMode', () => {
    const usecase = read('src/application/search/search.usecase.ts');
    expect(usecase).not.toContain('lookupWineV2CompatibilityUseCase');
    expect(usecase).not.toContain('lookupAuthorityMode');
    const executorPort = read('src/application/search/port/search-executor.port.ts');
    expect(executorPort).not.toContain('lookupAuthorityMode');
  });

  it('SearchRequest.primitiveRoute no longer admits lookup_wine (similar_to_entity only)', () => {
    const dto = read('src/application/search/search-request.dto.ts');
    expect(dto).not.toContain("'lookup_wine'");
    expect(dto).toContain("'similar_to_entity'");
  });

  it('the public HTTP lookup surface is /v2/entity-lookup only (no /v1/lookup/wine route)', () => {
    const catalog = read('src/interface/http/routes/http-route-contract-catalog.ts');
    expect(catalog).not.toContain("'/v1/lookup/wine'");
    expect(catalog).toContain("'/v2/entity-lookup'");
  });

  it('the CLI lookup command dispatches the dedicated V2 lookup facade', () => {
    const cmd = read('src/application/cli/command/lookup/wine.command.ts');
    expect(cmd).toContain('facades.lookup.lookupWine');
    expect(cmd).not.toContain('facades.search.lookupWine');
  });

  it('the agent dispatches lookup_wine to the dedicated V2 lookup port', () => {
    const loop = read('src/application/wine-search/wine-agent-loop.ts');
    expect(loop).toContain('ports.lookupWine.execute');
    expect(loop).not.toContain("primitiveRoute: 'lookup_wine'");
  });

  it('the lookup coverage runner uses the same PG-backed V2 authority substrate as the authority rail', () => {
    const coverage = read('scripts/eval/run-lookup-v2-coverage-report.ts');
    expect(coverage).toContain("import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';");
    expect(coverage).toContain("import { createLookupDirectContainer } from '../../src/config/container-lookup.js';");
    expect(coverage).toContain('const pool = getPgPool();');
    expect(coverage).toContain('const container = await createLookupDirectContainer(config, {');
    expect(coverage).toContain('await pool.end();');
  });

  it('lookup eval/debug runners route through the shared authority builders only', () => {
    const authority = read('scripts/eval/run-entity-resolution-validation.ts');
    const parity = read('scripts/eval/run-lookup-v2-parity.ts');
    const latency = read('scripts/eval/run-lookup-v2-latency-korean-famous.ts');
    const canary = read('scripts/eval/run-lookup-v2-canary-replay.ts');
    const debug = read('scripts/eval/debug-one-lookup.ts');
    for (const script of [authority, latency, canary, debug]) {
      expect(script).toContain("createLookupDirectContainer");
      expect(script).not.toContain('createContainer(config');
    }
    expect(parity).toContain('createLookupDirectContainer');
    expect(parity).toContain('createContainer(config');
  });
});
