export interface CanonicalEntitySnapshotLike {
  readonly entityId: string;
  readonly entityType: 'wine';
  readonly canonicalLabel: string;
  readonly identitySignature: string;
  readonly relations: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

export interface CanonicalAliasSnapshotLike {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly type: string;
  readonly scope: string;
  readonly source: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
}

export interface CanonicalAmbiguitySnapshotLike {
  readonly registryId: string;
  readonly normalizedForm: string;
  readonly entityIds: readonly string[];
  readonly ambiguityTypes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

export function canonicalizeEntitySnapshotRecords(
  records: readonly CanonicalEntitySnapshotLike[],
): readonly CanonicalEntitySnapshotLike[] {
  return [...records].sort((left, right) => left.entityId.localeCompare(right.entityId));
}

export function canonicalizeAliasSnapshotRecords(
  records: readonly CanonicalAliasSnapshotLike[],
): readonly CanonicalAliasSnapshotLike[] {
  return records.map((record) => ({
    aliasId: record.aliasId,
    entityId: record.entityId,
    value: record.value,
    normalizedValue: record.normalizedValue,
    type: record.type,
    scope: record.scope,
    source: record.source,
    sourceTrust: record.sourceTrust,
    confidencePrior: record.confidencePrior,
  })).sort((left, right) =>
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.entityId.localeCompare(right.entityId)
    || left.aliasId.localeCompare(right.aliasId),
  );
}

export function canonicalizeAmbiguitySnapshotRows(
  rows: readonly CanonicalAmbiguitySnapshotLike[],
): readonly CanonicalAmbiguitySnapshotLike[] {
  return [...rows].sort((left, right) =>
    left.normalizedForm.localeCompare(right.normalizedForm)
    || left.registryId.localeCompare(right.registryId),
  );
}
