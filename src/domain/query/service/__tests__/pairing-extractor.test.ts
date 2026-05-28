import { describe, expect, it } from 'vitest';
import { extractAllPairingConstraints } from '../pairing-extractor.js';

describe('extractAllPairingConstraints', () => {
  it('extracts Korean course and food pairing tags with 용 suffixes', () => {
    expect(extractAllPairingConstraints('에피타이저용 화이트 추천')).toContain('aperitif');
    expect(extractAllPairingConstraints('메인 소고기용 레드 추천')).toContain('beef');
    expect(extractAllPairingConstraints('디저트용 스위트 추천')).toContain('dessert');
  });

  it('extracts Korean messy food-pairing dishes used by agent routing', () => {
    expect(extractAllPairingConstraints('치맥 대신 치킨이랑 마실 와인')).toContain('chicken');
    expect(extractAllPairingConstraints('삼겹살이랑 와인 조합 추천')).toContain('pork');
    expect(extractAllPairingConstraints('회 먹을 건데 와인 추천해줘')).toContain('white_fish');
    expect(extractAllPairingConstraints('매운 떡볶이랑 먹을 수 있는 와인 있어?')).toContain('spicy_food');
  });

  it('extracts generic cheese as a canonical pairing tag', () => {
    expect(extractAllPairingConstraints('wine for cheese')).toContain('cheese');
    expect(extractAllPairingConstraints('치즈랑 마실 와인')).toContain('cheese');
  });

  it('extracts mixed-script food tokens with Korean postpositions', () => {
    expect(extractAllPairingConstraints('Cheese에 어울리는 와인')).toContain('cheese');
    expect(extractAllPairingConstraints('Pasta랑 마실 와인')).toContain('pasta');
  });

  it('maps charcuterie / cured-meat mixed-script queries onto pork taxonomy', () => {
    expect(extractAllPairingConstraints('Cured Meat에 어울리는 와인')).toContain('pork');
    expect(extractAllPairingConstraints('charcuterie랑 마실 와인')).toContain('pork');
  });
});
