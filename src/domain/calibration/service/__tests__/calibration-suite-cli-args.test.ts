/**
 * Unit tests for the calibration-report CLI argument parser.
 *
 * The CLI itself lives under `scripts/eval/` (outside the tsconfig `src`
 * include), so we import via a relative path — vitest's own resolver loads
 * the file at runtime through tsx/esbuild.
 */

import { describe, it, expect } from 'vitest';

import { parseArgs } from '../../../../../scripts/eval/calibration-report.js';

describe('calibration-report parseArgs', () => {
  it('parses --input only', () => {
    const args = parseArgs(['--input', 'data/calibration/preds.ndjson']);
    expect(args.input).toBe('data/calibration/preds.ndjson');
    expect(args.output).toBeUndefined();
    expect(args.help).toBeUndefined();
  });

  it('parses --input and --output together', () => {
    const args = parseArgs([
      '--input',
      'data/calibration/preds.ndjson',
      '--output',
      'reports/calibration.json',
    ]);
    expect(args.input).toBe('data/calibration/preds.ndjson');
    expect(args.output).toBe('reports/calibration.json');
    expect(args.help).toBeUndefined();
  });

  it('sets help flag for --help', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });
});
