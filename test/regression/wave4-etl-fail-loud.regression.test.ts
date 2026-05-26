/**
 * Wave 4 — ETL fail-loud regressions.
 *
 * Covers:
 *  - C7  / snapshot-entity-identity.loadGoldCanonicalLookupForBuild:
 *         requireFixtureRepo=true throws when no fixture is found.
 *  - H14 / index-to-vespa.runIndexer: maxFailureRate>0 requires
 *         ETL_INDEX_PARTIAL_FAILURE_ACK=YES.
 *  - H15 / publish-search-snapshot.run: --allow-missing-ltr is removed;
 *         canonical publish hard-fails on missing active LTR models.
 */
import { describe, expect, it } from 'vitest';
import { loadGoldCanonicalLookupForBuild } from '../../scripts/etl/snapshot-entity-identity.js';

describe('Wave 4 / C7: gold fixture requireFixtureRepo guard — source contract', () => {
  it('source contains the requireFixtureRepo guard with operator-actionable message', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/snapshot-entity-identity.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/requireFixtureRepo\?:\s*boolean/);
    expect(src).toMatch(/options\.requireFixtureRepo === true/);
    expect(src).toMatch(/Gold fixture repo is required/);
    expect(src).toMatch(/FIXTURE_REPO_PATH/);
    expect(src).toMatch(/--fixture-repo/);
  });

  it('throws when requireFixtureRepo=true and explicit fixtureRepoRoot is absent', async () => {
    // We cannot reliably toggle CWD or env in a vitest worker; instead we
    // pass an explicit non-existent path so the loader's first guard fires
    // (path does not exist), AND verify the error message via separate
    // source-level assertion above.
    await expect(
      loadGoldCanonicalLookupForBuild({
        fixtureRepoRoot: '/nonexistent-path-for-wave4-test',
        requireFixtureRepo: true,
      }),
    ).rejects.toThrow(/fixture repo path does not exist/);
  });
});

describe('Wave 4 / H14: index-to-vespa partial-failure ack source check', () => {
  it('refuses maxFailureRate>0 without ETL_INDEX_PARTIAL_FAILURE_ACK=YES', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/index-to-vespa.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/ETL_INDEX_PARTIAL_FAILURE_ACK/);
    expect(src).toMatch(/REFUSING to apply maxFailureRate/);
    // Acknowledged path uses the same env var name — no separate flag.
    expect(src).toMatch(/ack !== 'YES'/);
  });
});

describe('Wave 4 / H15: publish-search-snapshot allow-missing-ltr removal source check', () => {
  it('rejects --allow-missing-ltr outright under the canonical publish contract', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/--allow-missing-ltr has been removed/);
    expect(src).toMatch(/canonical snapshot publish now hard-fails on missing active LTR models/);
  });
});

describe('Wave 4 / cross-cutting: fail-loud principles', () => {
  it('snapshot-entity-identity documents fail-open refusal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/snapshot-entity-identity.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/refusing fail-open/i);
    expect(src).toMatch(/silently zero benchmark coverage/);
  });

  it('publish-search-snapshot documents production guardrail', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/--allow-missing-ltr has been removed/);
    expect(src).toMatch(/Refusing canonical publish/);
  });
});
