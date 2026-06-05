import fs from 'node:fs/promises';
import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import {
  parseLookupConceptRedirectRuntimeArtifact,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';
import type {
  LookupConceptRedirectInfo,
  LookupConceptRedirectRegistryPort,
} from '../../domain/resolver/v2/lookup-v2-types.js';

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupConceptRedirectRuntimeJson: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseConceptRedirectRuntimePath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const artifactPath = manifest.artifacts.lookupConceptRedirectRuntimeJson;
  if (artifactPath.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupConceptRedirectRuntimeJson is required`,
    );
  }
  return artifactPath;
}

function parseConceptRedirectRuntime(
  raw: string,
  artifactPath: string,
): ReadonlyMap<string, LookupConceptRedirectInfo> {
  const artifact = parseLookupConceptRedirectRuntimeArtifact(raw, artifactPath);
  return new Map(
    Object.entries(artifact.entries).map(([normalizedForm, entry]) => [
      normalizedForm,
      {
        conceptClass: entry.conceptClass,
        redirectReason: entry.redirectReason,
        sourceEvidence: entry.sourceEvidence,
      },
    ]),
  );
}

export class SearchSnapshotConceptRedirectRegistry implements LookupConceptRedirectRegistryPort {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotConceptRedirectRegistry> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const artifactPath = parseConceptRedirectRuntimePath(manifestRaw, manifestPath);
    const artifactRaw = await fs.readFile(artifactPath, 'utf8');
    const entries = parseConceptRedirectRuntime(artifactRaw, artifactPath);
    bootstrapLogger.info(
      {
        manifestPath,
        artifactPath,
        entryCount: entries.size,
      },
      '[Container] Search snapshot concept redirect runtime loaded from manifest into memory',
    );
    return new SearchSnapshotConceptRedirectRegistry(entries);
  }

  constructor(private readonly entries: ReadonlyMap<string, LookupConceptRedirectInfo>) {}

  get(surfaceForm: string): LookupConceptRedirectInfo | null {
    return this.entries.get(surfaceForm) ?? null;
  }
}
