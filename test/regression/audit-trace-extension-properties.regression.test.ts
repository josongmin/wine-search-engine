/**
 * audit-trace-extension property-based regression test.
 *
 * Verifies that the AuditExtension envelope (SSoT for fallback_trace + versioning):
 *   1. Rejects unknown top-level keys (.strict()).
 *   2. Round-trips through JSON.stringify -> parse without loss.
 *   3. Validates every legal fallback_trace.fallback_applied layer.
 *   4. Honors schema_version v1 (default) and v2 (forward-compat).
 *   5. Preserves Korean / non-ASCII strings verbatim.
 *   6. Tolerates optional-field omission.
 *
 * APPEND-ONLY regression file — do not delete cases.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AuditExtensionEnvelopeSchema,
  AUDIT_EXTENSION_SCHEMA_VERSIONS,
  CURRENT_AUDIT_EXTENSION_SCHEMA_VERSION,
  type AuditExtensionEnvelope,
} from '../../src/domain/audit/model/audit-extension.js';

const NUM_RUNS = 100;

const validFallbackLayers = ['layer2', 'layer3', 'layer4', null] as const;

const fallbackTraceArb: fc.Arbitrary<NonNullable<AuditExtensionEnvelope['fallback_trace']>> = fc.record({
  fallback_applied: fc.constantFrom(...validFallbackLayers),
  reasoning_failure: fc.boolean(),
  failed_synthesis_attempts: fc.integer({ min: 0, max: 16 }),
  fallback_search_used: fc.boolean(),
});

const envelopeArb: fc.Arbitrary<AuditExtensionEnvelope> = fc.record(
  {
    schema_version: fc.constantFrom(...AUDIT_EXTENSION_SCHEMA_VERSIONS),
    request_id: fc.string({ minLength: 1, maxLength: 64 }),
    fallback_trace: fallbackTraceArb,
    corrective_retry_calibrated_confidence: fc.double({
      min: 0.5,
      max: 0.9,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    determinism_fingerprint: fc.string({
      unit: fc.constantFrom(
        '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
      ),
      minLength: 16,
      maxLength: 16,
    }),
    message: fc.string({ maxLength: 128 }),
  },
  { requiredKeys: ['fallback_trace'] },
);

describe('audit-trace-extension property-based regression', () => {
  describe('schema strictness', () => {
    it('rejects arbitrary extra top-level keys (100 runs)', () => {
      fc.assert(
        fc.property(
          envelopeArb,
          fc.string({ minLength: 1, maxLength: 24 }).filter(
            (key) =>
              ![
                'schema_version',
                'request_id',
                'fallback_trace',
                'corrective_retry_calibrated_confidence',
                'determinism_fingerprint',
                'message',
              ].includes(key),
          ),
          fc.jsonValue(),
          (envelope, extraKey, extraValue) => {
            const withExtra = { ...envelope, [extraKey]: extraValue };
            const result = AuditExtensionEnvelopeSchema.safeParse(withExtra);
            expect(result.success).toBe(false);
            if (!result.success) {
              const hasUnrecognizedIssue = result.error.issues.some(
                (issue) => issue.code === 'unrecognized_keys',
              );
              expect(hasUnrecognizedIssue).toBe(true);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects a concrete unknown top-level key with a specific error code', () => {
      const payload = {
        fallback_trace: {
          fallback_applied: null,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: false,
        },
        injected_attacker_field: 'rm -rf /',
      };
      const result = AuditExtensionEnvelopeSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const unrecognized = result.error.issues.find(
          (issue) => issue.code === 'unrecognized_keys',
        );
        expect(unrecognized).toBeDefined();
      }
    });
  });

  describe('round-trip stability', () => {
    it('parse(stringify(audit)) equals normalized audit (100 runs)', () => {
      fc.assert(
        fc.property(envelopeArb, (envelope) => {
          const parsed = AuditExtensionEnvelopeSchema.parse(envelope);
          const json = JSON.stringify(parsed);
          const reparsed = AuditExtensionEnvelopeSchema.parse(JSON.parse(json) as unknown);
          expect(JSON.stringify(reparsed)).toBe(json);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('preserves nested fallback_trace shape byte-for-byte', () => {
      const payload: AuditExtensionEnvelope = {
        fallback_trace: {
          fallback_applied: 'layer3',
          reasoning_failure: true,
          failed_synthesis_attempts: 2,
          fallback_search_used: true,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(payload);
      const json = JSON.stringify(parsed);
      const reparsed = AuditExtensionEnvelopeSchema.parse(JSON.parse(json) as unknown);
      expect(reparsed.fallback_trace).toEqual(payload.fallback_trace);
      expect(JSON.stringify(reparsed.fallback_trace)).toBe(
        JSON.stringify(payload.fallback_trace),
      );
    });
  });

  describe('fallback_trace layer enum exhaustiveness', () => {
    it.each(validFallbackLayers)('accepts fallback_applied=%s', (layer) => {
      const payload = {
        fallback_trace: {
          fallback_applied: layer,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: false,
        },
      };
      const result = AuditExtensionEnvelopeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejects invalid fallback_applied values', () => {
      const invalidValues = ['layer1', 'layer5', 'LAYER2', '', 'fallback', 0, true];
      for (const invalid of invalidValues) {
        const payload = {
          fallback_trace: {
            fallback_applied: invalid as never,
            reasoning_failure: false,
            failed_synthesis_attempts: 0,
            fallback_search_used: false,
          },
        };
        const result = AuditExtensionEnvelopeSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('schema versioning', () => {
    it('defaults schema_version to current when omitted (backward-compat)', () => {
      const v1Input = {
        fallback_trace: {
          fallback_applied: null,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: false,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(v1Input);
      expect(parsed.schema_version).toBe('1');
      expect(parsed.schema_version).toBe(CURRENT_AUDIT_EXTENSION_SCHEMA_VERSION);
    });

    it('accepts explicit schema_version=1 (v1 input)', () => {
      const v1Input = {
        schema_version: '1' as const,
        fallback_trace: {
          fallback_applied: 'layer2' as const,
          reasoning_failure: true,
          failed_synthesis_attempts: 1,
          fallback_search_used: false,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(v1Input);
      expect(parsed.schema_version).toBe('1');
    });

    it('accepts explicit schema_version=2 (forward-compat envelope)', () => {
      const v2Input = {
        schema_version: '2' as const,
        fallback_trace: {
          fallback_applied: 'layer4' as const,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: true,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(v2Input);
      expect(parsed.schema_version).toBe('2');
    });

    it('rejects unknown schema_version values', () => {
      const unknownVersions = ['0', '3', 'v1', '1.0', '', 1, null];
      for (const version of unknownVersions) {
        const payload = {
          schema_version: version as never,
          fallback_trace: {
            fallback_applied: null,
            reasoning_failure: false,
            failed_synthesis_attempts: 0,
            fallback_search_used: false,
          },
        };
        const result = AuditExtensionEnvelopeSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it('versions list is non-empty and includes the current version', () => {
      expect(AUDIT_EXTENSION_SCHEMA_VERSIONS.length).toBeGreaterThanOrEqual(1);
      expect(AUDIT_EXTENSION_SCHEMA_VERSIONS).toContain(
        CURRENT_AUDIT_EXTENSION_SCHEMA_VERSION,
      );
    });
  });

  describe('stable field presence and optional omission', () => {
    it('required fallback_trace must be present for non-null fallback audits', () => {
      const minimal = {
        fallback_trace: {
          fallback_applied: null,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: false,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(minimal);
      expect(parsed.fallback_trace).toBeDefined();
      expect(parsed.fallback_trace?.fallback_applied).toBeNull();
    });

    it('optional fields (request_id, message, determinism_fingerprint, corrective_retry_calibrated_confidence) may be omitted', () => {
      const minimal = {
        fallback_trace: {
          fallback_applied: null,
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: false,
        },
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(minimal);
      expect(parsed.request_id).toBeUndefined();
      expect(parsed.message).toBeUndefined();
      expect(parsed.determinism_fingerprint).toBeUndefined();
      expect(parsed.corrective_retry_calibrated_confidence).toBeUndefined();
    });

    it('all optional fields can be supplied together', () => {
      const full: AuditExtensionEnvelope = {
        schema_version: '1',
        request_id: 'req_abc123',
        fallback_trace: {
          fallback_applied: 'layer2',
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: true,
        },
        corrective_retry_calibrated_confidence: 0.7,
        determinism_fingerprint: 'abcdef0123456789',
        message: 'ok',
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(full);
      expect(parsed).toEqual(full);
    });
  });

  describe('Korean / non-ASCII content preservation', () => {
    it('preserves Korean request_id and message verbatim through round-trip', () => {
      const payload: AuditExtensionEnvelope = {
        request_id: '요청_식별자_2025년',
        fallback_trace: {
          fallback_applied: 'layer3',
          reasoning_failure: true,
          failed_synthesis_attempts: 2,
          fallback_search_used: false,
        },
        message: '에이전트 폴백이 적용되었습니다 — 레이어3',
      };
      const parsed = AuditExtensionEnvelopeSchema.parse(payload);
      expect(parsed.request_id).toBe('요청_식별자_2025년');
      expect(parsed.message).toBe('에이전트 폴백이 적용되었습니다 — 레이어3');

      const reparsed = AuditExtensionEnvelopeSchema.parse(
        JSON.parse(JSON.stringify(parsed)) as unknown,
      );
      expect(reparsed.request_id).toBe('요청_식별자_2025년');
      expect(reparsed.message).toBe('에이전트 폴백이 적용되었습니다 — 레이어3');
    });

    it('preserves accented Latin (é, ñ) and emoji content', () => {
      const payload: AuditExtensionEnvelope = {
        request_id: 'café_españa_🍷',
        fallback_trace: {
          fallback_applied: 'layer4',
          reasoning_failure: false,
          failed_synthesis_attempts: 0,
          fallback_search_used: true,
        },
        message: 'résumé naïve coöperate 🍇',
      };
      const reparsed = AuditExtensionEnvelopeSchema.parse(
        JSON.parse(JSON.stringify(AuditExtensionEnvelopeSchema.parse(payload))) as unknown,
      );
      expect(reparsed.request_id).toBe('café_españa_🍷');
      expect(reparsed.message).toBe('résumé naïve coöperate 🍇');
    });
  });
});
