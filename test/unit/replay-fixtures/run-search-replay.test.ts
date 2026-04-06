import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

interface FixtureFile {
  readonly name?: string;
  readonly expected?: {
    readonly execution_mode?: string;
    readonly degradation_reasons?: readonly string[];
  };
}

describe('search replay fixtures', () => {
  const dir = path.join(process.cwd(), 'test/replay-fixtures/search');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    : [];

  it('has at least one JSON fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`fixture ${file} has expected block`, () => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const fixture = JSON.parse(raw) as FixtureFile;
      expect(fixture.expected?.execution_mode).toBeDefined();
      expect(Array.isArray(fixture.expected?.degradation_reasons)).toBe(true);
    });
  }
});
