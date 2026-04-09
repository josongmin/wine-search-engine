import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOntologySnapshot,
  ONTOLOGY_SNAPSHOT_VERSION,
} from '../../../src/domain/attribute/service/ontology-snapshot.js';

describe('entity ontology snapshot artifact', () => {
  it('matches the generated ontology nodes committed in data/entity-ontology.json', async () => {
    const raw = await readFile(
      resolve(process.cwd(), 'data/entity-ontology.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      version: string;
      generatedAt: string;
      nodes: unknown;
    };
    const generated = buildOntologySnapshot(parsed.generatedAt);

    expect(parsed.version).toBe(ONTOLOGY_SNAPSHOT_VERSION);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(generated.version).toBe(parsed.version);
    expect(generated.nodes).toEqual(parsed.nodes);
  });
});
