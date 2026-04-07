import { describe, expect, it, vi } from 'vitest';
import { parseNdjson } from '../../../scripts/etl/ndjson.js';

describe('parseNdjson', () => {
  it('parses valid rows and skips malformed lines', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = parseNdjson<{ id: number }>(
      '{"id":1}\nnot-json\n{"id":2}\n',
      'fixture.ndjson',
    );

    expect(parsed.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parsed.skipped).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '  Warning: malformed JSON at fixture.ndjson:2, skipping',
    );

    warnSpy.mockRestore();
  });

  it('caps per-line warnings and emits a summary once more than five rows fail', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const content = [
      '{"id":1}',
      'bad-1',
      'bad-2',
      'bad-3',
      'bad-4',
      'bad-5',
      'bad-6',
    ].join('\n');

    const parsed = parseNdjson<{ id: number }>(content, 'overflow.ndjson');

    expect(parsed.records).toEqual([{ id: 1 }]);
    expect(parsed.skipped).toBe(6);
    expect(warnSpy).toHaveBeenCalledTimes(6);
    expect(warnSpy.mock.calls.at(-1)?.[0]).toBe(
      '  Warning: 6 total malformed/invalid lines in overflow.ndjson',
    );

    warnSpy.mockRestore();
  });

  it('rejects records that fail the validator', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    interface Wine { id: number; name: string }
    const validator = (r: unknown): r is Wine =>
      typeof r === 'object' && r !== null && 'id' in r && 'name' in r;

    const content = [
      '{"id":1,"name":"Margaux"}',     // valid
      '{"id":2}',                       // missing name → rejected by validator
      '{"id":3,"name":"Petrus"}',       // valid
    ].join('\n');

    const parsed = parseNdjson<Wine>(content, 'wine.ndjson', validator);

    expect(parsed.records).toEqual([
      { id: 1, name: 'Margaux' },
      { id: 3, name: 'Petrus' },
    ]);
    expect(parsed.skipped).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '  Warning: schema mismatch at wine.ndjson:2, skipping',
    );

    warnSpy.mockRestore();
  });

  it('returns empty records for empty content', () => {
    const parsed = parseNdjson<{ id: number }>('', 'empty.ndjson');
    expect(parsed.records).toEqual([]);
    expect(parsed.skipped).toBe(0);
  });

  it('handles content with only empty lines', () => {
    const parsed = parseNdjson<{ id: number }>('\n\n\n', 'blank.ndjson');
    expect(parsed.records).toEqual([]);
    expect(parsed.skipped).toBe(0);
  });
});
