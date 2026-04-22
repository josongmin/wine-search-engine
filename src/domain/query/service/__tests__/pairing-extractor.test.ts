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
});
