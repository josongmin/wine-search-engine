/**
 * Feature parity checker (T13-9).
 *
 * Startup check that verifies the serving-time LTR feature schema hash
 * matches the train-time hash that was captured when the model artifact
 * was produced. A mismatch means silent prediction corruption — the
 * trained model expects a different feature layout than what the serving
 * code will produce.
 *
 * Intended call site: once during application startup, after the model
 * artifact metadata is loaded. Strict mode throws so a misconfigured
 * deployment fails fast rather than degrading silently.
 */

import { getCurrentFeatureSchemaHash } from './feature-parity-hash.js';

export interface ParityCheckResult {
  readonly match: boolean;
  readonly currentHash: string;
  readonly expectedHash?: string;
  readonly reason: string;
}

export interface FeatureParityCheckerOptions {
  /** Hash from training-time snapshot (loaded from model artifact). */
  readonly expectedHash?: string;
  /** Strict mode: throw on mismatch instead of returning false. */
  readonly strict?: boolean;
}

export class FeatureParityCheckError extends Error {
  public readonly result: ParityCheckResult;

  constructor(message: string, result: ParityCheckResult) {
    super(message);
    this.name = 'FeatureParityCheckError';
    this.result = result;
  }
}

export function checkFeatureParity(
  options: FeatureParityCheckerOptions,
): ParityCheckResult {
  const currentHash = getCurrentFeatureSchemaHash();
  const expectedHash = options.expectedHash;

  if (expectedHash === undefined) {
    return {
      match: true,
      currentHash,
      reason: 'no expected hash provided (parity check skipped)',
    };
  }

  if (expectedHash === currentHash) {
    return {
      match: true,
      currentHash,
      expectedHash,
      reason: 'feature schema hash matches training snapshot',
    };
  }

  const result: ParityCheckResult = {
    match: false,
    currentHash,
    expectedHash,
    reason: `feature schema drift detected: trained on ${expectedHash}, serving ${currentHash}`,
  };

  if (options.strict === true) {
    throw new FeatureParityCheckError(result.reason, result);
  }

  return result;
}
