/**
 * Load + cache `ScenarioAnnotation` files from disk.
 *
 * Annotations live at `test/benchmark/agent/annotations/<scenarioId>.json`.
 * The runner loads them once at startup and queries by scenario id during
 * scoring. Missing files = no annotation (judge-only path).
 *
 * The loader is intentionally synchronous: annotations are small JSON
 * blobs and are read once per CLI invocation. Async would force the
 * runner to thread Promises through every scoring callsite.
 *
 * `parseScenarioAnnotation` enforces shape via Zod — bad JSON fails loudly
 * with the offending field path, matching the bench's strict-validation
 * posture (CLAUDE.md rule 11/12).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseScenarioAnnotation,
  type ScenarioAnnotation,
} from './annotation-schema.js';

/** Default annotation directory, resolved relative to this file. */
const DEFAULT_ANNOTATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'annotations',
);

/** File-name regex: <scenarioId>.json with optional zero-padding tolerated by parseInt. */
const ANNOTATION_FILE_PATTERN = /^(\d+)\.json$/u;
/** Max characters from a parse-error message preserved in the loader log line. */
const ERROR_MESSAGE_MAX_LENGTH = 200;

interface AnnotationLoadStats {
  /** Number of annotation files successfully parsed. */
  readonly loaded: number;
  /** Number of files that failed to parse (logged, but not fatal). */
  readonly failed: number;
  /** Paths of files that failed (for stderr surfacing). */
  readonly failedPaths: readonly string[];
}

interface AnnotationStore {
  readonly byScenarioId: ReadonlyMap<number, ScenarioAnnotation>;
  readonly stats: AnnotationLoadStats;
  /** Convenience accessor; returns undefined when no annotation exists. */
  get(scenarioId: number): ScenarioAnnotation | undefined;
}

/**
 * Build an in-memory annotation store from a directory of `<id>.json` files.
 * Defaults to the canonical `test/benchmark/agent/annotations/` location but
 * accepts an override for unit tests.
 *
 * Logs parse failures to stderr but never throws — a corrupted annotation
 * file MUST NOT crash the bench runner. The dimension that file would have
 * deterministically scored simply stays on the judge-only path.
 */
function loadAnnotations(dir: string = DEFAULT_ANNOTATION_DIR): AnnotationStore {
  const byScenarioId = new Map<number, ScenarioAnnotation>();
  const failedPaths: string[] = [];
  let loaded = 0;

  if (!existsSync(dir)) {
    return makeStore(byScenarioId, { loaded: 0, failed: 0, failedPaths: [] });
  }

  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`  [ANNOTATIONS] failed to read dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return makeStore(byScenarioId, { loaded: 0, failed: 0, failedPaths: [] });
  }

  for (const entry of entries) {
    const match = ANNOTATION_FILE_PATTERN.exec(entry);
    if (match === null) continue;
    const path = join(dir, entry);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = readFileSync(path, 'utf8');
      // CLAUDE.md rule 12: never JSON.parse(...) as T — cast to unknown first.
      const json = JSON.parse(raw) as unknown;
      const annotation = parseScenarioAnnotation(json);
      // File-name id MUST match the embedded scenarioId — catches copy-paste mistakes.
      const idFromName = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(idFromName) && annotation.scenarioId !== idFromName) {
        console.error(
          `  [ANNOTATIONS] ⚠ ${entry}: scenarioId in file (${annotation.scenarioId}) !== file name id (${idFromName}). Using file name id.`,
        );
      }
      byScenarioId.set(idFromName, annotation);
      loaded++;
    } catch (err) {
      failedPaths.push(path);
      console.error(
        `  [ANNOTATIONS] ⚠ ${path}: ${err instanceof Error ? err.message.slice(0, ERROR_MESSAGE_MAX_LENGTH) : String(err)}`,
      );
    }
  }

  return makeStore(byScenarioId, { loaded, failed: failedPaths.length, failedPaths });
}

function makeStore(
  byScenarioId: ReadonlyMap<number, ScenarioAnnotation>,
  stats: AnnotationLoadStats,
): AnnotationStore {
  return {
    byScenarioId,
    stats,
    get: (scenarioId: number) => byScenarioId.get(scenarioId),
  };
}

/**
 * Resolve the annotation directory used at module load time. Exposed so the
 * annotate CLI writes new files into the same location the runner reads from.
 */
export function defaultAnnotationDir(): string {
  return DEFAULT_ANNOTATION_DIR;
}
