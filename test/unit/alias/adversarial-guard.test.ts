import { describe, it, expect } from 'vitest';
import { AdversarialGuard } from '../../../src/domain/alias/service/adversarial-guard.js';
import type { Alias } from '../../../src/domain/alias/model/alias.js';

const guard = new AdversarialGuard();

function makeAlias(value: string, entityId: string = 'entity-1'): Alias {
  return {
    aliasId: `alias-${value}`,
    entityId: entityId as any,
    value,
    normalizedValue: value.toLowerCase(),
    type: 'canonical',
    confidencePrior: 0.9,
    source: 'test',
    scope: 'global',
    suppressed: false,
  };
}

describe('AdversarialGuard', () => {
  describe('checkHomoglyph', () => {
    it('Cyrillic А (U+0410) in alias value → fails check', () => {
      const cyrillic = '\u0410lex'; // Cyrillic А followed by 'lex'
      const existing = [makeAlias('Alex')]; // Latin A
      const result = guard.checkHomoglyph(cyrillic, existing);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Homoglyph');
    });

    it('fully Latin alias with no homoglyphs → passes', () => {
      const result = guard.checkHomoglyph('Opus One', []);
      expect(result.passed).toBe(true);
    });

    it('Cyrillic characters that do not collide with existing → passes', () => {
      // Cyrillic А but no existing alias matches after deconfusion
      const cyrillic = '\u0410'; // Cyrillic А → deconfused to 'a'
      const existing = [makeAlias('Bordeaux')]; // 'bordeaux' !== 'a'
      const result = guard.checkHomoglyph(cyrillic, existing);
      expect(result.passed).toBe(true);
    });

    it('value without any homoglyphs → passes regardless of existing aliases', () => {
      const result = guard.checkHomoglyph('château', [makeAlias('chateau')]);
      expect(result.passed).toBe(true);
    });

    it('value IS identical to existing (no deconfusion needed) → not a homoglyph attack', () => {
      // Same value is not an attack
      const result = guard.checkHomoglyph('Opus One', [makeAlias('Opus One')]);
      // No homoglyphs in 'Opus One', so check passes
      expect(result.passed).toBe(true);
    });
  });

  describe('checkVelocity', () => {
    it('51 aliases for same entity+source → fails velocity check', () => {
      const result = guard.checkVelocity('entity-1' as any, 'catalog-source', 51);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Velocity limit exceeded');
      expect(result.reason).toContain('51');
    });

    it('exactly 50 aliases → passes (threshold is >50)', () => {
      const result = guard.checkVelocity('entity-1' as any, 'catalog-source', 50);
      expect(result.passed).toBe(true);
    });

    it('1 alias → passes', () => {
      const result = guard.checkVelocity('entity-1' as any, 'any-source', 1);
      expect(result.passed).toBe(true);
    });

    it('reason includes entity and source identifiers when failing', () => {
      const result = guard.checkVelocity('entity-XYZ' as any, 'source-ABC', 100);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('source-ABC');
      expect(result.reason).toContain('entity-XYZ');
    });
  });

  describe('checkSourceTrustGate', () => {
    it('high noise source (0.95) creating canonical alias → fails', () => {
      // canonical max noise = 0.9; 0.95 > 0.9
      const result = guard.checkSourceTrustGate(0.95, 'canonical');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('canonical');
    });

    it('low noise source (0.5) creating canonical alias → passes', () => {
      const result = guard.checkSourceTrustGate(0.5, 'canonical');
      expect(result.passed).toBe(true);
    });

    it('moderate noise source (0.75) creating translation alias → fails', () => {
      // translation max noise = 0.7; 0.75 > 0.7
      const result = guard.checkSourceTrustGate(0.75, 'translation');
      expect(result.passed).toBe(false);
    });

    it('moderate noise source (0.65) creating translation alias → passes', () => {
      // translation max noise = 0.7; 0.65 <= 0.7
      const result = guard.checkSourceTrustGate(0.65, 'translation');
      expect(result.passed).toBe(true);
    });

    it('high noise source can create catalog_noise_alias (max=0.3)', () => {
      // catalog_noise_alias max = 0.3
      const result = guard.checkSourceTrustGate(0.2, 'catalog_noise_alias');
      expect(result.passed).toBe(true);
    });

    it('source with noise=0.35 fails for catalog_noise_alias', () => {
      const result = guard.checkSourceTrustGate(0.35, 'catalog_noise_alias');
      expect(result.passed).toBe(false);
    });

    it('normal alias creation (low noise) → passes all checks', () => {
      const aliasTypes: Alias['type'][] = [
        'canonical', 'translation', 'phonetic', 'misspelling', 'observed_query_alias', 'catalog_noise_alias',
      ];
      // Very low noise source (0.1) should pass for all types
      for (const type of aliasTypes) {
        const result = guard.checkSourceTrustGate(0.1, type);
        expect(result.passed).toBe(true);
      }
    });
  });
});
