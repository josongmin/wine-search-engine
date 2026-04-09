import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityId } from '../../shared/types/index.js';
import type { SourceTrustProfile } from '../model/source-trust-profile.js';
import type { CanonicalizationCandidate } from '../model/canonicalization-candidate.js';
import { EntityMatcher, type EntityRepository, type MatchableEntity } from '../service/entity-matcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const entityId = (id: string): EntityId => id as unknown as EntityId;

const highTrust: SourceTrustProfile = {
  sourceSystem: 'test',
  titleReliability: 0.9,
  producerReliability: 0.9,
  regionReliability: 0.9,
  vintageReliability: 0.9,
  attributeReliability: 0.9,
  marketplaceNoiseRisk: 0.1,
};

const lowTrust: SourceTrustProfile = {
  sourceSystem: 'test-low',
  titleReliability: 0.3,
  producerReliability: 0.3,
  regionReliability: 0.3,
  vintageReliability: 0.3,
  attributeReliability: 0.3,
  marketplaceNoiseRisk: 0.8,
};

function makeCandidate(
  overrides: Partial<CanonicalizationCandidate> = {},
): CanonicalizationCandidate {
  return {
    candidateId: 'cand-1',
    sourceRecordId: 'src-1',
    normalizedTitle: 'Opus One 2018',
    extracted: {
      producer: 'Opus One Winery',
      wineLabel: 'Opus One',
      vintage: 2018,
      region: 'Napa Valley',
    },
    noiseFlags: [],
    aliasCandidates: [],
    parsingConfidence: 0.85,
    ...overrides,
  };
}

function makeEntity(id: string, overrides: Partial<MatchableEntity> = {}): MatchableEntity {
  return {
    entityId: entityId(id),
    canonicalName: 'Opus One 2018',
    producer: 'Opus One Winery',
    label: 'Opus One',
    vintage: 2018,
    region: 'Napa Valley',
    ...overrides,
  };
}

function createMockRepo(): EntityRepository {
  return {
    findByExternalRef: vi.fn<EntityRepository['findByExternalRef']>().mockResolvedValue([]),
    findByProducerAndLabel: vi.fn<EntityRepository['findByProducerAndLabel']>().mockResolvedValue([]),
    findByLabelAndRegion: vi.fn<EntityRepository['findByLabelAndRegion']>().mockResolvedValue([]),
    findByAlias: vi.fn<EntityRepository['findByAlias']>().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityMatcher', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let matcher: EntityMatcher;

  beforeEach(() => {
    repo = createMockRepo();
    matcher = new EntityMatcher(repo);
  });

  // 1. External ref exact match
  describe('external ref matching', () => {
    it('returns matched with 0.95 confidence when exactly 1 entity found', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByExternalRef).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        externalRefs: [{ type: 'lwin', value: 'LWIN-123' }],
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      expect(result.confidence).toBe(0.95);
      expect(result.matchedEntityIds).toEqual([entityId('entity-1')]);
      expect(result.reasons[0]).toContain('lwin');
    });

    // 2. External ref ambiguous
    it('returns ambiguous with 0.50 confidence when 2+ entities found', async () => {
      const entities = [makeEntity('entity-1'), makeEntity('entity-2')];
      vi.mocked(repo.findByExternalRef).mockResolvedValue(entities);

      const candidate = makeCandidate({
        externalRefs: [{ type: 'lwin', value: 'LWIN-DUP' }],
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('ambiguous');
      expect(result.confidence).toBe(0.50);
      expect(result.matchedEntityIds).toHaveLength(2);
      expect(result.reasons[0]).toContain('Multiple');
    });

    // 3. External ref no match → falls through
    it('falls through to producer+label when external ref finds nothing', async () => {
      vi.mocked(repo.findByExternalRef).mockResolvedValue([]);
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        externalRefs: [{ type: 'lwin', value: 'LWIN-NONE' }],
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      expect(repo.findByProducerAndLabel).toHaveBeenCalled();
    });
  });

  // 4. Producer + Label + Vintage exact match
  describe('producer + label + vintage matching', () => {
    it('returns matched with trust-adjusted ~0.90 confidence', async () => {
      const entity = makeEntity('entity-1', { vintage: 2018 });
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate();
      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      // 0.90 * 0.7 + avg(0.9, 0.9) * 0.3 = 0.63 + 0.27 = 0.90
      expect(result.confidence).toBeCloseTo(0.90, 2);
      expect(result.matchedEntityIds).toEqual([entityId('entity-1')]);
      expect(result.reasons[0]).toContain('vintage');
    });

    it('returns ambiguous when multiple entities match producer+label+vintage', async () => {
      const entities = [
        makeEntity('entity-1', { vintage: 2018 }),
        makeEntity('entity-2', { vintage: 2018 }),
      ];
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue(entities);

      const candidate = makeCandidate();
      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('ambiguous');
      expect(result.confidence).toBe(0.50);
      expect(result.matchedEntityIds).toHaveLength(2);
    });

    it('falls through to producer+label when vintage does not match', async () => {
      const entity = makeEntity('entity-1', { vintage: 2017 });
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate();
      const result = await matcher.match(candidate, highTrust);

      // No vintage match → falls through to step 3 (producer+label)
      // which has the same entity (1 result) → matched at producer+label confidence
      expect(result.status).toBe('matched');
      expect(result.reasons[0]).toContain('producer + label');
      expect(result.reasons[0]).not.toContain('vintage');
    });
  });

  // 5. Producer + Label (without vintage)
  describe('producer + label matching (no vintage)', () => {
    it('returns matched with trust-adjusted ~0.75 confidence', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        extracted: { producer: 'Opus One Winery', wineLabel: 'Opus One' },
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      // 0.75 * 0.7 + 0.9 * 0.3 = 0.525 + 0.27 = 0.795
      expect(result.confidence).toBeCloseTo(0.795, 2);
      expect(result.matchedEntityIds).toEqual([entityId('entity-1')]);
    });

    // 10. Multiple matches (ambiguous) for producer+label
    it('returns ambiguous when 2+ entities match producer+label', async () => {
      const entities = [makeEntity('entity-1'), makeEntity('entity-2')];
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue(entities);

      const candidate = makeCandidate({
        extracted: { producer: 'Opus One Winery', wineLabel: 'Opus One' },
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('ambiguous');
      expect(result.confidence).toBe(0.50);
      expect(result.matchedEntityIds).toHaveLength(2);
    });
  });

  // 6. Label + Region
  describe('label + region matching', () => {
    it('returns matched with trust-adjusted ~0.60 confidence', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByLabelAndRegion).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        extracted: { wineLabel: 'Opus One', region: 'Napa Valley' },
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      // 0.60 * 0.7 + 0.9 * 0.3 = 0.42 + 0.27 = 0.69
      expect(result.confidence).toBeCloseTo(0.69, 2);
      expect(result.matchedEntityIds).toEqual([entityId('entity-1')]);
      expect(result.reasons[0]).toContain('region');
    });

    it('returns ambiguous when 2+ entities match label+region', async () => {
      const entities = [makeEntity('entity-1'), makeEntity('entity-2')];
      vi.mocked(repo.findByLabelAndRegion).mockResolvedValue(entities);

      const candidate = makeCandidate({
        extracted: { wineLabel: 'Opus One', region: 'Napa Valley' },
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('ambiguous');
      expect(result.confidence).toBe(0.50);
    });
  });

  // 7. No match → new_entity_candidate
  describe('no match found', () => {
    it('returns new_entity_candidate with parsingConfidence', async () => {
      const candidate = makeCandidate({ parsingConfidence: 0.72 });
      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('new_entity_candidate');
      expect(result.confidence).toBe(0.72);
      expect(result.matchedEntityIds).toBeUndefined();
      expect(result.reasons[0]).toContain('No matching entity');
    });

    it('returns new_entity_candidate when extracted fields are empty', async () => {
      const candidate = makeCandidate({
        extracted: {},
        parsingConfidence: 0.40,
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('new_entity_candidate');
      expect(result.confidence).toBe(0.40);
    });
  });

  // 8. Trust modifier reduces confidence
  describe('trust modifier', () => {
    it('low trust scores reduce confidence for producer+label+vintage', async () => {
      const entity = makeEntity('entity-1', { vintage: 2018 });
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate();

      const highResult = await matcher.match(candidate, highTrust);

      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);
      const lowResult = await matcher.match(candidate, lowTrust);

      expect(lowResult.confidence).toBeLessThan(highResult.confidence);
      // 0.90 * 0.7 + avg(0.3, 0.3) * 0.3 = 0.63 + 0.09 = 0.72
      expect(lowResult.confidence).toBeCloseTo(0.72, 2);
    });

    it('low trust scores reduce confidence for label+region', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByLabelAndRegion).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        extracted: { wineLabel: 'Opus One', region: 'Napa Valley' },
      });

      const result = await matcher.match(candidate, lowTrust);

      // 0.60 * 0.7 + 0.3 * 0.3 = 0.42 + 0.09 = 0.51
      expect(result.confidence).toBeCloseTo(0.51, 2);
    });
  });

  // 9. Cascade order: external ref short-circuits
  describe('cascade order', () => {
    it('external ref match short-circuits producer+label check', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByExternalRef).mockResolvedValue([entity]);

      const candidate = makeCandidate({
        externalRefs: [{ type: 'lwin', value: 'LWIN-123' }],
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      expect(result.confidence).toBe(0.95);
      expect(repo.findByProducerAndLabel).not.toHaveBeenCalled();
      expect(repo.findByLabelAndRegion).not.toHaveBeenCalled();
    });

    it('producer+label+vintage match short-circuits label+region check', async () => {
      const entity = makeEntity('entity-1', { vintage: 2018 });
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate();
      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      expect(repo.findByLabelAndRegion).not.toHaveBeenCalled();
    });

    it('iterates through multiple external refs until a match is found', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByExternalRef)
        .mockResolvedValueOnce([])       // first ref: no match
        .mockResolvedValueOnce([entity]); // second ref: match

      const candidate = makeCandidate({
        externalRefs: [
          { type: 'lwin', value: 'LWIN-MISS' },
          { type: 'wine-searcher', value: 'WS-123' },
        ],
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('matched');
      expect(result.confidence).toBe(0.95);
      expect(repo.findByExternalRef).toHaveBeenCalledTimes(2);
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('skips external ref step when externalRefs is undefined', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate({ externalRefs: undefined });
      const result = await matcher.match(candidate, highTrust);

      expect(repo.findByExternalRef).not.toHaveBeenCalled();
      expect(result.status).toBe('matched');
    });

    it('skips external ref step when externalRefs is empty array', async () => {
      const entity = makeEntity('entity-1');
      vi.mocked(repo.findByProducerAndLabel).mockResolvedValue([entity]);

      const candidate = makeCandidate({ externalRefs: [] });
      const result = await matcher.match(candidate, highTrust);

      expect(repo.findByExternalRef).not.toHaveBeenCalled();
      expect(result.status).toBe('matched');
    });

    it('handles candidate with only label (no producer, no region)', async () => {
      const candidate = makeCandidate({
        extracted: { wineLabel: 'Mystery Wine' },
        parsingConfidence: 0.50,
      });

      const result = await matcher.match(candidate, highTrust);

      expect(result.status).toBe('new_entity_candidate');
      expect(result.confidence).toBe(0.50);
    });
  });
});
