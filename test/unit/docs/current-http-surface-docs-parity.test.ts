import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const deletedCurrentDocs = [
  'docs/test-reinforcement-roadmap.md',
  'docs/test-reinforcement-p0-tickets.md',
  'docs/test-reinforcement-parallel-board.md',
] as const;
const deletedFeatureCatalogEntries = [
  'tools/feature-catalog/features/agent/feedback-and-learning.yaml',
  'tools/feature-catalog/features/infra/watchlist-stack.yaml',
  'tools/feature-catalog/features/observability/openapi-export.yaml',
  'tools/feature-catalog/features/observability/retrieval-degradation-metrics.yaml',
  'tools/feature-catalog/features/tools/feedback.yaml',
  'tools/feature-catalog/features/tools/watchlist.yaml',
  'tools/feature-catalog/features/tools/web-feedback-widget.yaml',
  'tools/feature-catalog/features/tools/web-watchlist-ui.yaml',
] as const;
const removedSurfacePatterns = [
  /\/v1\/search(?!(?:\/(?:hybrid|semantic|lexical)\b|\/\{hybrid,semantic,lexical\}))/,
  /\/v1\/search\/lookup/,
  /\/v1\/search\/replay/,
  /\/v1\/search\/interpret/,
  /\/v1\/lookup\/wine['"]/,
  /\/v1\/entity\/resolve['"]/,
  /\/v1\/entity\/autocomplete['"]/,
  /\/v1\/feedback/,
  /\/v1\/watchlist/,
  /\/openapi\.json/,
  /\/metrics\/agent/,
  /\/metrics\/retrieval-degradation/,
] as const;

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function listFeatureCatalogFiles(relativeDir: string): string[] {
  const directory = path.join(workspaceRoot, relativeDir);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFeatureCatalogFiles(relativePath));
      continue;
    }
    if (entry.isFile()) {
      out.push(relativePath);
    }
  }

  return out.sort();
}

describe('current HTTP surface docs parity', () => {
  const readme = readWorkspaceFile('README.md');
  const contractSurface = readWorkspaceFile('docs/http-contract-surface.md');
  const abbreviationRunbook = readWorkspaceFile('docs/runbook-abbreviation-aliases.md');
  const calibrationRunbook = readWorkspaceFile('docs/runbook-calibration-nightly.md');
  const deployRunbook = readWorkspaceFile('docs/runbook-github-actions-aws-deploy.md');
  const agenticOverview = readWorkspaceFile('docs/system-overview/agentic-process.md');
  const doc2queryIntegration = readWorkspaceFile('docs/system-overview/doc2query-cohere-integration.md');
  const benchStatus = readWorkspaceFile('docs/bench/STATUS.md');
  const lookupPlan = readWorkspaceFile('docs/plans/jun-2-genearl/entity-lookup-v2/IMPROVEMENT-PLAN-2026-06-03.md');
  const lookupChecklist = readWorkspaceFile('docs/plans/jun-2-genearl/entity-lookup-v2/cutover-checklist.md');
  const lookupBuildStatus = readWorkspaceFile('docs/plans/jun-2-genearl/entity-lookup-v2/STATUS.md');
  const justfile = readWorkspaceFile('justfile');
  const featureCatalogFiles = listFeatureCatalogFiles('tools/feature-catalog/features');

  it('README does not advertise removed e2e suites or retired HTTP surfaces', () => {
    expect(readme).toContain('search-api.search.test.ts');
    expect(readme).toContain('wine-search-api.test.ts');
    expect(readme).not.toContain('search-api.secondary.test.ts');
    expect(readme).not.toContain('batch-search-api.test.ts');
    expect(readme).not.toContain('claude-tools-api.test.ts');
    expect(readme).not.toContain('`/v1/search/lookup`');
  });

  it('current runbooks point entity lookup and deploy examples at canonical paths', () => {
    // V2-only cutover: entity lookup is now POST /v2/entity-lookup.
    expect(abbreviationRunbook).toContain('/v2/entity-lookup');
    expect(abbreviationRunbook).toContain('runbook-curation-materialization.md');
    expect(abbreviationRunbook).not.toContain('/v1/lookup/wine');
    expect(abbreviationRunbook).not.toContain('/v1/search/lookup');

    expect(calibrationRunbook).toContain('/v2/entity-lookup');
    expect(calibrationRunbook).not.toContain('/v1/lookup/wine');
    expect(calibrationRunbook).not.toContain('/v1/search/lookup');

    expect(deployRunbook).toContain('https://asommguide.shop:9011/v1/search/hybrid');
    expect(deployRunbook).not.toContain('https://asommguide.shop:9011/v1/search\n');
  });

  it('system overview advertises only the canonical current search and agent surfaces', () => {
    expect(agenticOverview).toContain('`POST /v1/search/hybrid`');
    expect(agenticOverview).toContain('`POST /v1/search/semantic`');
    expect(agenticOverview).toContain('`POST /v1/search/lexical`');
    expect(agenticOverview).toContain('`POST /v2/entity-lookup`');
    expect(agenticOverview).not.toContain('`POST /v1/lookup/wine`');
    expect(agenticOverview).not.toContain('`POST /v1/entity/resolve`');
    expect(agenticOverview).not.toContain('`POST /v1/entity/autocomplete`');
    expect(agenticOverview).toContain('`POST /v1/agent`');
    expect(agenticOverview).not.toContain('| `POST /v1/search` |');
    expect(agenticOverview).not.toContain('| `POST /v1/search/interpret` |');
    expect(agenticOverview).not.toContain('| `POST /v2/search` |');
  });

  it('doc2query runtime notes point only at the current primitive search seam', () => {
    expect(doc2queryIntegration).toContain('/v1/search/{hybrid,semantic,lexical}');
    expect(doc2queryIntegration).not.toContain('HTTP /v1/search 또는');
  });

  it('HTTP contract surface doc uses repo-relative links and documents V2 lookup cutover', () => {
    expect(contractSurface).not.toContain('/Users/songmin/wine-search-engine');
    expect(contractSurface).toContain('POST /v2/entity-lookup');
    expect(contractSurface).toContain('published_awaiting_materialization');
    expect(contractSurface).toContain('legacy_approved_abbreviation_backlog');
    expect(contractSurface).toContain('lookup_runtime');
    expect(contractSurface).toContain('POST /v2/entity-lookup/ops/proposals/review');
    expect(contractSurface).toContain('POST /v2/entity-lookup/ops/proposals/publish');
    expect(contractSurface).toContain('POST /v2/entity-lookup/ops/inspect');
    expect(contractSurface).not.toMatch(/\/v1\/entity\/resolve['"]/);
  });

  it('HTTP contract surface doc no longer references removed OpenAPI bridge or replay routes', () => {
    expect(contractSurface).toContain('pnpm run contracts:http -- data/http-contract-manifest.json');
    expect(contractSurface).not.toContain('contracts:http:openapi-bridge');
    expect(contractSurface).not.toContain('export-http-openapi-bridge.ts');
    expect(contractSurface).not.toContain('http-route-contract-openapi.ts');
    expect(contractSurface).not.toContain('/v1/search/replay');
  });

  it('lookup authority current docs and archive docs are clearly separated', () => {
    expect(benchStatus).toContain('이 폴더의 current SSOT는 이 문서다.');
    expect(benchStatus).not.toContain('lookup authority 품질 판단은 `docs/plans/jun-2-genearl/entity-lookup-v2/cutover-checklist.md`');
    expect(lookupPlan).toContain('Historical / audit-only document.');
    expect(lookupChecklist).toContain('Historical / audit-only document.');
    expect(lookupBuildStatus).toContain('Current authority truth moved to `docs/bench/STATUS.md`');
  });

  it('developer smoke commands point at the canonical hybrid path', () => {
    expect(justfile).toContain('http://localhost:4000/v1/search/hybrid');
    expect(justfile).not.toContain('http://localhost:4000/v1/search \\');
  });

  it('stale current docs and removed feature catalog entries are physically absent', () => {
    for (const relativePath of deletedCurrentDocs) {
      expect(fs.existsSync(path.join(workspaceRoot, relativePath))).toBe(false);
    }
    for (const relativePath of deletedFeatureCatalogEntries) {
      expect(fs.existsSync(path.join(workspaceRoot, relativePath))).toBe(false);
    }
  });

  it('known-issues cutover triage doc is marked superseded', () => {
    const knownIssues = readWorkspaceFile('docs/known-issues-cutover-blockers.md');
    expect(knownIssues).toContain('Status: superseded');
  });

  it('eval-only search rails are documented as query runners, not live use-case classes', () => {
    const batchSearchDoc = readWorkspaceFile('docs/batch-search.md');
    expect(batchSearchDoc).toContain('buildBatchSearchRunner');
    expect(batchSearchDoc).not.toContain('BatchSearchUseCase');
  });

  it('current feature catalog does not advertise removed HTTP surfaces', () => {
    for (const relativePath of featureCatalogFiles) {
      const content = readWorkspaceFile(relativePath);
      for (const pattern of removedSurfacePatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});
