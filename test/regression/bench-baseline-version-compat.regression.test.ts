/**
 * ADR-011 Phase 1b (PR2): `baseline.json` version compatibility.
 *
 * Locks the dual-emit baseline contract:
 *  - `"v3"` (legacy shape without graph fields) still parses under the new
 *    reader — one-release backward compatibility.
 *  - `"v4"` (current shape with `scrInferredGraph` / `csrInferredGraph`)
 *    parses as-is.
 *  - Unknown / misspelled versions fail loudly (fail-closed).
 *  - The baseline file checked into the repo uses the current version.
 *
 * Append-only: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASELINE_VERSION_CURRENT,
  BASELINE_VERSION_COMPATIBLE,
} from '../../test/benchmark/agent/runner.js';

const BASELINE_PATH = resolve(
  process.cwd(),
  'test/benchmark/agent/results/baseline.json',
);

describe('baseline.json — version compatibility window', () => {
  it('current version is "v4"', () => {
    expect(BASELINE_VERSION_CURRENT).toBe('v4');
  });

  it('compatible versions include v3 (legacy) and v4 (current)', () => {
    expect(BASELINE_VERSION_COMPATIBLE.has('v3')).toBe(true);
    expect(BASELINE_VERSION_COMPATIBLE.has('v4')).toBe(true);
  });

  it('unknown / misspelled versions are NOT in the compatible set (fail-closed)', () => {
    expect(BASELINE_VERSION_COMPATIBLE.has('v5')).toBe(false);
    expect(BASELINE_VERSION_COMPATIBLE.has('V4')).toBe(false); // case-sensitive
    expect(BASELINE_VERSION_COMPATIBLE.has('v4.0')).toBe(false);
    expect(BASELINE_VERSION_COMPATIBLE.has('')).toBe(false);
  });
});

describe('baseline.json — on-disk shape', () => {
  it('the committed baseline.json carries baselineVersion="v4"', () => {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['baselineVersion']).toBe('v4');
  });

  it('the committed baseline.json exposes the graph-aware fields (as null placeholders ok)', () => {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = parsed['summary'] as Record<string, unknown>;
    const extraction = summary['constraintExtraction'] as Record<string, unknown>;
    // Either the summary top-level (when the runner overwrites it) or the
    // human-readable constraintExtraction block carries the graph fields.
    // Our committed baseline uses constraintExtraction — assert that path.
    expect('scrInferredGraph' in extraction).toBe(true);
    expect('csrInferredGraph' in extraction).toBe(true);
  });
});

// ─── Legacy (v3) parses under the one-release compatibility window ───────

describe('baseline.json — legacy v3 compatibility', () => {
  it('a v3-shaped baseline (no baselineVersion) parses as "v3" effectively', () => {
    // Simulate a v3 file on disk — no baselineVersion, no graph fields.
    const v3Like: Record<string, unknown> = {
      timestamp: '2026-01-01T00:00:00.000Z',
      summary: { overallScore: 0.8 },
    };
    // The reader logic treats missing baselineVersion as 'v3'. Assert the
    // compatibility set accepts it so the runner's fail-closed branch does
    // not trigger on legacy files.
    const effective = typeof v3Like['baselineVersion'] === 'string'
      ? v3Like['baselineVersion']
      : 'v3';
    expect(BASELINE_VERSION_COMPATIBLE.has(effective)).toBe(true);
  });

  it('an unknown baselineVersion string fails the compatibility gate', () => {
    const bogus: Record<string, unknown> = {
      baselineVersion: 'v99-experimental',
      summary: { overallScore: 0.8 },
    };
    const effective = typeof bogus['baselineVersion'] === 'string'
      ? bogus['baselineVersion']
      : 'v3';
    expect(BASELINE_VERSION_COMPATIBLE.has(effective)).toBe(false);
  });
});
