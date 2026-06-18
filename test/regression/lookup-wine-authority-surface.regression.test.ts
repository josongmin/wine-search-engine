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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

  it('legacy resolve/autocomplete HTTP routes and resolve.route.ts stay removed', () => {
    for (const deadRoute of [
      'src/interface/http/routes/resolve.route.ts',
      'src/interface/http/routes/autocomplete.route.ts',
      'src/interface/http/routes/interpret.route.ts',
      'src/interface/http/routes/batch-search.route.ts',
      'src/interface/http/routes/hybrid.route.ts',
      'src/interface/http/routes/replay.route.ts',
    ] as const) {
      expect(existsSync(join(process.cwd(), deadRoute)), deadRoute).toBe(false);
    }
    expect(existsSync(join(process.cwd(), 'src/application/search/resolve.usecase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'test/unit/application/search/resolve.usecase.test.ts'))).toBe(false);
    const server = read('src/interface/http/server.ts');
    expect(server).not.toContain('registerResolveRoute');
    expect(server).not.toContain('registerAutocompleteRoute');
    expect(server).toContain('registerEntityLookupV2Route');
    const catalog = read('src/interface/http/routes/http-route-contract-catalog.ts');
    expect(catalog).not.toContain("'/v1/entity/resolve'");
    expect(catalog).not.toContain("'/v1/entity/autocomplete'");
  });

  it('production Container does not wire autocompleteUseCase (eval-only query runner factory)', () => {
    const containerTs = read('src/config/container.ts');
    expect(containerTs).not.toContain('autocompleteUseCase');
    expect(existsSync(join(process.cwd(), 'src/config/build-autocomplete-query-runner.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'src/config/build-autocomplete-usecase.ts'))).toBe(false);
    const usecases = read('src/config/container-usecases.ts');
    expect(usecases).not.toContain('AutocompleteUseCase');
  });

  it('production Container exposes only live HTTP/agent search surfaces (no dead use-case ports)', () => {
    const containerTs = read('src/config/container.ts');
    for (const deadPort of [
      'interpretUseCase',
      'hybridUseCase',
      'batchSearchUseCase',
      'decomposedSearchUseCase',
      'drinkingWindowUseCase',
    ] as const) {
      expect(containerTs).not.toContain(deadPort);
    }
    expect(containerTs).toContain('searchUseCase');
    expect(containerTs).toContain('entityLookupV2UseCase');
  });

  it('InterpretUseCase class is deleted (eval-only interpret-query-runner remains)', () => {
    expect(existsSync(join(process.cwd(), 'src/application/search/interpret.usecase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/config/build-interpret-query-runner.ts'))).toBe(true);
    const port = read('src/application/search/port/search-route-usecases.port.ts');
    expect(port).not.toContain('InterpretUseCasePort');
  });

  it('AutocompleteUseCase class is deleted (eval-only autocomplete-query-runner remains)', () => {
    expect(existsSync(join(process.cwd(), 'src/application/search/autocomplete.usecase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/config/build-autocomplete-query-runner.ts'))).toBe(true);
    const port = read('src/application/search/port/search-route-usecases.port.ts');
    expect(port).not.toContain('AutocompleteUseCasePort');
  });

  it('BatchSearchUseCase class is deleted (eval-only batch-search-runner remains)', () => {
    expect(existsSync(join(process.cwd(), 'src/application/search/batch-search.usecase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/config/build-batch-search-runner.ts'))).toBe(true);
    const port = read('src/application/search/port/search-route-usecases.port.ts');
    expect(port).not.toContain('BatchSearchUseCasePort');
  });

  it('HybridUseCase duplicate stack is deleted (POST /v1/search/hybrid uses SearchUseCase only)', () => {
    expect(existsSync(join(process.cwd(), 'src/application/search/hybrid.usecase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/application/search/hybrid-request.dto.ts'))).toBe(false);
    const port = read('src/application/search/port/search-route-usecases.port.ts');
    expect(port).not.toContain('HybridUseCasePort');
  });

  it('dead eval-only use case classes are not re-instantiated under src/ (non-test paths)', () => {
    const forbidden = [
      'new AutocompleteUseCase(',
      'new BatchSearchUseCase(',
      'new InterpretUseCase(',
      'new HybridUseCase(',
    ] as const;
    const roots = [
      'src/application/search',
      'src/config',
      'src/interface/http',
    ] as const;

    function walk(dir: string): string[] {
      const entries = readdirSync(join(process.cwd(), dir), { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') {
            continue;
          }
          files.push(...walk(rel));
          continue;
        }
        if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(rel);
        }
      }
      return files;
    }

    for (const root of roots) {
      for (const file of walk(root)) {
        const content = read(file);
        for (const needle of forbidden) {
          expect(content, `${file} must not contain ${needle}`).not.toContain(needle);
        }
      }
    }
  });

  it('feature catalog and debug docs do not claim legacy resolve HTTP harness remains', () => {
    const elv2Catalog = read('tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml');
    expect(elv2Catalog).not.toMatch(/regression harness/i);
    expect(elv2Catalog).not.toMatch(/exists only as a regression/i);
    expect(elv2Catalog).not.toMatch(/is regression harness/i);
    const playbook = read('.ai/llm-debugging-playbook.md');
    expect(playbook).not.toContain('resolve.use_case.start');
    expect(playbook).toContain('entity_lookup_v2.use_case.start');
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

  it('cutover docs mark stale e2e triage as superseded and eval rails use query runners', () => {
    const knownIssues = read('docs/known-issues-cutover-blockers.md');
    expect(knownIssues).toContain('Status: superseded');
    expect(knownIssues).toContain('POST /v1/search/interpret');

    const batchSearchDoc = read('docs/batch-search.md');
    expect(batchSearchDoc).toContain('buildBatchSearchRunner');
    expect(batchSearchDoc).not.toContain('BatchSearchUseCase');

    const autocompleteCatalog = read('tools/feature-catalog/features/tools/autocomplete.yaml');
    expect(autocompleteCatalog).toContain('status: deprecated');
    expect(autocompleteCatalog).toContain('autocomplete-query-runner.ts');
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
