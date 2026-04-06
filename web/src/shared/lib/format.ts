/** Format a 0-1 score as a percentage string. */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Format price band string to visual representation. */
export function priceBand(band: string | undefined): string {
  if (!band) return '—';
  const map: Record<string, string> = {
    budget: '$',
    value: '$$',
    mid: '$$$',
    premium: '$$$$',
    luxury: '$$$$$',
  };
  return map[band.toLowerCase()] ?? band;
}

/** Format milliseconds to human-readable. */
export function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/** Clamp a number between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
