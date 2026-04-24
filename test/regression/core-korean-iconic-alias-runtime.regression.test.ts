import { beforeAll, describe, expect, it } from 'vitest';

import { buildAliasArtifact } from '../../scripts/etl/build-alias-artifact.js';
import type { AliasSnapshotRecord } from '../../scripts/etl/search-snapshot-schema.js';
import { hasExactLikeLookupStrategy } from '../../src/domain/query/service/lookup-strategy-taxonomy.js';
import { buildNormalizedQueryViews } from '../../src/domain/query/service/query-normalizer.js';
import { SearchSnapshotAliasMatcher } from '../../src/infrastructure/adapter/search-snapshot-alias-matcher.js';
import type { EnrichedSilverRecord } from '../../scripts/etl/types.js';
import type { EntityId, SourceRecordId } from '../../src/domain/shared/types/index.js';
import {
  CORE_KOREAN_ICON_AMBIGUITY_CASES,
  CORE_KOREAN_ICON_QUERY_CASES,
  loadCoreKoreanIconFixtureBundle,
} from '../support/core-korean-icon-fixtures.js';

let matcher: SearchSnapshotAliasMatcher;
let aliasArtifact: readonly AliasSnapshotRecord[];
let runtimeRecords: readonly EnrichedSilverRecord[];
let entityIdBySourceId: ReadonlyMap<SourceRecordId, EntityId>;

beforeAll(async () => {
  const bundle = await loadCoreKoreanIconFixtureBundle();
  aliasArtifact = buildAliasArtifact(bundle.runtimeRecords, bundle.entityIdBySourceId);
  runtimeRecords = bundle.runtimeRecords;
  entityIdBySourceId = bundle.entityIdBySourceId;
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

function normalizeSurface(value: string): string {
  return buildNormalizedQueryViews(value).strict;
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

  it.each(CORE_KOREAN_ICON_AMBIGUITY_CASES.filter(
    (testCase) => testCase.forbiddenResolvedEntityId !== undefined,
  ))(
    'keeps ambiguous surface $query out of identity-safe alias projections',
    async ({ query, forbiddenResolvedEntityId }) => {
      const unsafeSurface = normalizeSurface(query);
      const record = runtimeRecords.find((candidate) =>
        entityIdBySourceId.get(candidate.sourceId) === forbiddenResolvedEntityId
      );

      expect(record).toBeDefined();

      const unsafeProjectionValues = [
        ...(record?.aliases.identitySafeProjection ?? []),
        ...(record?.aliases.proposed.map((proposal) => proposal.value) ?? []),
      ].map(normalizeSurface);
      const exactUnsafeArtifactRows = aliasArtifact.filter((row) =>
        row.entityId === forbiddenResolvedEntityId
        && normalizeSurface(row.value) === unsafeSurface
      );

      expect(unsafeProjectionValues).not.toContain(unsafeSurface);
      expect(exactUnsafeArtifactRows).toHaveLength(0);
    },
  );
});
