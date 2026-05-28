import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/etl/generate-abbreviation-aliases.ts');

describe('abbreviation-alias ETL loader is scoped to the active snapshot', () => {
  it('filters loadEntitiesFromIds through active_search_snapshot', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/FROM entities[\s\S]*search_snapshot_id = \([\s\S]*SELECT active_snapshot_id[\s\S]*entity_id = ANY/u);
  });

  it('filters loadAllEntities through active_search_snapshot', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/FROM entities[\s\S]*search_snapshot_id = \([\s\S]*SELECT active_snapshot_id[\s\S]*entity_type IN \('wine','vintage'\)/u);
  });
});
