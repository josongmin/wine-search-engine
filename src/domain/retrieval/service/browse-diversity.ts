import type { SparseHit } from '../port/search-index.port.js';

const VINTAGE_YEAR_IN_LABEL = /\b(19|20)\d{2}\b/g;

/** Strips 4-digit vintage tokens from a display label (product-line key). */
export function stripVintageFromLabel(label: string): string {
  return label.replace(VINTAGE_YEAR_IN_LABEL, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Builds OR-query terms for region browse: full path plus slash segments (deduped).
 */
export function expandRegionBrowseLexicalQueries(seed: string): readonly string[] {
  const trimmed = seed.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const segments = trimmed
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  };
  push(trimmed);
  for (const seg of segments) {
    if (seg.toLowerCase() !== trimmed.toLowerCase()) {
      push(seg);
    }
  }
  return out.slice(0, 6);
}

function productLineVintageKey(hit: SparseHit): string {
  const label = hit.summary?.canonicalLabel?.trim() ?? '';
  const line = label.length > 0 ? stripVintageFromLabel(label) : String(hit.entityId);
  const vy = hit.summary?.vintageYear;
  const vintagePart =
    vy !== undefined && Number.isFinite(vy) ? String(Math.floor(vy)) : 'nv';
  return `${line.toLowerCase()}::${vintagePart}`;
}

/**
 * One hit per (product line, vintage) — keeps vintage spread for a producer catalog browse.
 */
export function diversifyProducerBrowseHits(
  hits: readonly SparseHit[],
  limit: number,
): readonly SparseHit[] {
  if (hits.length === 0 || limit <= 0) {
    return [];
  }
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const bestByKey = new Map<string, SparseHit>();
  for (const h of sorted) {
    const k = productLineVintageKey(h);
    const cur = bestByKey.get(k);
    if (cur === undefined || h.score > cur.score) {
      bestByKey.set(k, h);
    }
  }
  const deduped = [...bestByKey.values()].sort((a, b) => b.score - a.score);
  return deduped.slice(0, limit);
}

function regionBrowseRankScore(hit: SparseHit): number {
  const c = hit.summary?.criticScoreNormalized;
  const boost =
    c !== undefined && Number.isFinite(c) ? Math.min(100, Math.max(0, c)) / 100 : 0;
  return hit.score * (1 + 0.02 * boost);
}

/**
 * Caps wines per producer, interleaving so many producers appear before the tail.
 */
export function diversifyRegionBrowseHits(
  hits: readonly SparseHit[],
  limit: number,
): readonly SparseHit[] {
  if (hits.length === 0 || limit <= 0) {
    return [];
  }

  const maxPerProducer = Math.max(2, Math.min(4, Math.ceil(limit / 5)));

  const sorted = [...hits].sort((a, b) => regionBrowseRankScore(b) - regionBrowseRankScore(a));

  const counts = new Map<string, number>();
  const producerKey = (hit: SparseHit): string => {
    const p = hit.summary?.producer?.trim().toLowerCase() ?? '';
    return p.length > 0 ? p : `__id:${String(hit.entityId)}`;
  };

  const selected: SparseHit[] = [];
  const used = new Set<string>();

  const tryTake = (hit: SparseHit): boolean => {
    const id = String(hit.entityId);
    if (used.has(id)) return false;
    const pk = producerKey(hit);
    const n = counts.get(pk) ?? 0;
    if (n >= maxPerProducer) return false;
    counts.set(pk, n + 1);
    used.add(id);
    selected.push(hit);
    return true;
  };

  for (const h of sorted) {
    if (selected.length >= limit) break;
    tryTake(h);
  }

  if (selected.length < limit) {
    for (const h of sorted) {
      if (selected.length >= limit) break;
      const id = String(h.entityId);
      if (!used.has(id)) {
        used.add(id);
        selected.push(h);
      }
    }
  }

  return selected.slice(0, limit);
}

/** Over-fetch multiplier for sparse browse before diversity selection. */
export const BROWSE_SPARSE_OVERFETCH_FACTOR = 8;

export function browseSparseFetchLimit(resultLimit: number): number {
  const raw = resultLimit * BROWSE_SPARSE_OVERFETCH_FACTOR;
  return Math.min(240, Math.max(resultLimit, raw));
}

/**
 * OR-queries can return the same entity multiple times; keep the strongest hit.
 */
export function dedupeSparseHitsByEntity(
  hits: readonly SparseHit[],
): readonly SparseHit[] {
  const map = new Map<string, SparseHit>();
  for (const h of hits) {
    const id = String(h.entityId);
    const cur = map.get(id);
    if (cur === undefined || h.score > cur.score) {
      map.set(id, h);
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}
