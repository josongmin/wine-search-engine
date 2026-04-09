import type { SparseHit } from '../port/search-index.port.js';

const VINTAGE_YEAR_IN_LABEL = /(?<!\p{L})(?<!\p{N})(19|20)\d{2}(?!\p{L})(?!\p{N})/gu;

/** BM25 multiplier weights for critic / prestige lifts (producer browse). */
const PRODUCER_BROWSE_CRITIC_LIFT = 0.02;
const PRODUCER_BROWSE_PRESTIGE_LIFT = 0.025;
/** Region browse uses slightly higher prestige lift for exploration. */
const REGION_BROWSE_CRITIC_LIFT = 0.02;
const REGION_BROWSE_PRESTIGE_LIFT = 0.03;
/** Max OR-query variants for producer browse lexical expansion. */
const PRODUCER_BROWSE_MAX_LEXICAL_VARIANTS = 4;
/** Max OR-query variants for region browse (path + segments). */
const REGION_BROWSE_MAX_LEXICAL_VARIANTS = 6;
/** Producer cap math: min slots per producer, divisor ties to result limit. */
const REGION_DIVERSITY_PER_PRODUCER_MIN = 2;
const REGION_DIVERSITY_PER_PRODUCER_MAX = 4;
const REGION_DIVERSITY_LIMIT_DIVISOR = 5;
/** Hard cap on sparse over-fetch before diversity selection. */
const BROWSE_SPARSE_FETCH_CEILING = 240;

/** Strips 4-digit vintage tokens from a display label (product-line key). */
export function stripVintageFromLabel(label: string): string {
  return label.replace(VINTAGE_YEAR_IN_LABEL, ' ').replace(/\s+/g, ' ').trim();
}

function normPart(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Maps prestige to [0,1] whether the index stores 0–1 or 0–100. */
function prestige01(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p)) {
    return 0;
  }
  const x = p <= 1 ? p : p / 100;
  return Math.min(1, Math.max(0, x));
}

/** Maps critic score to [0,1] (assumes 0–100 scale when >1). */
function critic01(c: number | undefined): number {
  if (c === undefined || !Number.isFinite(c)) {
    return 0;
  }
  const x = c > 1 ? c / 100 : c;
  return Math.min(1, Math.max(0, x));
}

/**
 * Composite retrieval ranking for producer browse: BM25 × (critic + prestige lift).
 */
export function producerBrowseRankScore(hit: SparseHit): number {
  const c = critic01(hit.summary?.criticScoreNormalized);
  const pr = prestige01(hit.summary?.producerPrestige);
  return hit.score * (1 + PRODUCER_BROWSE_CRITIC_LIFT * c + PRODUCER_BROWSE_PRESTIGE_LIFT * pr);
}

/**
 * Composite retrieval ranking for region browse (prestige-weighted exploration).
 */
export function regionBrowseRankScore(hit: SparseHit): number {
  const c = critic01(hit.summary?.criticScoreNormalized);
  const pr = prestige01(hit.summary?.producerPrestige);
  return hit.score * (1 + REGION_BROWSE_CRITIC_LIFT * c + REGION_BROWSE_PRESTIGE_LIFT * pr);
}

/**
 * OR-query terms for producer browse: surface form + lowercase variant for recall.
 */
export function expandProducerBrowseLexicalQueries(seed: string): readonly string[] {
  const trimmed = seed.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  /** Dedupe exact strings only — surface vs lowercase are distinct OR clauses. */
  const push = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  push(trimmed);
  if (lower !== trimmed) {
    push(lower);
  }
  return out.slice(0, PRODUCER_BROWSE_MAX_LEXICAL_VARIANTS);
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
  return out.slice(0, REGION_BROWSE_MAX_LEXICAL_VARIANTS);
}

/**
 * Stable product-line key: prefer producer + grape + appellation/region when present,
 * else fall back to vintage-stripped label (RFC-017 browse coherence).
 */
function productLineVintageKey(hit: SparseHit): string {
  const s = hit.summary;
  const producer = normPart(s?.producer);
  const grape = normPart(s?.grapePrimary);
  const app = normPart(s?.appellation);
  const reg = normPart(s?.region);
  const geo = app.length > 0 ? app : reg;

  const label = s?.canonicalLabel?.trim() ?? '';
  const lineFromLabel = label.length > 0 ? stripVintageFromLabel(label) : '';

  const line =
    producer.length > 0 && grape.length > 0 && geo.length > 0
      ? `${producer}|${grape}|${geo}`
      : lineFromLabel.length > 0
        ? lineFromLabel.toLowerCase()
        : String(hit.entityId);

  const vy = s?.vintageYear;
  const vintagePart =
    vy !== undefined && Number.isFinite(vy) ? String(Math.floor(vy)) : 'nv';
  return `${line}::${vintagePart}`;
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
  const sorted = [...hits].sort(
    (a, b) => producerBrowseRankScore(b) - producerBrowseRankScore(a),
  );
  const bestByKey = new Map<string, SparseHit>();
  for (const h of sorted) {
    const k = productLineVintageKey(h);
    const cur = bestByKey.get(k);
    if (cur === undefined || producerBrowseRankScore(h) > producerBrowseRankScore(cur)) {
      bestByKey.set(k, h);
    }
  }
  const deduped = [...bestByKey.values()].sort(
    (a, b) => producerBrowseRankScore(b) - producerBrowseRankScore(a),
  );
  return deduped.slice(0, limit);
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

  const maxPerProducer = Math.max(
    REGION_DIVERSITY_PER_PRODUCER_MIN,
    Math.min(
      REGION_DIVERSITY_PER_PRODUCER_MAX,
      Math.ceil(limit / REGION_DIVERSITY_LIMIT_DIVISOR),
    ),
  );

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
const BROWSE_SPARSE_OVERFETCH_MULTIPLIER = 8;
export const BROWSE_SPARSE_OVERFETCH_FACTOR = BROWSE_SPARSE_OVERFETCH_MULTIPLIER;

export function browseSparseFetchLimit(resultLimit: number): number {
  const raw = resultLimit * BROWSE_SPARSE_OVERFETCH_FACTOR;
  return Math.min(BROWSE_SPARSE_FETCH_CEILING, Math.max(resultLimit, raw));
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
