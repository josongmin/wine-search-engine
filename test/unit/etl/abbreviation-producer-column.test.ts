import { describe, expect, it } from 'vitest';
import { toEntityRow } from '../../../scripts/etl/generate-abbreviation-aliases.js';

/**
 * Regression: producer lives in entities.METADATA, not attributes. Reading
 * attributes['producer'] silently yielded undefined for every row (the producer
 * HINT for the --llm path went missing). Pin metadata-first + attributes
 * fallback + JSONB null-guard so a wrong-column reintroduction fails this test.
 */
describe('toEntityRow — producer column (metadata, not attributes)', () => {
  it('reads producer from metadata', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'Opus One 2018', attributes: {}, metadata: { producer: 'Opus One Winery' } });
    expect(r.producer).toBe('Opus One Winery');
  });

  it('falls back to attributes only when metadata lacks producer', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'X', attributes: { producer: 'Legacy P' }, metadata: {} });
    expect(r.producer).toBe('Legacy P');
  });

  it('prefers metadata over attributes when both present', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'X', attributes: { producer: 'attr' }, metadata: { producer: 'meta' } });
    expect(r.producer).toBe('meta');
  });

  it('omits producer (not "") when neither column has a string', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'X', attributes: {}, metadata: {} });
    expect(r.producer).toBeUndefined();
  });

  it('guards null/non-object JSONB without throwing', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'X', attributes: null, metadata: null });
    expect(r.producer).toBeUndefined();
    expect(r.entityId).toBe('e1');
  });

  it('still reads vintageYear from attributes (unchanged)', () => {
    const r = toEntityRow({ entity_id: 'e1', canonical_label: 'X', attributes: { vintage: 2018 }, metadata: { producer: 'P' } });
    expect(r.vintageYear).toBe(2018);
  });
});
