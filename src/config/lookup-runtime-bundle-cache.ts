import fs from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { LookupResolverProjection } from '../application/search/port/search-pipeline-deps.port.js';
import type { AmbiguityInfo } from '../domain/query/port/ambiguity-dictionary.port.js';
import type {
  LookupConceptRedirectInfo,
  LookupExactSafeMatch,
} from '../domain/resolver/v2/lookup-v2-types.js';
import type {
  LookupAliasBroadRecallRuntimeArtifact,
  LookupAliasRuntimeArtifact,
  LookupAliasRuntimeCoreArtifact,
} from '../domain/shared/types/search-snapshot-lookup-runtime.js';

const LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION = 'lookup_runtime_bundle_cache.v1' as const;

export interface LookupRuntimeBundleCacheArtifactPaths {
  readonly lookupAliasRuntimeJson: string;
  readonly lookupAliasBroadRecallRuntimeJson?: string;
  readonly lookupExactSafeRuntimeJson: string;
  readonly lookupResolverProjectionJson: string;
  readonly lookupAmbiguityRuntimeJson: string;
  readonly lookupConceptRedirectRuntimeJson: string;
}

export interface LookupRuntimeBundleCachePaths {
  readonly cachePath: string;
  readonly metaPath: string;
}

export interface LookupRuntimeBundleCachePayload {
  readonly schemaVersion: typeof LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly aliasContentHash: string;
  readonly manifestPath: string;
  readonly artifactPaths: LookupRuntimeBundleCacheArtifactPaths;
  readonly aliasRuntimeArtifact: LookupAliasRuntimeArtifact | LookupAliasRuntimeCoreArtifact;
  readonly aliasBroadRecallRuntimeArtifact?: LookupAliasBroadRecallRuntimeArtifact;
  readonly exactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
  readonly compactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
  readonly resolverProjectionDocuments: readonly (readonly [string, LookupResolverProjection])[];
  readonly ambiguityEntries: readonly (readonly [string, AmbiguityInfo])[];
  readonly conceptRedirectEntries: readonly (readonly [string, LookupConceptRedirectInfo])[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deriveLookupRuntimeBundleCachePaths(
  manifestPath: string,
): LookupRuntimeBundleCachePaths {
  const snapshotRoot = path.dirname(manifestPath);
  return {
    cachePath: path.join(snapshotRoot, 'lookup-runtime-bundle-cache.v8'),
    metaPath: path.join(snapshotRoot, 'lookup-runtime-bundle-cache.meta.json'),
  };
}

export function buildLookupRuntimeBundleCachePayload(args: {
  readonly snapshotId: string;
  readonly aliasContentHash: string;
  readonly manifestPath: string;
  readonly artifactPaths: LookupRuntimeBundleCacheArtifactPaths;
  readonly aliasRuntimeArtifact: LookupAliasRuntimeArtifact | LookupAliasRuntimeCoreArtifact;
  readonly aliasBroadRecallRuntimeArtifact?: LookupAliasBroadRecallRuntimeArtifact;
  readonly exactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
  readonly compactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
  readonly resolverProjectionDocuments: readonly (readonly [string, LookupResolverProjection])[];
  readonly ambiguityEntries: readonly (readonly [string, AmbiguityInfo])[];
  readonly conceptRedirectEntries: readonly (readonly [string, LookupConceptRedirectInfo])[];
}): LookupRuntimeBundleCachePayload {
  return {
    schemaVersion: LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    aliasContentHash: args.aliasContentHash,
    manifestPath: args.manifestPath,
    artifactPaths: args.artifactPaths,
    aliasRuntimeArtifact: args.aliasRuntimeArtifact,
    ...(args.aliasBroadRecallRuntimeArtifact !== undefined
      ? { aliasBroadRecallRuntimeArtifact: args.aliasBroadRecallRuntimeArtifact }
      : {}),
    exactEntries: args.exactEntries,
    compactEntries: args.compactEntries,
    resolverProjectionDocuments: args.resolverProjectionDocuments,
    ambiguityEntries: args.ambiguityEntries,
    conceptRedirectEntries: args.conceptRedirectEntries,
  };
}

async function atomicWriteBuffer(filePath: string, content: Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  await fs.writeFile(tmpPath, content);
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath: string, content: unknown): Promise<void> {
  await atomicWriteBuffer(
    filePath,
    Buffer.from(`${JSON.stringify(content, null, 2)}\n`, 'utf8'),
  );
}

export async function writeLookupRuntimeBundleCache(
  payload: LookupRuntimeBundleCachePayload,
): Promise<LookupRuntimeBundleCachePaths> {
  const paths = deriveLookupRuntimeBundleCachePaths(payload.manifestPath);
  await atomicWriteBuffer(paths.cachePath, serialize(payload));
  await atomicWriteJson(paths.metaPath, {
    schemaVersion: LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION,
    snapshotId: payload.snapshotId,
    aliasContentHash: payload.aliasContentHash,
    manifestPath: payload.manifestPath,
    artifactPaths: payload.artifactPaths,
    cachePath: paths.cachePath,
    generatedAt: new Date().toISOString(),
    counts: {
      exactEntries: payload.exactEntries.length,
      compactEntries: payload.compactEntries.length,
      resolverProjectionDocuments: payload.resolverProjectionDocuments.length,
      ambiguityEntries: payload.ambiguityEntries.length,
      conceptRedirectEntries: payload.conceptRedirectEntries.length,
    },
  });
  return paths;
}

function validateLookupRuntimeBundleCachePayload(
  payload: unknown,
  expected: {
    readonly snapshotId: string;
    readonly aliasContentHash: string;
    readonly manifestPath: string;
    readonly artifactPaths: LookupRuntimeBundleCacheArtifactPaths;
  },
): LookupRuntimeBundleCachePayload {
  if (!isRecord(payload)) {
    throw new Error('cache payload root is not an object');
  }
  if (payload.schemaVersion !== LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION) {
    throw new Error(
      `cache schemaVersion mismatch: expected ${LOOKUP_RUNTIME_BUNDLE_CACHE_SCHEMA_VERSION}, got ${String(payload.schemaVersion)}`,
    );
  }
  if (payload.snapshotId !== expected.snapshotId) {
    throw new Error(`cache snapshotId mismatch: ${String(payload.snapshotId)} != ${expected.snapshotId}`);
  }
  if (payload.aliasContentHash !== expected.aliasContentHash) {
    throw new Error(
      `cache aliasContentHash mismatch: ${String(payload.aliasContentHash)} != ${expected.aliasContentHash}`,
    );
  }
  if (payload.manifestPath !== expected.manifestPath) {
    throw new Error(`cache manifestPath mismatch: ${String(payload.manifestPath)} != ${expected.manifestPath}`);
  }
  if (!isRecord(payload.artifactPaths)) {
    throw new Error('cache artifactPaths is not an object');
  }
  for (const [key, expectedValue] of Object.entries(expected.artifactPaths)) {
    if ((payload.artifactPaths as Record<string, unknown>)[key] !== expectedValue) {
      throw new Error(`cache artifactPaths.${key} mismatch`);
    }
  }
  if (!Array.isArray(payload.exactEntries)) {
    throw new Error('cache exactEntries is not an array');
  }
  if (!Array.isArray(payload.compactEntries)) {
    throw new Error('cache compactEntries is not an array');
  }
  if (!Array.isArray(payload.resolverProjectionDocuments)) {
    throw new Error('cache resolverProjectionDocuments is not an array');
  }
  if (!Array.isArray(payload.ambiguityEntries)) {
    throw new Error('cache ambiguityEntries is not an array');
  }
  if (!Array.isArray(payload.conceptRedirectEntries)) {
    throw new Error('cache conceptRedirectEntries is not an array');
  }
  if (!isRecord(payload.aliasRuntimeArtifact)) {
    throw new Error('cache aliasRuntimeArtifact is not an object');
  }
  if (
    payload.aliasBroadRecallRuntimeArtifact !== undefined
    && !isRecord(payload.aliasBroadRecallRuntimeArtifact)
  ) {
    throw new Error('cache aliasBroadRecallRuntimeArtifact is not an object');
  }
  return payload as unknown as LookupRuntimeBundleCachePayload;
}

export async function readLookupRuntimeBundleCache(args: {
  readonly manifestPath: string;
  readonly snapshotId: string;
  readonly aliasContentHash: string;
  readonly artifactPaths: LookupRuntimeBundleCacheArtifactPaths;
}): Promise<LookupRuntimeBundleCachePayload | undefined> {
  const { cachePath } = deriveLookupRuntimeBundleCachePaths(args.manifestPath);
  try {
    const raw = await fs.readFile(cachePath);
    const parsed = deserialize(raw);
    return validateLookupRuntimeBundleCachePayload(parsed, {
      snapshotId: args.snapshotId,
      aliasContentHash: args.aliasContentHash,
      manifestPath: args.manifestPath,
      artifactPaths: args.artifactPaths,
    });
  } catch {
    return undefined;
  }
}
