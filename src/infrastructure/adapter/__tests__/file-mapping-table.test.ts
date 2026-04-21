import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMappingTableAdapter } from '../file-mapping-table.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'file-mapping-table-'));
}

describe('FileMappingTableAdapter', () => {
  it('loads planner-shaped runtime NL mappings and resolves Pinot Grigio correctly', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'nl-mappings.json');
    await fs.writeFile(filePath, JSON.stringify({
      version: 'ontology-snapshot-v1.0',
      generatedAt: '2026-04-17T00:00:00.000Z',
      mappingCount: 2,
      mappings: [
        {
          phrase: '피노 그리지오',
          mappedAttribute: 'grape_primary',
          operator: '=',
          value: 'Pinot Gris',
          mappingConfidence: 0.95,
          mappingVersion: 'ontology-snapshot-v1.0',
          source: 'ontology_snapshot:grape_primary:pinot gris',
        },
        {
          phrase: '피노 그리',
          mappedAttribute: 'grape_primary',
          operator: '=',
          value: 'Pinot Gris',
          mappingConfidence: 0.95,
          mappingVersion: 'ontology-snapshot-v1.0',
          source: 'ontology_snapshot:grape_primary:pinot gris',
        },
      ],
    }), 'utf8');

    const adapter = await FileMappingTableAdapter.create(filePath);
    await expect(adapter.findMapping('피노 그리지오')).resolves.toMatchObject({
      mappedAttribute: 'grape_primary',
      value: 'Pinot Gris',
    });
  });

  it('fails loud on legacy alias-snapshot rows that do not match planner NLMapping schema', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'nl-mappings.json');
    await fs.writeFile(filePath, JSON.stringify({
      version: 'ontology-snapshot-v1.0',
      generatedAt: '2026-04-17T00:00:00.000Z',
      mappingCount: 1,
      mappings: [
        {
          surface: '피노 그리지오',
          entityId: 'grape_primary:pinot gris',
          canonical: 'Pinot Gris',
          entityType: 'grape_primary',
        },
      ],
    }), 'utf8');

    await expect(FileMappingTableAdapter.create(filePath)).rejects.toThrow(/Invalid NL mapping file/);
  });
});
