import { describe, expect, it } from 'vitest';
import { extractAllPairingConstraints } from '../pairing-extractor.js';

describe('extractAllPairingConstraints', () => {
  it('extracts Korean course and food pairing tags with 용 suffixes', () => {
    expect(extractAllPairingConstraints('에피타이저용 화이트 추천')).toContain('aperitif');
    expect(extractAllPairingConstraints('메인 소고기용 레드 추천')).toContain('beef');
    expect(extractAllPairingConstraints('디저트용 스위트 추천')).toContain('dessert');
  });
});
