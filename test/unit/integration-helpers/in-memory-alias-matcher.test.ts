/**
 * Guards the in-memory matcher's alias-type emission contract.
 *
 * The matcher MUST attach `AliasMatchResult.aliasType` based on entry
 * provenance so the resolver scorer can apply type-specific caps without
 * inferring from `lookupStrategy` strings. Mixed-provenance buckets resolve
 * via the higher-trust-wins picker (canonical beats derived_initialism).
 */
import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { InMemoryAliasMatcher } from '../../integration/helpers/in-memory-adapters.js';

describe('InMemoryAliasMatcher — aliasType emission', () => {
  it('curated entry yields aliasType=canonical on exact match', async () => {
    const matcher = new InMemoryAliasMatcher();
    matcher.addAlias('Opus One', createEntityId('opus-one-2018'), 0.97, 'curated');

    const matches = await matcher.findMatches('opus one');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.lookupStrategy).toBe('exact');
    expect(matches[0]?.aliasType).toBe('canonical');
  });

  it('derived_initialism entry yields aliasType=derived_initialism on exact match', async () => {
    const matcher = new InMemoryAliasMatcher();
    matcher.addAlias('CM', createEntityId('chateau-margaux-2015'), 0.5, 'derived_initialism');

    const matches = await matcher.findMatches('cm');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.lookupStrategy).toBe('exact');
    expect(matches[0]?.aliasType).toBe('derived_initialism');
  });

  it('mixed-provenance bucket under the same normalized key picks higher-trust type', async () => {
    // Edge case: two entries share the normalized form (e.g. a hand-authored
    // 'CM' for one entity and a derived 'CM' for another). The emitted
    // aliasType is the higher-trust one — canonical — so the resolver
    // scorer doesn't engage the derived-initialism cap when curated
    // evidence is present.
    const matcher = new InMemoryAliasMatcher();
    matcher.addAlias('CM', createEntityId('curated-entity'), 0.95, 'curated');
    matcher.addAlias('CM', createEntityId('derived-entity'), 0.5, 'derived_initialism');

    const matches = await matcher.findMatches('cm');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.aliasType).toBe('canonical');
    // Both entities surface — caller can still inspect both via entityIds.
    expect(matches[0]?.entityIds).toHaveLength(2);
  });

  it('aliasType propagates through compact_exact match path', async () => {
    const matcher = new InMemoryAliasMatcher();
    matcher.addAlias('Chateau Margaux', createEntityId('chateau-margaux-2015'), 0.94, 'curated');

    // Compact strips spaces/punct → 'chateaumargaux' should still find the alias.
    const matches = await matcher.findMatches('chateaumargaux');
    const compact = matches.find((m) => m.lookupStrategy === 'compact_exact');
    expect(compact).toBeDefined();
    expect(compact?.aliasType).toBe('canonical');
  });

  it('aliasType propagates through genuine prefix_exact match path', async () => {
    const matcher = new InMemoryAliasMatcher();
    matcher.addAlias('Opus One', createEntityId('opus-one-2018'), 0.97, 'curated');
    matcher.addAlias('OO', createEntityId('opus-one-2018'), 0.5, 'derived_initialism');

    // Query 'opu' is an incomplete prefix and stays eligible for prefix_exact.
    const matches = await matcher.findMatches('opu');
    const types = matches.map((m) => m.aliasType).filter(Boolean);
    expect(types).toContain('canonical');
  });
});
