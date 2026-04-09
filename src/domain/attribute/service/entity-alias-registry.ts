import type { EntityType } from './entity-resolver.js';

/**
 * Confidence tiers for curated aliases — higher = more unambiguous.
 * Exact-match curated entries get a boost over auto-derived entries
 * (entity-resolver auto-derives at 0.88-0.95 depending on source table).
 */
const CONF_EXACT_COUNTRY = 0.95;
const CONF_EXACT_REGION = 0.95;
const CONF_EXACT_APPELLATION = 0.95;
const CONF_EXACT_GRAPE = 0.95;
/** Shortened grape names (카베르네→Cabernet Sauvignon) carry slight ambiguity. */
const CONF_SHORT_GRAPE = 0.9;
/** Very short grape names (피노→Pinot Noir) are more ambiguous (could be Pinot Grigio). */
const CONF_AMBIGUOUS_GRAPE = 0.85;

interface CuratedAlias {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly entityType: EntityType;
  readonly confidence: number;
  readonly provenance: 'country_derived' | 'region_parents' | 'grape_aliases';
}

export const CURATED_ENTITY_ALIASES: readonly CuratedAlias[] = [
  // ── Countries (Korean aliases — canonical must match REGION_PARENTS chain) ──
  { surface: '프랑스', canonicalValue: 'France', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '이탈리아', canonicalValue: 'Italy', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '미국', canonicalValue: 'United States', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '칠레', canonicalValue: 'Chile', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '호주', canonicalValue: 'Australia', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '스페인', canonicalValue: 'Spain', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '독일', canonicalValue: 'Germany', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '아르헨티나', canonicalValue: 'Argentina', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '포르투갈', canonicalValue: 'Portugal', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '뉴질랜드', canonicalValue: 'New Zealand', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '남아공', canonicalValue: 'South Africa', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  { surface: '남아프리카', canonicalValue: 'South Africa', entityType: 'country', confidence: CONF_EXACT_COUNTRY, provenance: 'country_derived' },
  // ── Regions ──
  { surface: '보르도', canonicalValue: 'Bordeaux', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '부르고뉴', canonicalValue: 'Burgundy', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '나파', canonicalValue: 'Napa Valley', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '나파 밸리', canonicalValue: 'Napa Valley', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '토스카나', canonicalValue: 'Tuscany', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '샴페인', canonicalValue: 'Champagne', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '모젤', canonicalValue: 'Mosel', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '리오하', canonicalValue: 'Rioja', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '멘도사', canonicalValue: 'Mendoza', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  { surface: '말버러', canonicalValue: 'Marlborough', entityType: 'region', confidence: CONF_EXACT_REGION, provenance: 'region_parents' },
  // ── Appellations ──
  { surface: '바롤로', canonicalValue: 'Barolo', entityType: 'appellation', confidence: CONF_EXACT_APPELLATION, provenance: 'region_parents' },
  { surface: '브루넬로', canonicalValue: 'Brunello di Montalcino', entityType: 'appellation', confidence: CONF_EXACT_APPELLATION, provenance: 'region_parents' },
  // ── Grapes ──
  { surface: '카베르네', canonicalValue: 'Cabernet Sauvignon', entityType: 'grape_primary', confidence: CONF_SHORT_GRAPE, provenance: 'grape_aliases' },
  { surface: '메를로', canonicalValue: 'Merlot', entityType: 'grape_primary', confidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases' },
  { surface: '피노', canonicalValue: 'Pinot Noir', entityType: 'grape_primary', confidence: CONF_AMBIGUOUS_GRAPE, provenance: 'grape_aliases' },
  { surface: '샤르도네', canonicalValue: 'Chardonnay', entityType: 'grape_primary', confidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases' },
];
