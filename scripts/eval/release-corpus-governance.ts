import type { GoldenQuery } from '../etl/types.js';
import {
  hasExactEntityVintageToken,
  inferGoldenQueryLanguage,
} from './golden-query-corpus-contract.js';

export interface ReleaseCorpusGovernanceSummary {
  readonly queryCount: number;
  readonly labelTierMix: Readonly<Record<string, number>>;
  readonly sliceMix: Readonly<Record<string, number>>;
  readonly queryClassMix: Readonly<Record<string, number>>;
  readonly languageMix: Readonly<Record<string, number>>;
  readonly entityShareTop: readonly {
    readonly entityId: string;
    readonly count: number;
    readonly share: number;
  }[];
}

export interface ReleaseCorpusGovernanceOptions {
  readonly entityCapShare?: number;
  readonly disallowBronze?: boolean;
}

function summarizeQuerySurfaceLanguageDrift(queries: readonly GoldenQuery[]) {
  return queries.flatMap((query) => {
    const inferredLanguage = inferGoldenQueryLanguage(query.query);
    if (query.language === inferredLanguage) {
      return [];
    }
    return [{
      qid: query.qid,
      query: query.query,
      declaredLanguage: query.language,
      inferredLanguage,
    }];
  });
}

function summarizeExactEntityVintageViolations(queries: readonly GoldenQuery[]) {
  return queries.filter((query) =>
    query.query_class === 'exact_entity'
    && !hasExactEntityVintageToken(query.query),
  );
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeEntityShare(queries: readonly GoldenQuery[]) {
  const counts = new Map<string, number>();
  for (const query of queries) {
    const entityId = query.decision_labels.expected_entity_id ?? query.leakage_keys.entity_id;
    if (entityId === undefined || entityId.length === 0) continue;
    counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
  }
  const total = Math.max(1, queries.length);
  return [...counts.entries()]
    .map(([entityId, count]) => ({
      entityId,
      count,
      share: count / total,
    }))
    .sort((left, right) => right.share - left.share || left.entityId.localeCompare(right.entityId));
}

export function summarizeReleaseCorpusGovernance(
  queries: readonly GoldenQuery[],
): ReleaseCorpusGovernanceSummary {
  return {
    queryCount: queries.length,
    labelTierMix: countBy(queries.map((query) => query.annotation_tier)),
    sliceMix: countBy(queries.map((query) => query.scenario)),
    queryClassMix: countBy(queries.map((query) => query.query_class)),
    languageMix: countBy(queries.map((query) => query.language)),
    entityShareTop: summarizeEntityShare(queries).slice(0, 10),
  };
}

export function validateReleaseCorpusGovernance(
  queries: readonly GoldenQuery[],
  options: ReleaseCorpusGovernanceOptions = {},
): ReleaseCorpusGovernanceSummary {
  const summary = summarizeReleaseCorpusGovernance(queries);
  const entityCapShare = options.entityCapShare ?? 0.03;
  const disallowBronze = options.disallowBronze ?? true;
  const violations: string[] = [];

  if (queries.length === 0) {
    violations.push('release corpus is empty');
  }

  if (disallowBronze) {
    const bronzeCount = queries.filter((query) => query.annotation_tier === 'bronze').length;
    if (bronzeCount > 0) {
      violations.push(`release corpus contains bronze-tier rows (${bronzeCount}/${queries.length})`);
    }
  }

  const overCap = summary.entityShareTop.filter((entry) => entry.share > entityCapShare);
  if (overCap.length > 0) {
    violations.push(
      `entity cap exceeded: ${overCap
        .map((entry) => `${entry.entityId} ${(entry.share * 100).toFixed(2)}% (${entry.count}/${summary.queryCount})`)
        .join(', ')}`,
    );
  }

  const languageDrift = summarizeQuerySurfaceLanguageDrift(queries);
  if (languageDrift.length > 0) {
    violations.push(
      `query language labels drift from query surface: ${languageDrift
        .slice(0, 10)
        .map((entry) => `${entry.qid} declared=${entry.declaredLanguage} inferred=${entry.inferredLanguage} query="${entry.query}"`)
        .join(', ')}${languageDrift.length > 10 ? ` (+${languageDrift.length - 10} more)` : ''}`,
    );
  }

  const exactEntityVintageViolations = summarizeExactEntityVintageViolations(queries);
  if (exactEntityVintageViolations.length > 0) {
    violations.push(
      `exact_entity rows missing vintage token: ${exactEntityVintageViolations
        .slice(0, 10)
        .map((query) => `${query.qid} "${query.query}"`)
        .join(', ')}${exactEntityVintageViolations.length > 10 ? ` (+${exactEntityVintageViolations.length - 10} more)` : ''}`,
    );
  }

  if (violations.length > 0) {
    throw new Error(`Release corpus governance failed:\n- ${violations.join('\n- ')}`);
  }

  return summary;
}
