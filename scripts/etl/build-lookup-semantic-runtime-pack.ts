import type {
  LookupReviewedFamilyRecallRuntimeArtifact,
  LookupReviewedFamilyRecallRuntimeEntry,
  LookupScopeGraphRuntimeArtifact,
  LookupScopeGraphRuntimeEdge,
  LookupScopeGraphRelationKind,
  LookupSemanticScopeRuntimeArtifact,
  LookupSemanticScopeRuntimeEntry,
} from '../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import {
  LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION,
  LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION,
  LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
} from '../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import type { LookupEntityProjectionDocument } from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { buildNormalizedQueryViews } from '../../src/domain/query/service/query-normalizer.js';
import { deriveLookupSemanticEntityDescriptor } from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import type { LookupV2SemanticScopeTargetRegistryRow } from '../eval/lookup-v2-semantic-scope-target-registry.js';
import type { LookupV2LocalizedScopeSurfaceRegistryRow } from '../eval/lookup-v2-localized-scope-surface-registry.js';
import type { LookupV2FamilyCollisionRegistryRow } from '../eval/lookup-v2-family-collision-registry.js';
import type { LookupV2FamilyCoreWitnessRegistryRow } from '../eval/lookup-v2-family-core-witness-registry.js';
import { buildLookupV2RuntimeSurfaceOwnerEvidence } from '../eval/lookup-v2-runtime-surface-owner-evidence.js';

interface RuntimeDescriptor {
  readonly entityId: string;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
}

function buildDescriptor(
  document: LookupEntityProjectionDocument,
): RuntimeDescriptor {
  const descriptor = deriveLookupSemanticEntityDescriptor({
    canonicalLabel: document.canonicalLabel,
    producer: document.producer,
    region: document.region,
    appellation: typeof document['appellation'] === 'string' ? document['appellation'] : undefined,
    vintage: typeof document['vintageYear'] === 'number' ? document['vintageYear'] : undefined,
    familyCoreKeys: document.familyCoreKeys,
  });
  return {
    entityId: document.entityId,
    familyKey: descriptor.familyKey,
    ...(descriptor.lineKey !== undefined ? { lineKey: descriptor.lineKey } : {}),
    ...(descriptor.regionKey !== undefined ? { regionKey: descriptor.regionKey } : {}),
    ...(descriptor.appellationKey !== undefined ? { appellationKey: descriptor.appellationKey } : {}),
    ...(descriptor.vintage !== undefined ? { vintage: descriptor.vintage } : {}),
  };
}

function relationWeight(size: number): number {
  if (!Number.isFinite(size) || size <= 1) {
    return 0;
  }
  return 1 - 1 / size;
}

function appendEdges(args: {
  readonly adjacency: Map<string, LookupScopeGraphRuntimeEdge[]>;
  readonly members: readonly RuntimeDescriptor[];
  readonly relationKind: LookupScopeGraphRelationKind;
}): void {
  if (args.members.length <= 1) {
    return;
  }
  const weight = relationWeight(args.members.length);
  for (const source of args.members) {
    const edges = args.adjacency.get(source.entityId) ?? [];
    const dedupe = new Set(edges.map((edge) => `${edge.relationKind}::${edge.targetEntityId}`));
    for (const target of args.members) {
      if (target.entityId === source.entityId) {
        continue;
      }
      const key = `${args.relationKind}::${target.entityId}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      edges.push({
        targetEntityId: target.entityId,
        relationKind: args.relationKind,
        weight,
        familyKey: source.familyKey,
        ...(source.lineKey !== undefined ? { lineKey: source.lineKey } : {}),
        ...(target.vintage !== undefined ? { vintage: target.vintage } : {}),
      });
    }
    args.adjacency.set(source.entityId, edges);
  }
}

export function buildLookupSemanticScopeRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly reviewedRows: readonly LookupV2SemanticScopeTargetRegistryRow[];
  // Reviewed component-surface rows (final architecture L1). Optional: when
  // omitted the artifact carries no componentSurfaces and the matcher falls
  // back to latin-literal token matching (zero regression).
  readonly scopeSurfaceRows?: readonly LookupV2LocalizedScopeSurfaceRegistryRow[] | undefined;
}): LookupSemanticScopeRuntimeArtifact {
  const entries: Record<string, LookupSemanticScopeRuntimeEntry> = {};
  for (const row of args.reviewedRows
    .filter((candidate): candidate is LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string } =>
      candidate.decisionStatus === 'approved' && candidate.entityId !== undefined,
    )
    .slice()
    .sort((left, right) => left.semanticScopeKey.localeCompare(right.semanticScopeKey))) {
    if (entries[row.semanticScopeKey] !== undefined) {
      throw new Error(`Duplicate lookup semantic scope runtime semanticScopeKey=${row.semanticScopeKey}`);
    }
    entries[row.semanticScopeKey] = {
      semanticScopeKey: row.semanticScopeKey,
      scopeAxis: row.scopeAxis,
      familyKey: row.familyKey,
      ...(row.lineKey !== undefined ? { lineKey: row.lineKey } : {}),
      ...(row.regionKey !== undefined ? { regionKey: row.regionKey } : {}),
      ...(row.appellationKey !== undefined ? { appellationKey: row.appellationKey } : {}),
      ...(row.vintage !== undefined ? { vintage: row.vintage } : {}),
      surfaceFormKind: row.surfaceFormKind,
      locale: row.locale,
      entityId: row.entityId,
    };
  }
  // Materialize reviewed component surfaces: componentKind::componentKey::locale
  // -> sorted unique normalized surfaces. Fail-closed on empty normalized form.
  const componentSurfaceSets = new Map<string, Set<string>>();
  for (const row of args.scopeSurfaceRows ?? []) {
    if (row.decisionStatus !== 'approved') {
      continue;
    }
    if (row.normalizedLocalSurface.trim().length === 0) {
      throw new Error(`lookup surface index empty normalized surface for componentKey=${row.componentKey}`);
    }
    const key = `${row.componentKind}::${row.componentKey}::${row.locale}`;
    const existing = componentSurfaceSets.get(key) ?? new Set<string>();
    existing.add(row.normalizedLocalSurface);
    componentSurfaceSets.set(key, existing);
  }
  const componentSurfaces: Record<string, readonly string[]> = {};
  for (const key of [...componentSurfaceSets.keys()].sort()) {
    componentSurfaces[key] = [...componentSurfaceSets.get(key)!].sort();
  }
  return {
    schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    entries,
    ...(Object.keys(componentSurfaces).length > 0 ? { componentSurfaces } : {}),
  };
}

export function buildLookupScopeGraphRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entityProjectionDocuments: readonly LookupEntityProjectionDocument[];
}): LookupScopeGraphRuntimeArtifact {
  const descriptors = args.entityProjectionDocuments
    .map(buildDescriptor)
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

  const byFamily = new Map<string, RuntimeDescriptor[]>();
  const byLineSiblingGroup = new Map<string, RuntimeDescriptor[]>();
  const byVintageGroup = new Map<string, RuntimeDescriptor[]>();

  for (const descriptor of descriptors) {
    const familyMembers = byFamily.get(descriptor.familyKey) ?? [];
    familyMembers.push(descriptor);
    byFamily.set(descriptor.familyKey, familyMembers);

    if (descriptor.lineKey !== undefined) {
      const lineSiblingKey = `${descriptor.familyKey}::${descriptor.lineKey}`;
      const vintageMembers = byVintageGroup.get(lineSiblingKey) ?? [];
      vintageMembers.push(descriptor);
      byVintageGroup.set(lineSiblingKey, vintageMembers);
    }

    const familyLineGroupKey = descriptor.familyKey;
    const familyLineMembers = byLineSiblingGroup.get(familyLineGroupKey) ?? [];
    familyLineMembers.push(descriptor);
    byLineSiblingGroup.set(familyLineGroupKey, familyLineMembers);
  }

  const adjacency = new Map<string, LookupScopeGraphRuntimeEdge[]>();

  for (const members of byFamily.values()) {
    appendEdges({ adjacency, members, relationKind: 'family' });
  }

  for (const familyMembers of byLineSiblingGroup.values()) {
    const lineGroups = new Map<string, RuntimeDescriptor[]>();
    for (const member of familyMembers) {
      if (member.lineKey === undefined) {
        continue;
      }
      const group = lineGroups.get(member.lineKey) ?? [];
      group.push(member);
      lineGroups.set(member.lineKey, group);
    }
    const grouped = [...lineGroups.values()].filter((members) => members.length > 0);
    if (grouped.length <= 1) {
      continue;
    }
    const allMembers = grouped.flat();
    for (const sourceGroup of grouped) {
      for (const source of sourceGroup) {
        const edges = adjacency.get(source.entityId) ?? [];
        const dedupe = new Set(edges.map((edge) => `${edge.relationKind}::${edge.targetEntityId}`));
        const siblingCount = allMembers.filter((member) => member.lineKey !== source.lineKey).length;
        const weight = relationWeight(siblingCount + 1);
        for (const target of allMembers) {
          if (target.entityId === source.entityId || target.lineKey === source.lineKey) {
            continue;
          }
          const key = `line::${target.entityId}`;
          if (dedupe.has(key)) {
            continue;
          }
          dedupe.add(key);
          edges.push({
            targetEntityId: target.entityId,
            relationKind: 'line',
            weight,
            familyKey: source.familyKey,
            ...(target.lineKey !== undefined ? { lineKey: target.lineKey } : {}),
            ...(target.vintage !== undefined ? { vintage: target.vintage } : {}),
          });
        }
        adjacency.set(source.entityId, edges);
      }
    }
  }

  for (const members of byVintageGroup.values()) {
    appendEdges({
      adjacency,
      members: members.filter((member) => member.vintage !== undefined),
      relationKind: 'vintage',
    });
  }

  return {
    schemaVersion: LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    adjacency: Object.fromEntries(
      [...adjacency.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entityId, edges]) => [
          entityId,
          edges
            .slice()
            .sort((left, right) =>
              left.relationKind.localeCompare(right.relationKind)
              || left.targetEntityId.localeCompare(right.targetEntityId),
            ),
        ]),
    ),
  };
}

export function buildLookupReviewedFamilyRecallRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entityProjectionDocuments: readonly LookupEntityProjectionDocument[];
  readonly reviewedCollisionRows: readonly LookupV2FamilyCollisionRegistryRow[];
  readonly reviewedFamilyCoreWitnessRows?: readonly LookupV2FamilyCoreWitnessRegistryRow[] | undefined;
  readonly localizedScopeSurfaceRows?: readonly LookupV2LocalizedScopeSurfaceRegistryRow[] | undefined;
}): LookupReviewedFamilyRecallRuntimeArtifact {
  const ownerEvidence = buildLookupV2RuntimeSurfaceOwnerEvidence(
    args.entityProjectionDocuments,
    args.reviewedFamilyCoreWitnessRows,
  );
  const entries: Record<string, LookupReviewedFamilyRecallRuntimeEntry> = {};

  for (const row of args.reviewedCollisionRows
    .slice()
    .sort((left, right) => left.normalizedBenchmarkGoldHint.localeCompare(right.normalizedBenchmarkGoldHint))) {
    const normalizedSurface = row.normalizedBenchmarkGoldHint;
    const entityIds = ownerEvidence.collidingOwners.get(normalizedSurface);
    if (entityIds === undefined || entityIds.length < 2) {
      throw new Error(
        `Reviewed family recall runtime row ${JSON.stringify(row.benchmarkGoldHint)} has no active collision owners in snapshot-published entity projection`,
      );
    }
    if (entries[normalizedSurface] !== undefined) {
      throw new Error(`Duplicate reviewed family recall runtime normalizedSurface=${normalizedSurface}`);
    }
    const witnessSources = [...new Set(
      (ownerEvidence.collidingOwnerWitnesses.get(normalizedSurface) ?? []).map((witness) => witness.witnessSource),
    )].sort((left, right) => left.localeCompare(right));
    const localizedSurfaces = [...new Set(
      (args.localizedScopeSurfaceRows ?? [])
        .filter((localizedRow) =>
          localizedRow.decisionStatus === 'approved'
          && localizedRow.componentKind === 'family'
          && normalizeForMatch(localizedRow.componentKey) === normalizedSurface,
        )
        .map((localizedRow) => buildNormalizedQueryViews(localizedRow.localSurface).vintageStripped.trim())
        .filter((surface) => surface.length > 0)
    )].sort((left, right) => left.localeCompare(right, 'ko'));
    entries[normalizedSurface] = {
      normalizedSurface,
      familyKey: normalizedSurface,
      entityIds: [...entityIds],
      recallWeight: relationWeight(entityIds.length),
      ...(localizedSurfaces.length > 0 ? { localizedSurfaces } : {}),
      ...(witnessSources.length > 0 ? { witnessSources } : {}),
    };
  }

  return {
    schemaVersion: LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    entries,
  };
}
