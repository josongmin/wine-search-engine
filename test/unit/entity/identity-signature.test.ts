import { describe, it, expect } from 'vitest';
import { computeIdentitySignature } from '../../../src/domain/entity/model/identity-signature.js';

describe('computeIdentitySignature', () => {
  describe('wine entity', () => {
    it('same wine inputs produce the same signature', () => {
      const sig1 = computeIdentitySignature('wine', {
        canonicalLabel: 'Opus One',
        producerId: 'producer-opus-one',
        regionId: 'region-napa-valley',
      });
      const sig2 = computeIdentitySignature('wine', {
        canonicalLabel: 'Opus One',
        producerId: 'producer-opus-one',
        regionId: 'region-napa-valley',
      });
      expect(sig1).toBe(sig2);
    });

    it('different vintage does NOT change wine signature (vintage excluded from wine hash)', () => {
      // wine signature = hash(canonicalLabel + producerId + regionId), vintage excluded
      const sig1 = computeIdentitySignature('wine', {
        canonicalLabel: 'Opus One',
        producerId: 'producer-opus-one',
        regionId: 'region-napa-valley',
        vintageYear: 2018,
      });
      const sig2 = computeIdentitySignature('wine', {
        canonicalLabel: 'Opus One',
        producerId: 'producer-opus-one',
        regionId: 'region-napa-valley',
        vintageYear: 2019,
      });
      expect(sig1).toBe(sig2);
    });

    it('different vintage year produces different signature for VINTAGE entity', () => {
      const sig2018 = computeIdentitySignature('vintage', {
        canonicalLabel: 'Opus One 2018',
        wineId: 'wine-opus-one',
        vintageYear: 2018,
      });
      const sig2019 = computeIdentitySignature('vintage', {
        canonicalLabel: 'Opus One 2019',
        wineId: 'wine-opus-one',
        vintageYear: 2019,
      });
      expect(sig2018).not.toBe(sig2019);
    });

    it('producer mismatch → different wine signature', () => {
      const sig1 = computeIdentitySignature('wine', {
        canonicalLabel: 'Grand Vin',
        producerId: 'producer-A',
        regionId: 'region-bordeaux',
      });
      const sig2 = computeIdentitySignature('wine', {
        canonicalLabel: 'Grand Vin',
        producerId: 'producer-B',
        regionId: 'region-bordeaux',
      });
      expect(sig1).not.toBe(sig2);
    });

    it('canonical label is case-normalized before hashing', () => {
      const sigLower = computeIdentitySignature('wine', {
        canonicalLabel: 'opus one',
        producerId: 'prod-1',
        regionId: 'region-1',
      });
      const sigUpper = computeIdentitySignature('wine', {
        canonicalLabel: 'OPUS ONE',
        producerId: 'prod-1',
        regionId: 'region-1',
      });
      expect(sigLower).toBe(sigUpper);
    });

    it('throws when required wine fields are missing', () => {
      expect(() =>
        computeIdentitySignature('wine', {
          canonicalLabel: 'Opus One',
          // missing producerId and regionId
        }),
      ).toThrow();
    });
  });

  describe('type prefix prevents collision between wine and producer with same name', () => {
    it('wine with same label as producer has different signature', () => {
      const wineSig = computeIdentitySignature('wine', {
        canonicalLabel: 'Château Margaux',
        producerId: 'producer-margaux',
        regionId: 'region-margaux',
      });
      const producerSig = computeIdentitySignature('producer', {
        canonicalLabel: 'Château Margaux',
      });
      expect(wineSig).not.toBe(producerSig);
    });

    it('region with same label as producer has different signature', () => {
      const regionSig = computeIdentitySignature('region', {
        canonicalLabel: 'Bordeaux',
      });
      const producerSig = computeIdentitySignature('producer', {
        canonicalLabel: 'Bordeaux',
      });
      expect(regionSig).not.toBe(producerSig);
    });
  });

  describe('vintage entity', () => {
    it('same wineId + vintageYear → same signature', () => {
      const sig1 = computeIdentitySignature('vintage', {
        canonicalLabel: 'Opus One 2018',
        wineId: 'wine-opus-one',
        vintageYear: 2018,
      });
      const sig2 = computeIdentitySignature('vintage', {
        canonicalLabel: 'Opus One 2018',
        wineId: 'wine-opus-one',
        vintageYear: 2018,
      });
      expect(sig1).toBe(sig2);
    });

    it('throws when wineId is missing', () => {
      expect(() =>
        computeIdentitySignature('vintage', {
          canonicalLabel: 'Opus One 2018',
          vintageYear: 2018,
          // missing wineId
        }),
      ).toThrow('vintage signature requires wineId');
    });
  });

  describe('grape entity', () => {
    it('grape signature is deterministic from label', () => {
      const sig1 = computeIdentitySignature('grape', { canonicalLabel: 'Cabernet Sauvignon' });
      const sig2 = computeIdentitySignature('grape', { canonicalLabel: 'Cabernet Sauvignon' });
      expect(sig1).toBe(sig2);
    });

    it('different grapes → different signatures', () => {
      const cab = computeIdentitySignature('grape', { canonicalLabel: 'Cabernet Sauvignon' });
      const merlot = computeIdentitySignature('grape', { canonicalLabel: 'Merlot' });
      expect(cab).not.toBe(merlot);
    });
  });

  describe('signature is a non-empty hex string', () => {
    it('returns a hex string', () => {
      const sig = computeIdentitySignature('wine', {
        canonicalLabel: 'Test Wine',
        producerId: 'prod-1',
        regionId: 'region-1',
      });
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it('returns consistent length (SHA-256 = 64 hex chars)', () => {
      const sig = computeIdentitySignature('grape', { canonicalLabel: 'Merlot' });
      expect(sig).toHaveLength(64);
    });
  });
});
