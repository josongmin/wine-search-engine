import {
  loadLookupPolicyConflictRegistrySync,
} from './lookup-v2-policy-conflict-registry.js';

export type LookupV2StretchPartition =
  | 'all'
  | 'entity-only'
  | 'discovery-only'
  | 'policy-conflict'
  | 'entity-no-policy';

export const LOOKUP_V2_STRETCH_PARTITION_VALUES: readonly LookupV2StretchPartition[] = [
  'all',
  'entity-only',
  'discovery-only',
  'policy-conflict',
  'entity-no-policy',
] as const;

export const LOOKUP_V2_STRETCH_POLICY_CONFLICT_ROWS = loadLookupPolicyConflictRegistrySync();
export const LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES: ReadonlySet<string> = new Set(
  LOOKUP_V2_STRETCH_POLICY_CONFLICT_ROWS.map((row) => row.surface),
);

export function isLookupV2StretchPartition(value: string): value is LookupV2StretchPartition {
  return (LOOKUP_V2_STRETCH_PARTITION_VALUES as readonly string[]).includes(value);
}

export function filterLookupV2StretchRows<Row extends {
  readonly query: string;
  readonly expectedStatus: 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';
}>(rows: readonly Row[], partition: LookupV2StretchPartition): readonly Row[] {
  if (partition === 'all') {
    return rows;
  }
  if (partition === 'discovery-only') {
    return rows.filter((row) => row.expectedStatus === 'redirect_discovery');
  }
  if (partition === 'policy-conflict') {
    return rows.filter((row) => LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES.has(row.query));
  }
  if (partition === 'entity-only') {
    return rows.filter((row) => row.expectedStatus !== 'redirect_discovery');
  }
  if (partition === 'entity-no-policy') {
    return rows.filter(
      (row) => row.expectedStatus !== 'redirect_discovery'
        && !LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES.has(row.query),
    );
  }
  return rows;
}
