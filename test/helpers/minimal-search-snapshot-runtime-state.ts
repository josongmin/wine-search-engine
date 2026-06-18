import path from 'node:path';

/** Minimal lookup-runtime plane fields required by `loadSearchSnapshotRuntimeState`. */
export function buildMinimalLookupRuntimeStatePlane(dir: string): {
  readonly lookupAliasRuntimePath: string;
  readonly lookupExactSafeRuntimePath: string;
  readonly lookupResolverProjectionPath: string;
  readonly lookupEntityProjectionPath: string;
  readonly lookupSemanticScopeRuntimePath: string;
  readonly lookupReviewedFamilyRecallRuntimePath: string;
  readonly lookupScopeGraphRuntimePath: string;
  readonly lookupAmbiguityRuntimePath: string;
  readonly lookupConceptRedirectRuntimePath: string;
  readonly lookupRuntimeCounts: {
    readonly lookupAliasRuntimeAliases: number;
    readonly lookupExactSafeRuntimeEntries: number;
    readonly lookupResolverProjectionDocuments: number;
    readonly lookupEntityProjectionDocuments: number;
    readonly lookupSemanticScopeRuntimeEntries: number;
    readonly lookupReviewedFamilyRecallRuntimeEntries: number;
    readonly lookupScopeGraphRuntimeEdges: number;
    readonly lookupAmbiguityRuntimeEntries: number;
    readonly lookupConceptRedirectRuntimeEntries: number;
  };
  readonly lookupRuntimeHashes: {
    readonly lookupAliasRuntime: string;
    readonly lookupExactSafeRuntime: string;
    readonly lookupResolverProjection: string;
    readonly lookupEntityProjection: string;
    readonly lookupSemanticScopeRuntime: string;
    readonly lookupReviewedFamilyRecallRuntime: string;
    readonly lookupScopeGraphRuntime: string;
    readonly lookupAmbiguityRuntime: string;
    readonly lookupConceptRedirectRuntime: string;
  };
} {
  return {
    lookupAliasRuntimePath: path.join(dir, 'lookup-alias-runtime.json'),
    lookupExactSafeRuntimePath: path.join(dir, 'lookup-exact-safe-runtime.json'),
    lookupResolverProjectionPath: path.join(dir, 'lookup-resolver-projection.json'),
    lookupEntityProjectionPath: path.join(dir, 'lookup-entity-projection.json'),
    lookupSemanticScopeRuntimePath: path.join(dir, 'lookup-semantic-scope-runtime.json'),
    lookupReviewedFamilyRecallRuntimePath: path.join(dir, 'lookup-reviewed-family-recall-runtime.json'),
    lookupScopeGraphRuntimePath: path.join(dir, 'lookup-scope-graph-runtime.json'),
    lookupAmbiguityRuntimePath: path.join(dir, 'lookup-ambiguity-runtime.json'),
    lookupConceptRedirectRuntimePath: path.join(dir, 'lookup-concept-redirect-runtime.json'),
    lookupManifestArtifacts: {
      lookupAliasRuntimeJson: path.join(dir, 'lookup-alias-runtime.json'),
      lookupExactSafeRuntimeJson: path.join(dir, 'lookup-exact-safe-runtime.json'),
      lookupResolverProjectionJson: path.join(dir, 'lookup-resolver-projection.json'),
      lookupEntityProjectionJson: path.join(dir, 'lookup-entity-projection.json'),
      lookupSemanticScopeRuntimeJson: path.join(dir, 'lookup-semantic-scope-runtime.json'),
      lookupReviewedFamilyRecallRuntimeJson: path.join(dir, 'lookup-reviewed-family-recall-runtime.json'),
      lookupScopeGraphRuntimeJson: path.join(dir, 'lookup-scope-graph-runtime.json'),
      lookupAmbiguityRuntimeJson: path.join(dir, 'lookup-ambiguity-runtime.json'),
      lookupConceptRedirectRuntimeJson: path.join(dir, 'lookup-concept-redirect-runtime.json'),
    },
    lookupRuntimeCounts: {
      lookupAliasRuntimeAliases: 10,
      lookupExactSafeRuntimeEntries: 0,
      lookupResolverProjectionDocuments: 10,
      lookupEntityProjectionDocuments: 10,
      lookupSemanticScopeRuntimeEntries: 1,
      lookupReviewedFamilyRecallRuntimeEntries: 0,
      lookupScopeGraphRuntimeEdges: 0,
      lookupAmbiguityRuntimeEntries: 0,
      lookupConceptRedirectRuntimeEntries: 0,
    },
    lookupRuntimeHashes: {
      lookupAliasRuntime: 'lookup-alias-runtime-hash',
      lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
      lookupResolverProjection: 'lookup-resolver-projection-hash',
      lookupEntityProjection: 'lookup-entity-projection-hash',
      lookupSemanticScopeRuntime: 'lookup-semantic-scope-runtime-hash',
      lookupReviewedFamilyRecallRuntime: 'lookup-reviewed-family-recall-runtime-hash',
      lookupScopeGraphRuntime: 'lookup-scope-graph-runtime-hash',
      lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
      lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
    },
  };
}
