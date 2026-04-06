import { describe, it, expect } from 'vitest';
import { searchUrl, wineDetailUrl } from '../navigation';

describe('searchUrl', () => {
  it('encodes query parameter', () => {
    expect(searchUrl('red wine')).toBe('/search?q=red%20wine');
  });

  it('trims whitespace', () => {
    expect(searchUrl('  cabernet  ')).toBe('/search?q=cabernet');
  });

  it('handles Korean text', () => {
    const url = searchUrl('보르도 와인');
    expect(url).toContain('/search?q=');
    expect(decodeURIComponent(url)).toContain('보르도 와인');
  });

  it('handles special characters', () => {
    expect(searchUrl('Opus One & Caymus')).toContain('Opus%20One%20%26%20Caymus');
  });
});

describe('wineDetailUrl', () => {
  it('encodes entity ID', () => {
    expect(wineDetailUrl('wine:abc123')).toBe('/wine/wine%3Aabc123');
  });
});
