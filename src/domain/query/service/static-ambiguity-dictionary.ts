import type {
  AmbiguityDictionary,
  AmbiguityInfo,
} from '../port/ambiguity-dictionary.port.js';
import { GENERATED_KOREAN_BROAD_AMBIGUITY_SURFACES } from './generated/korean-broad-ambiguity-surfaces.js';

export interface StaticAmbiguousSurfaceEntry {
  readonly term: string;
  readonly types: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

function normalizeSurface(surface: string): string {
  return surface.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * High-precision static ambiguity registry for Korean broad surfaces that
 * should never direct-resolve to a single SKU in no-DB or cold-start paths.
 */
export const CURATED_CORE_AMBIGUOUS_SURFACES: readonly StaticAmbiguousSurfaceEntry[] = [
  { term: '샤또', types: ['producer_prefix', 'entity_family'], severity: 'high' },
  { term: '샤토', types: ['producer_prefix', 'entity_family'], severity: 'high' },
  { term: '마고', types: ['region', 'entity'], severity: 'high' },
  { term: '크리스탈', types: ['common_noun', 'entity'], severity: 'high' },
  { term: '바롤로', types: ['appellation', 'entity'], severity: 'high' },
  { term: '디켐', types: ['appellation', 'entity'], severity: 'high' },
  { term: '이켐', types: ['appellation', 'entity'], severity: 'high' },
  { term: 'drc', types: ['producer_abbreviation', 'entity'], severity: 'high' },
  { term: '오푸스투', types: ['near_miss', 'entity'], severity: 'high' },
  { term: '코르통 샤를마뉴', types: ['grand_cru', 'entity'], severity: 'high' },
  { term: '샹베르탱', types: ['grand_cru', 'entity'], severity: 'high' },
  { term: '펜폴즈', types: ['producer', 'entity'], severity: 'high' },
  { term: '샤르츠호프베르거', types: ['vineyard', 'entity'], severity: 'high' },
  { term: '안티노리', types: ['producer', 'entity'], severity: 'high' },
  { term: '카테나', types: ['producer', 'entity'], severity: 'high' },
  { term: '가야', types: ['producer', 'entity'], severity: 'high' },
  { term: '프룸', types: ['producer', 'entity'], severity: 'high' },
  { term: '토카이', types: ['region', 'appellation', 'entity'], severity: 'high' },
  { term: '샤블리', types: ['region', 'appellation', 'entity'], severity: 'high' },
  { term: '상세르', types: ['region', 'appellation', 'entity'], severity: 'high' },
  { term: '프란치아코르타', types: ['region', 'appellation', 'entity'], severity: 'high' },
  { term: '프로세코', types: ['region', 'appellation', 'entity'], severity: 'high' },
  { term: '보졸레', types: ['region', 'style', 'entity'], severity: 'high' },
  { term: '살롱', types: ['producer', 'entity'], severity: 'high' },
  { term: '쌀롱', types: ['producer', 'entity'], severity: 'high' },
  { term: '바르바레스코', types: ['appellation', 'entity'], severity: 'high' },
  { term: '몽라셰', types: ['grand_cru', 'entity'], severity: 'high' },
  { term: '볼랭저', types: ['producer', 'entity'], severity: 'high' },
  { term: '볼린저', types: ['producer', 'entity'], severity: 'high' },
  { term: '페라리', types: ['producer', 'common_brand', 'entity'], severity: 'high' },
] as const;

export const STATIC_AMBIGUOUS_SURFACES: readonly StaticAmbiguousSurfaceEntry[] = (() => {
  const deduped = new Map<string, StaticAmbiguousSurfaceEntry>();

  for (const entry of CURATED_CORE_AMBIGUOUS_SURFACES) {
    deduped.set(normalizeSurface(entry.term), entry);
  }

  for (const entry of GENERATED_KOREAN_BROAD_AMBIGUITY_SURFACES) {
    const normalized = normalizeSurface(entry.term);
    if (deduped.has(normalized)) {
      continue;
    }

    deduped.set(normalized, {
      term: entry.term,
      types: entry.types,
      severity: entry.severity,
    });
  }

  return [...deduped.values()];
})();

export class StaticAmbiguityDictionary implements AmbiguityDictionary {
  private readonly entries = new Map<
    string,
    { types: string[]; severity: 'low' | 'medium' | 'high' }
  >(
    STATIC_AMBIGUOUS_SURFACES.map((entry) => [
      normalizeSurface(entry.term),
      { types: [...entry.types], severity: entry.severity },
    ]),
  );

  isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    return Promise.resolve(this.entries.has(normalizeSurface(surfaceForm)));
  }

  getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    return Promise.resolve(this.entries.get(normalizeSurface(surfaceForm)) ?? null);
  }

  getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, AmbiguityInfo>> {
    const out = new Map<string, AmbiguityInfo>();
    for (const form of surfaceForms) {
      const hit = this.entries.get(normalizeSurface(form));
      if (hit !== undefined) {
        out.set(form, hit);
      }
    }
    return Promise.resolve(out);
  }
}

export class FallbackAmbiguityDictionary implements AmbiguityDictionary {
  constructor(
    private readonly primary: AmbiguityDictionary,
    private readonly fallback: AmbiguityDictionary,
  ) {}

  async isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    if (await this.primary.isKnownAmbiguous(surfaceForm)) {
      return true;
    }
    return this.fallback.isKnownAmbiguous(surfaceForm);
  }

  async getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    const primaryInfo = await this.primary.getAmbiguityInfo(surfaceForm);
    if (primaryInfo !== null) {
      return primaryInfo;
    }
    return this.fallback.getAmbiguityInfo(surfaceForm);
  }

  async getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, AmbiguityInfo>> {
    if (surfaceForms.length === 0) {
      return new Map();
    }
    // Issue both lookups in parallel — the primary substrate (PG) and fallback
    // (static) are independent, so we save a round-trip vs sequential await.
    const [primaryMap, fallbackMap] = await Promise.all([
      this.primary.getAmbiguityInfoBatch(surfaceForms),
      this.fallback.getAmbiguityInfoBatch(surfaceForms),
    ]);
    // Primary wins on collisions — same precedence as the singular path.
    const out = new Map<string, AmbiguityInfo>(fallbackMap);
    for (const [form, info] of primaryMap) {
      out.set(form, info);
    }
    return out;
  }
}
