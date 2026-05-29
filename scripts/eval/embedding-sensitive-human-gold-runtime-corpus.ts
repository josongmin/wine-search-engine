import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { GoldenQuery } from '../etl/types.js';

const HumanGoldCatalogRowSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
}).strip();

export const DEFAULT_HUMAN_GOLD_CATALOG_PATH = path.resolve(
  process.cwd(),
  'data/gold-wine-catalog.jsonl',
);

const COVERAGE_ERROR_SAMPLE_LIMIT = 5;

type HumanGoldMatchAuthority =
  | 'direct_public_id'
  | 'strip_benchmark_prefix'
  | 'exact_canonical_label';

interface HumanGoldCatalogRow {
  readonly benchmarkId: string;
  readonly canonicalLabel: string;
  readonly strippedRuntimeId?: string | undefined;
}

interface HumanGoldRuntimeMatchRow {
  readonly benchmark_id: string;
  readonly entity_id: string;
  readonly match_authority: HumanGoldMatchAuthority;
  readonly precedence: number;
}

export interface HumanGoldRuntimeCoverageResolution {
  readonly resolvedIds: ReadonlyMap<string, string>;
  readonly matchedAuthorities: ReadonlyMap<string, HumanGoldMatchAuthority>;
  readonly missingBenchmarkIds: readonly string[];
}

export interface HumanGoldRuntimeCoverageSummary {
  readonly snapshotId: string;
  readonly benchmarkIdCount: number;
  readonly mappedBenchmarkIdCount: number;
  readonly totalQueryCount: number;
  readonly fullyCoveredQueryCount: number;
  readonly missingBenchmarkIds: readonly string[];
  readonly uncoveredQueries: readonly {
    readonly qid: string;
    readonly missingEntityIds: readonly string[];
  }[];
  readonly authorityCounts: Readonly<Record<HumanGoldMatchAuthority, number>>;
}

function stripBenchmarkPrefix(entityId: string): string | undefined {
  return entityId.startsWith('w-') && entityId.length > 2
    ? entityId.slice(2)
    : undefined;
}

function collectQueryEntityIds(query: GoldenQuery): readonly string[] {
  const ids = query.retrieval_labels.relevant.map((relevant) => relevant.entity_id);
  if (query.decision_labels.expected_entity_id !== undefined) {
    ids.push(query.decision_labels.expected_entity_id);
  }
  ids.push(query.leakage_keys.entity_id);
  return ids;
}

export async function loadHumanGoldCatalogLookup(
  catalogPath: string = DEFAULT_HUMAN_GOLD_CATALOG_PATH,
): Promise<ReadonlyMap<string, { readonly canonicalLabel: string }>> {
  const raw = await fs.readFile(catalogPath, 'utf8');
  const lookup = new Map<string, { readonly canonicalLabel: string }>();
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = HumanGoldCatalogRowSchema.parse(JSON.parse(trimmed) as unknown);
    if (lookup.has(parsed.entityId)) {
      throw new Error(
        `embedding-sensitive human-gold catalog duplicates entityId ${parsed.entityId} at ${catalogPath}:${index + 1}`,
      );
    }
    lookup.set(parsed.entityId, { canonicalLabel: parsed.canonicalLabel });
  }
  return lookup;
}

export function collectHumanGoldCatalogRows(args: {
  readonly queries: readonly GoldenQuery[];
  readonly catalogLookup: ReadonlyMap<string, { readonly canonicalLabel: string }>;
}): readonly HumanGoldCatalogRow[] {
  const rows = new Map<string, HumanGoldCatalogRow>();
  for (const query of args.queries) {
    for (const entityId of collectQueryEntityIds(query)) {
      if (rows.has(entityId)) {
        continue;
      }
      const catalogRow = args.catalogLookup.get(entityId);
      if (catalogRow === undefined) {
        throw new Error(
          `embedding-sensitive human-gold catalog is missing ${entityId} referenced by ${query.qid}`,
        );
      }
      rows.set(entityId, {
        benchmarkId: entityId,
        canonicalLabel: catalogRow.canonicalLabel,
        strippedRuntimeId: stripBenchmarkPrefix(entityId),
      });
    }
  }
  return [...rows.values()].sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId));
}

export async function resolveHumanGoldRuntimeEntityIds(
  queryable: Pick<Pool, 'query'>,
  snapshotId: string,
  catalogRows: readonly HumanGoldCatalogRow[],
): Promise<HumanGoldRuntimeCoverageResolution> {
  if (catalogRows.length === 0) {
    return {
      resolvedIds: new Map(),
      matchedAuthorities: new Map(),
      missingBenchmarkIds: [],
    };
  }

  const result = await queryable.query<HumanGoldRuntimeMatchRow>(
    `WITH requested AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS rows(
           benchmark_id text,
           canonical_label text,
           stripped_runtime_id text
         )
     )
     SELECT
       benchmark_id,
       entity_id,
       match_authority,
       precedence
     FROM (
       SELECT
         r.benchmark_id,
         e.entity_id,
         'direct_public_id'::text AS match_authority,
         1 AS precedence
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
        AND e.entity_id = r.benchmark_id

       UNION ALL

       SELECT
         r.benchmark_id,
         e.entity_id,
         'strip_benchmark_prefix'::text AS match_authority,
         2 AS precedence
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
        AND r.stripped_runtime_id IS NOT NULL
        AND e.entity_id = r.stripped_runtime_id

       UNION ALL

       SELECT
         r.benchmark_id,
         e.entity_id,
         'exact_canonical_label'::text AS match_authority,
         3 AS precedence
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
        AND e.canonical_label = r.canonical_label
     ) matches
     ORDER BY benchmark_id ASC, precedence ASC, entity_id ASC`,
    [
      snapshotId,
      JSON.stringify(
        catalogRows.map((row) => ({
          benchmark_id: row.benchmarkId,
          canonical_label: row.canonicalLabel,
          stripped_runtime_id: row.strippedRuntimeId ?? null,
        })),
      ),
    ],
  );

  const matchedRowsByBenchmarkId = new Map<string, HumanGoldRuntimeMatchRow[]>();
  for (const row of result.rows) {
    const existing = matchedRowsByBenchmarkId.get(row.benchmark_id);
    if (existing === undefined) {
      matchedRowsByBenchmarkId.set(row.benchmark_id, [row]);
      continue;
    }
    matchedRowsByBenchmarkId.set(row.benchmark_id, [...existing, row]);
  }

  const resolvedIds = new Map<string, string>();
  const matchedAuthorities = new Map<string, HumanGoldMatchAuthority>();
  for (const catalogRow of catalogRows) {
    const matches = matchedRowsByBenchmarkId.get(catalogRow.benchmarkId) ?? [];
    const distinctEntityIds = [...new Set(matches.map((match) => match.entity_id))];
    if (distinctEntityIds.length > 1) {
      throw new Error(
        `embedding-sensitive human-gold benchmark id ${catalogRow.benchmarkId} maps to multiple runtime entity ids in snapshot ${snapshotId}: ${distinctEntityIds.join(', ')}`,
      );
    }
    const chosen = matches[0];
    if (chosen === undefined) {
      continue;
    }
    resolvedIds.set(catalogRow.benchmarkId, chosen.entity_id);
    matchedAuthorities.set(catalogRow.benchmarkId, chosen.match_authority);
  }

  const missingBenchmarkIds = catalogRows
    .map((row) => row.benchmarkId)
    .filter((benchmarkId) => !resolvedIds.has(benchmarkId));

  return {
    resolvedIds,
    matchedAuthorities,
    missingBenchmarkIds,
  };
}

export function summarizeHumanGoldRuntimeCoverage(args: {
  readonly queries: readonly GoldenQuery[];
  readonly snapshotId: string;
  readonly resolution: HumanGoldRuntimeCoverageResolution;
}): HumanGoldRuntimeCoverageSummary {
  const authorityCounts: Record<HumanGoldMatchAuthority, number> = {
    direct_public_id: 0,
    strip_benchmark_prefix: 0,
    exact_canonical_label: 0,
  };
  for (const authority of args.resolution.matchedAuthorities.values()) {
    authorityCounts[authority] += 1;
  }

  const uncoveredQueries = args.queries.flatMap((query) => {
    const missingEntityIds = [...new Set(
      collectQueryEntityIds(query).filter((entityId) => !args.resolution.resolvedIds.has(entityId)),
    )];
    if (missingEntityIds.length === 0) {
      return [];
    }
    return [{
      qid: query.qid,
      missingEntityIds,
    }];
  });

  return {
    snapshotId: args.snapshotId,
    benchmarkIdCount: args.resolution.resolvedIds.size + args.resolution.missingBenchmarkIds.length,
    mappedBenchmarkIdCount: args.resolution.resolvedIds.size,
    totalQueryCount: args.queries.length,
    fullyCoveredQueryCount: args.queries.length - uncoveredQueries.length,
    missingBenchmarkIds: args.resolution.missingBenchmarkIds,
    uncoveredQueries,
    authorityCounts,
  };
}

export function assertHumanGoldRuntimeCoverage(
  summary: HumanGoldRuntimeCoverageSummary,
): void {
  if (
    summary.missingBenchmarkIds.length === 0
    && summary.fullyCoveredQueryCount === summary.totalQueryCount
  ) {
    return;
  }

  const missingSample = summary.missingBenchmarkIds
    .slice(0, COVERAGE_ERROR_SAMPLE_LIMIT)
    .join(', ');
  const querySample = summary.uncoveredQueries
    .slice(0, COVERAGE_ERROR_SAMPLE_LIMIT)
    .map((query) => `${query.qid}:${query.missingEntityIds.slice(0, 3).join('|')}`)
    .join(', ');
  throw new Error(
    'embedding-sensitive human-gold runtime coverage failed '
    + `(snapshot=${summary.snapshotId}): mapped ${summary.mappedBenchmarkIdCount}/${summary.benchmarkIdCount} benchmark ids, `
    + `fully covered queries ${summary.fullyCoveredQueryCount}/${summary.totalQueryCount}, `
    + `authorities=${JSON.stringify(summary.authorityCounts)}. `
    + `missing ids sample: ${missingSample}${summary.missingBenchmarkIds.length > COVERAGE_ERROR_SAMPLE_LIMIT ? ', …' : ''}. `
    + `uncovered queries sample: ${querySample}${summary.uncoveredQueries.length > COVERAGE_ERROR_SAMPLE_LIMIT ? ', …' : ''}`,
  );
}

function requireResolvedEntityId(
  resolvedIds: ReadonlyMap<string, string>,
  entityId: string,
): string {
  const resolved = resolvedIds.get(entityId);
  if (resolved === undefined) {
    throw new Error(`embedding-sensitive human-gold runtime corpus is missing resolved entity id for ${entityId}`);
  }
  return resolved;
}

export function applyResolvedHumanGoldRuntimeEntityIds(
  queries: readonly GoldenQuery[],
  resolvedIds: ReadonlyMap<string, string>,
): readonly GoldenQuery[] {
  return queries.map((query) => ({
    ...query,
    retrieval_labels: {
      ...query.retrieval_labels,
      relevant: query.retrieval_labels.relevant.map((relevant) => ({
        ...relevant,
        entity_id: requireResolvedEntityId(resolvedIds, relevant.entity_id),
      })),
    },
    decision_labels: query.decision_labels.expected_entity_id === undefined
      ? query.decision_labels
      : {
          ...query.decision_labels,
          expected_entity_id: requireResolvedEntityId(
            resolvedIds,
            query.decision_labels.expected_entity_id,
          ),
        },
    leakage_keys: {
      ...query.leakage_keys,
      entity_id: requireResolvedEntityId(resolvedIds, query.leakage_keys.entity_id),
    },
  }));
}
