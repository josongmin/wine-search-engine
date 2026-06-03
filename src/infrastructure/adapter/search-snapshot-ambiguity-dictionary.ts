import fs from 'node:fs/promises';
import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import {
  parseLookupAmbiguityRuntimeArtifact,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';
import type {
  AmbiguityDictionary,
  AmbiguityInfo,
} from '../../domain/query/port/ambiguity-dictionary.port.js';

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupAmbiguityRuntimeJson: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseAmbiguityRuntimePath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const artifactPath = manifest.artifacts.lookupAmbiguityRuntimeJson;
  if (artifactPath.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupAmbiguityRuntimeJson is required`,
    );
  }
  return artifactPath;
}

function parseAmbiguityRuntime(
  raw: string,
  artifactPath: string,
): ReadonlyMap<string, AmbiguityInfo> {
  const artifact = parseLookupAmbiguityRuntimeArtifact(raw, artifactPath);
  return new Map(
    Object.entries(artifact.entries).map(([normalizedForm, entry]) => [
      normalizedForm,
      {
        types: [...entry.types],
        severity: entry.severity,
        ...(entry.entityIds !== undefined ? { entityIds: [...entry.entityIds] } : {}),
      },
    ]),
  );
}

export class SearchSnapshotAmbiguityDictionary implements AmbiguityDictionary {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotAmbiguityDictionary> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const artifactPath = parseAmbiguityRuntimePath(manifestRaw, manifestPath);
    const artifactRaw = await fs.readFile(artifactPath, 'utf8');
    const entries = parseAmbiguityRuntime(artifactRaw, artifactPath);
    bootstrapLogger.info(
      {
        manifestPath,
        artifactPath,
        entryCount: entries.size,
      },
      '[Container] Search snapshot ambiguity runtime loaded from manifest into memory',
    );
    return new SearchSnapshotAmbiguityDictionary(entries);
  }

  constructor(private readonly entries: ReadonlyMap<string, AmbiguityInfo>) {}

  async isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    return this.entries.has(surfaceForm);
  }

  async getAmbiguityInfo(surfaceForm: string): Promise<AmbiguityInfo | null> {
    return this.entries.get(surfaceForm) ?? null;
  }

  async getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, AmbiguityInfo>> {
    const out = new Map<string, AmbiguityInfo>();
    for (const surfaceForm of new Set(surfaceForms)) {
      const info = this.entries.get(surfaceForm);
      if (info !== undefined) {
        out.set(surfaceForm, info);
      }
    }
    return out;
  }
}
