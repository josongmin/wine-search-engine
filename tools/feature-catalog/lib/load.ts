import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FeatureSchema, type Feature } from '../schema/feature.schema.js';

export interface LoadedFeature {
  readonly feature: Feature;
  readonly sourcePath: string;
}

function walkYamlFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkYamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * YAML parses empty values as `null`. We want Zod `.optional()`/`.default()`
 * to fire on those — so coerce all `null` to `undefined` recursively before
 * schema validation.
 */
function nullToUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(nullToUndefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = nullToUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

export function loadFeaturesFromDir(
  featuresDir: string,
): readonly LoadedFeature[] {
  const yamlFiles = walkYamlFiles(featuresDir);
  const loaded: LoadedFeature[] = [];
  for (const sourcePath of yamlFiles) {
    const raw = readFileSync(sourcePath, 'utf-8');
    const parsedRaw: unknown = parseYaml(raw);
    const cleaned = nullToUndefined(parsedRaw);
    const result = FeatureSchema.safeParse(cleaned);
    if (!result.success) {
      const formatted = result.error.errors
        .map((e) => `    - ${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('\n');
      throw new Error(
        `[catalog] schema validation failed in ${sourcePath}:\n${formatted}`,
      );
    }
    loaded.push({ feature: result.data, sourcePath });
  }
  loaded.sort((a, b) => a.feature.id.localeCompare(b.feature.id));
  return loaded;
}
