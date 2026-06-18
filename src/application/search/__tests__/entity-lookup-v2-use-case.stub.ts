import { vi } from 'vitest';
import type { EntityLookupV2UseCasePort } from '../port/search-route-usecases.port.js';
import type { EntityLookupV2Result } from '../entity-lookup-v2/entity-lookup-v2.dto.js';

export function makeMinimalLookupV2FailedResult(
  overrides: Partial<Pick<EntityLookupV2Result, 'status' | 'topCandidate' | 'candidates'>> = {},
): EntityLookupV2Result {
  return {
    status: overrides.status ?? 'failed',
    decisionReason: 'test stub',
    normalizedQueryViews: {
      raw: '',
      strict: '',
      accentless: '',
      compact: '',
      vintageCanonicalized: '',
      vintageStripped: '',
      lookupVariants: [],
    },
    candidates: overrides.candidates ?? [],
    topCandidate: overrides.topCandidate ?? null,
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted',
      decisionReasonCode: 'test_stub',
      calibrationTrusted: false,
      queryClass: 'unknown',
      candidatePoolSize: 0,
      channelCoverage: [],
    },
    meta: {
      queryTimeMs: 0,
      version: 'test',
      engineSchemaVersion: 'entity_lookup_v2',
    },
  };
}

export function makeStubEntityLookupV2UseCase(
  executeImpl?: EntityLookupV2UseCasePort['execute'],
): EntityLookupV2UseCasePort {
  return {
    execute: executeImpl ?? vi.fn().mockResolvedValue(makeMinimalLookupV2FailedResult()),
  };
}
