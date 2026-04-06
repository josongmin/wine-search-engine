const KO_CHOSEONG: Record<number, string> = {
  0: 'G', 1: 'G', 2: 'N', 3: 'D', 4: 'D', 5: 'L',
  6: 'M', 7: 'B', 8: 'B', 9: 'S', 10: 'S', 11: '',
  12: 'J', 13: 'J', 14: 'C', 15: 'K', 16: 'T', 17: 'P', 18: 'H',
};

export function soundexKo(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0xAC00 && code <= 0xD7A3) {
        const idx = Math.floor((code - 0xAC00) / 588);
        return KO_CHOSEONG[idx] ?? '';
      }
      return '';
    })
    .join('');
}

export function soundexEn(s: string): string {
  const upper = s.toUpperCase();
  const CODES: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };
  let result = upper[0] ?? '';
  let prev = '';
  for (const ch of upper.slice(1)) {
    const code = CODES[ch] ?? '';
    if (code && code !== prev) result += code;
    prev = code;
    if (result.length === 4) break;
  }
  return result.padEnd(4, '0');
}
