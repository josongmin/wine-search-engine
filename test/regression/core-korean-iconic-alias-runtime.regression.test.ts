import { beforeAll, describe, expect, it } from 'vitest';

import { buildAliasArtifact } from '../../scripts/etl/build-alias-artifact.js';
import { hasExactLikeLookupStrategy } from '../../src/domain/query/service/lookup-strategy-taxonomy.js';
import { SearchSnapshotAliasMatcher } from '../../src/infrastructure/adapter/search-snapshot-alias-matcher.js';
import {
  CORE_KOREAN_ICON_QUERY_CASES,
  loadCoreKoreanIconFixtureBundle,
} from '../support/core-korean-icon-fixtures.js';

let matcher: SearchSnapshotAliasMatcher;

beforeAll(async () => {
  const bundle = await loadCoreKoreanIconFixtureBundle();
  const aliasArtifact = buildAliasArtifact(bundle.runtimeRecords, bundle.entityIdBySourceId);
  matcher = new SearchSnapshotAliasMatcher(aliasArtifact);
});

function splitLookupStrategies(strategy: string | undefined): readonly string[] {
  if (strategy === undefined) {
    return [];
  }
  return strategy
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe('Core Korean iconic alias runtime', () => {
  it.each(CORE_KOREAN_ICON_QUERY_CASES)(
    'matches $query to $expectedEntityId through snapshot alias substrate',
    async ({ query, expectedEntityId }) => {
      const matches = await matcher.findMatches(query);

      expect(matches[0]?.entityIds).toContain(expectedEntityId);
      expect(hasExactLikeLookupStrategy(splitLookupStrategies(matches[0]?.lookupStrategy))).toBe(true);
      expect(matches[0]?.lookupStrategy).not.toContain('substring');
    },
  );
});
