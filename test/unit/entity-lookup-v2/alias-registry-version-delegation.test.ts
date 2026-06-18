import { describe, expect, it } from 'vitest';
import { CachedAliasMatcher } from '../../../src/infrastructure/adapter/cached-alias-matcher.js';
import { CascadingAliasMatcher } from '../../../src/infrastructure/adapter/search-index-alias-matcher.js';
import { buildAliasRegistryVersion } from '../../../src/domain/alias/model/alias-registry-version.js';
import type { AliasMatcher, AliasMatchResult } from '../../../src/domain/query/service/anchor-extractor.js';
import type { AliasRegistryVersion } from '../../../src/domain/alias/model/alias-registry-version.js';

/**
 * T-ELV2-03 dead-foundation guard: core.aliasMatcher on the V2 path is ALWAYS a
 * CachedAliasMatcher (and a CascadingAliasMatcher on the PG-overlay chain). If
 * either decorator fails to delegate getRegistryVersion, the V2 response stamp
 * silently vanishes. This pins the delegation through the wrappers.
 */
class FakeMatcher implements AliasMatcher {
  constructor(private readonly version: AliasRegistryVersion | undefined) {}
  async findMatches(): Promise<readonly AliasMatchResult[]> { return []; }
  getRegistryVersion(): AliasRegistryVersion | undefined { return this.version; }
}

class VersionlessMatcher implements AliasMatcher {
  async findMatches(): Promise<readonly AliasMatchResult[]> { return []; }
}

const snapshotVersion = buildAliasRegistryVersion({ source: 'snapshot_manifest', aliasCount: 3, snapshotId: 's1' });

describe('alias-registry version decorator delegation', () => {
  it('CachedAliasMatcher delegates getRegistryVersion to its inner', () => {
    const cached = new CachedAliasMatcher(new FakeMatcher(snapshotVersion));
    expect(cached.getRegistryVersion()).toEqual(snapshotVersion);
  });

  it('CachedAliasMatcher returns undefined when the inner has none', () => {
    const cached = new CachedAliasMatcher(new VersionlessMatcher());
    expect(cached.getRegistryVersion()).toBeUndefined();
  });

  it('CascadingAliasMatcher delegates to its PRIMARY (overlay chain), not the secondary', () => {
    const cascading = new CascadingAliasMatcher(
      new FakeMatcher(snapshotVersion),
      new FakeMatcher(buildAliasRegistryVersion({ source: 'search_index', aliasCount: 0 })),
    );
    expect(cascading.getRegistryVersion()?.source).toBe('snapshot_manifest');
  });

  it('full overlay chain CachedAliasMatcher(Cascading(snapshot, index)) surfaces the snapshot version', () => {
    const chain = new CachedAliasMatcher(
      new CascadingAliasMatcher(new FakeMatcher(snapshotVersion), new VersionlessMatcher()),
    );
    expect(chain.getRegistryVersion()).toEqual(snapshotVersion);
  });
});
