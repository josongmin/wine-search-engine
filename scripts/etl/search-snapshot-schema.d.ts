import { z } from 'zod';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION, SEARCH_SNAPSHOT_STATE_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { type SearchSnapshotFieldAvailability } from '../../src/domain/shared/types/search-field-availability.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../src/domain/shared/utils/stable-json.js';
export interface AliasSnapshotRecord {
    readonly aliasId: string;
    readonly entityId: string;
    readonly value: string;
    readonly normalizedValue: string;
    readonly type: string;
    readonly aliasType?: string;
    readonly scope: string;
    readonly source: string;
    readonly sourceTrust: number;
    readonly confidencePrior: number;
}
export interface CanonicalAliasHashRecord {
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
export interface EntitySnapshotRecord {
    readonly entityId: string;
    readonly entityType: 'wine';
    readonly canonicalLabel: string;
    readonly identitySignature: string;
    readonly relations: Record<string, unknown>;
    readonly attributes: Record<string, unknown>;
    readonly metadata: Record<string, unknown>;
}
export interface AmbiguityRegistrySnapshotRow {
    readonly registryId: string;
    readonly normalizedForm: string;
    readonly entityIds: readonly string[];
    readonly ambiguityTypes: readonly string[];
    readonly severity: 'low' | 'medium' | 'high';
}
export interface SearchSnapshotQualitySummary {
    readonly status: 'canonical' | 'degraded';
    readonly blockers: readonly string[];
    readonly bypasses: readonly string[];
    readonly carryForwardBenchmarkCount: number;
    readonly experimentalInputsPresent: boolean;
}
export interface SearchSnapshotManifest {
    readonly schemaVersion: typeof SEARCH_SNAPSHOT_SCHEMA_VERSION;
    readonly snapshotId: string;
    readonly generatedAt: string;
    readonly contentHash: string;
    readonly sourceInputPath: string;
    readonly artifacts: {
        readonly documentsNdjson: string;
        readonly vespaFeedNdjson: string;
        readonly entitiesNdjson: string;
        readonly aliasesNdjson: string;
        readonly ambiguityRegistryNdjson: string;
        readonly nlMappingsJson: string;
        readonly metadataJson: string;
    };
    readonly counts: {
        readonly documents: number;
        readonly vespaFeed: number;
        readonly entities: number;
        readonly aliases: number;
        readonly ambiguityRegistry: number;
        readonly nlMappings: number;
    };
    readonly hashes: {
        readonly documents: string;
        readonly vespaFeed: string;
        readonly entities: string;
        readonly aliases: string;
        readonly ambiguityRegistry: string;
        readonly nlMappings: string;
    };
    readonly fieldAvailability: SearchSnapshotFieldAvailability;
    readonly quality: SearchSnapshotQualitySummary;
}
export interface SearchSnapshotArtifactHashes {
    readonly documents: string;
    readonly vespaFeed: string;
    readonly entities: string;
    readonly aliases: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
}
export interface SearchSnapshotRuntimeState {
    readonly schemaVersion: typeof SEARCH_SNAPSHOT_STATE_VERSION;
    readonly snapshotId: string;
    readonly contentHash: string;
    readonly publishedAt: string;
    readonly manifestPath: string;
    readonly nlMappingsRuntimePath: string;
    readonly quality: SearchSnapshotQualitySummary;
    readonly counts: {
        readonly entities: number;
        readonly aliases: number;
        readonly ambiguityRegistry: number;
        readonly nlMappings: number;
        readonly activeLtrModels: number;
    };
    readonly hashes: {
        readonly entities: string;
        readonly aliases: string;
        readonly ambiguityRegistry: string;
        readonly nlMappings: string;
        readonly activeLtrModels: string;
    };
    readonly fieldAvailability: SearchSnapshotFieldAvailability;
    readonly ltrReleaseProvenance?: {
        readonly updatedAt: string;
        readonly evalDatasetVersion: string;
        readonly featureSchemaHash: string;
        readonly summaryJsonPath: string;
        readonly summaryJsonHash: string;
        readonly summaryMarkdownPath: string;
        readonly summaryMarkdownHash: string;
        readonly noisyEntityOutputPath: string;
        readonly noisyEntityOutputHash: string;
        readonly combinedReleaseGatePassed: boolean;
        readonly activationStatus: 'activated' | 'shadow_only';
    };
}
export declare const SearchSnapshotManifestSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"search_snapshot.v1">;
    snapshotId: z.ZodString;
    generatedAt: z.ZodString;
    contentHash: z.ZodString;
    sourceInputPath: z.ZodString;
    artifacts: z.ZodObject<{
        documentsNdjson: z.ZodString;
        vespaFeedNdjson: z.ZodString;
        entitiesNdjson: z.ZodString;
        aliasesNdjson: z.ZodString;
        ambiguityRegistryNdjson: z.ZodString;
        nlMappingsJson: z.ZodString;
        metadataJson: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        documentsNdjson: string;
        vespaFeedNdjson: string;
        entitiesNdjson: string;
        aliasesNdjson: string;
        ambiguityRegistryNdjson: string;
        nlMappingsJson: string;
        metadataJson: string;
    }, {
        documentsNdjson: string;
        vespaFeedNdjson: string;
        entitiesNdjson: string;
        aliasesNdjson: string;
        ambiguityRegistryNdjson: string;
        nlMappingsJson: string;
        metadataJson: string;
    }>;
    counts: z.ZodObject<{
        documents: z.ZodNumber;
        vespaFeed: z.ZodNumber;
        entities: z.ZodNumber;
        aliases: z.ZodNumber;
        ambiguityRegistry: z.ZodNumber;
        nlMappings: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        documents: number;
        vespaFeed: number;
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
    }, {
        documents: number;
        vespaFeed: number;
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
    }>;
    hashes: z.ZodObject<{
        documents: z.ZodString;
        vespaFeed: z.ZodString;
        entities: z.ZodString;
        aliases: z.ZodString;
        ambiguityRegistry: z.ZodString;
        nlMappings: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        documents: string;
        vespaFeed: string;
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
    }, {
        documents: string;
        vespaFeed: string;
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
    }>;
    fieldAvailability: z.ZodEffects<z.ZodObject<{
        appellation: z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>;
        body: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        sweetness: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        acidity: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        tannin: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
    }, "strict", z.ZodTypeAny, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        sweetness: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        acidity: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        tannin: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
    }, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    }>, SearchSnapshotFieldAvailability, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    }>;
    quality: z.ZodObject<{
        status: z.ZodEnum<["canonical", "degraded"]>;
        blockers: z.ZodArray<z.ZodString, "many">;
        bypasses: z.ZodArray<z.ZodString, "many">;
        carryForwardBenchmarkCount: z.ZodNumber;
        experimentalInputsPresent: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    }, {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    }>;
}, "strict", z.ZodTypeAny, {
    schemaVersion: "search_snapshot.v1";
    snapshotId: string;
    generatedAt: string;
    contentHash: string;
    sourceInputPath: string;
    artifacts: {
        documentsNdjson: string;
        vespaFeedNdjson: string;
        entitiesNdjson: string;
        aliasesNdjson: string;
        ambiguityRegistryNdjson: string;
        nlMappingsJson: string;
        metadataJson: string;
    };
    counts: {
        documents: number;
        vespaFeed: number;
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
    };
    hashes: {
        documents: string;
        vespaFeed: string;
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
    };
    fieldAvailability: SearchSnapshotFieldAvailability;
    quality: {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    };
}, {
    schemaVersion: "search_snapshot.v1";
    snapshotId: string;
    generatedAt: string;
    contentHash: string;
    sourceInputPath: string;
    artifacts: {
        documentsNdjson: string;
        vespaFeedNdjson: string;
        entitiesNdjson: string;
        aliasesNdjson: string;
        ambiguityRegistryNdjson: string;
        nlMappingsJson: string;
        metadataJson: string;
    };
    counts: {
        documents: number;
        vespaFeed: number;
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
    };
    hashes: {
        documents: string;
        vespaFeed: string;
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
    };
    fieldAvailability: {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    };
    quality: {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    };
}>;
export declare const SearchSnapshotRuntimeStateSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"search_snapshot_runtime_state.v3">;
    snapshotId: z.ZodString;
    contentHash: z.ZodString;
    publishedAt: z.ZodString;
    manifestPath: z.ZodString;
    nlMappingsRuntimePath: z.ZodString;
    quality: z.ZodObject<{
        status: z.ZodEnum<["canonical", "degraded"]>;
        blockers: z.ZodArray<z.ZodString, "many">;
        bypasses: z.ZodArray<z.ZodString, "many">;
        carryForwardBenchmarkCount: z.ZodNumber;
        experimentalInputsPresent: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    }, {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    }>;
    counts: z.ZodObject<{
        entities: z.ZodNumber;
        aliases: z.ZodNumber;
        ambiguityRegistry: z.ZodNumber;
        nlMappings: z.ZodNumber;
        activeLtrModels: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
        activeLtrModels: number;
    }, {
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
        activeLtrModels: number;
    }>;
    hashes: z.ZodObject<{
        entities: z.ZodString;
        aliases: z.ZodString;
        ambiguityRegistry: z.ZodString;
        nlMappings: z.ZodString;
        activeLtrModels: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
        activeLtrModels: string;
    }, {
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
        activeLtrModels: string;
    }>;
    fieldAvailability: z.ZodEffects<z.ZodObject<{
        appellation: z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>;
        body: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        sweetness: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        acidity: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
        tannin: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            populatedDocCount: z.ZodNumber;
            totalDocCount: z.ZodNumber;
            populatedDocRatio: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }, {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        }>>>;
    }, "strict", z.ZodTypeAny, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        sweetness: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        acidity: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        tannin: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
    }, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    }>, SearchSnapshotFieldAvailability, {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    }>;
    ltrReleaseProvenance: z.ZodOptional<z.ZodObject<{
        updatedAt: z.ZodString;
        evalDatasetVersion: z.ZodString;
        featureSchemaHash: z.ZodString;
        summaryJsonPath: z.ZodString;
        summaryJsonHash: z.ZodString;
        summaryMarkdownPath: z.ZodString;
        summaryMarkdownHash: z.ZodString;
        noisyEntityOutputPath: z.ZodString;
        noisyEntityOutputHash: z.ZodString;
        combinedReleaseGatePassed: z.ZodBoolean;
        activationStatus: z.ZodEnum<["activated", "shadow_only"]>;
    }, "strict", z.ZodTypeAny, {
        updatedAt: string;
        evalDatasetVersion: string;
        featureSchemaHash: string;
        summaryJsonPath: string;
        summaryJsonHash: string;
        summaryMarkdownPath: string;
        summaryMarkdownHash: string;
        noisyEntityOutputPath: string;
        noisyEntityOutputHash: string;
        combinedReleaseGatePassed: boolean;
        activationStatus: "activated" | "shadow_only";
    }, {
        updatedAt: string;
        evalDatasetVersion: string;
        featureSchemaHash: string;
        summaryJsonPath: string;
        summaryJsonHash: string;
        summaryMarkdownPath: string;
        summaryMarkdownHash: string;
        noisyEntityOutputPath: string;
        noisyEntityOutputHash: string;
        combinedReleaseGatePassed: boolean;
        activationStatus: "activated" | "shadow_only";
    }>>;
}, "strict", z.ZodTypeAny, {
    schemaVersion: "search_snapshot_runtime_state.v3";
    snapshotId: string;
    contentHash: string;
    counts: {
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
        activeLtrModels: number;
    };
    hashes: {
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
        activeLtrModels: string;
    };
    fieldAvailability: SearchSnapshotFieldAvailability;
    quality: {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    };
    publishedAt: string;
    manifestPath: string;
    nlMappingsRuntimePath: string;
    ltrReleaseProvenance?: {
        updatedAt: string;
        evalDatasetVersion: string;
        featureSchemaHash: string;
        summaryJsonPath: string;
        summaryJsonHash: string;
        summaryMarkdownPath: string;
        summaryMarkdownHash: string;
        noisyEntityOutputPath: string;
        noisyEntityOutputHash: string;
        combinedReleaseGatePassed: boolean;
        activationStatus: "activated" | "shadow_only";
    } | undefined;
}, {
    schemaVersion: "search_snapshot_runtime_state.v3";
    snapshotId: string;
    contentHash: string;
    counts: {
        entities: number;
        aliases: number;
        ambiguityRegistry: number;
        nlMappings: number;
        activeLtrModels: number;
    };
    hashes: {
        entities: string;
        aliases: string;
        ambiguityRegistry: string;
        nlMappings: string;
        activeLtrModels: string;
    };
    fieldAvailability: {
        appellation: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        };
        body?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        sweetness?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        acidity?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
        tannin?: {
            populatedDocCount: number;
            totalDocCount: number;
            populatedDocRatio: number;
        } | undefined;
    };
    quality: {
        status: "canonical" | "degraded";
        blockers: string[];
        bypasses: string[];
        carryForwardBenchmarkCount: number;
        experimentalInputsPresent: boolean;
    };
    publishedAt: string;
    manifestPath: string;
    nlMappingsRuntimePath: string;
    ltrReleaseProvenance?: {
        updatedAt: string;
        evalDatasetVersion: string;
        featureSchemaHash: string;
        summaryJsonPath: string;
        summaryJsonHash: string;
        summaryMarkdownPath: string;
        summaryMarkdownHash: string;
        noisyEntityOutputPath: string;
        noisyEntityOutputHash: string;
        combinedReleaseGatePassed: boolean;
        activationStatus: "activated" | "shadow_only";
    } | undefined;
}>;
export declare function parseManifest(raw: string, _filePath: string): SearchSnapshotManifest;
export { hashStableJson, hashText, stableJsonStringify };
/**
 * Snapshot identity is anchored to the logical runtime substrates and source
 * documents, not the operational exact-replay feed artifact. The exact Vespa
 * feed is materialized later during publish and may be rewritten without
 * changing the canonical snapshot id.
 */
export declare function buildSearchSnapshotContentHash(hashes: SearchSnapshotArtifactHashes): string;
export declare function buildSearchSnapshotId(contentHash: string): string;
export declare function serializeNdjson(records: readonly unknown[]): string;
export declare function canonicalizeEntitySnapshotRecords(records: readonly EntitySnapshotRecord[]): readonly EntitySnapshotRecord[];
export declare function canonicalizeAliasSnapshotRecords(records: readonly AliasSnapshotRecord[]): readonly CanonicalAliasHashRecord[];
export declare function canonicalizeAmbiguitySnapshotRows(rows: readonly AmbiguityRegistrySnapshotRow[]): readonly AmbiguityRegistrySnapshotRow[];
//# sourceMappingURL=search-snapshot-schema.d.ts.map