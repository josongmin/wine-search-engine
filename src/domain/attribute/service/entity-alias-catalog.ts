import type { AmbiguousEntityHintSpec } from '../model/ambiguous-entity-hint.js';

export type ResolverCompatibleAttribute =
  | 'wine_type'
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary';

export type EntityAliasProvenance =
  | 'country_derived'
  | 'region_parents'
  | 'grape_aliases';

export type EntityResolutionMode = 'direct' | 'context_required';

export interface CuratedEntityAliasCatalogEntry {
  readonly surface: string;
  readonly mappedAttribute: ResolverCompatibleAttribute;
  readonly canonicalValue: string;
  readonly mappingConfidence: number;
  readonly provenance: EntityAliasProvenance;
  readonly resolutionMode: EntityResolutionMode;
  readonly exportToDefaultMappings: boolean;
  readonly ambiguityHint?: AmbiguousEntityHintSpec | undefined;
}

const CONF_EXACT_COUNTRY = 0.95;
const CONF_EXACT_REGION = 0.95;
const CONF_EXACT_APPELLATION = 0.95;
const CONF_EXACT_GRAPE = 0.95;
const CONF_SHORT_GRAPE = 0.9;
const CONF_AMBIGUOUS_GRAPE = 0.85;

export const CURATED_ENTITY_ALIAS_CATALOG: readonly CuratedEntityAliasCatalogEntry[] = [
  { surface: '프랑스', mappedAttribute: 'country', canonicalValue: 'France', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '이탈리아', mappedAttribute: 'country', canonicalValue: 'Italy', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '미국', mappedAttribute: 'country', canonicalValue: 'United States', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '칠레', mappedAttribute: 'country', canonicalValue: 'Chile', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '호주', mappedAttribute: 'country', canonicalValue: 'Australia', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '스페인', mappedAttribute: 'country', canonicalValue: 'Spain', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '독일', mappedAttribute: 'country', canonicalValue: 'Germany', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '아르헨티나', mappedAttribute: 'country', canonicalValue: 'Argentina', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '포르투갈', mappedAttribute: 'country', canonicalValue: 'Portugal', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '뉴질랜드', mappedAttribute: 'country', canonicalValue: 'New Zealand', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '남아공', mappedAttribute: 'country', canonicalValue: 'South Africa', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '남아프리카', mappedAttribute: 'country', canonicalValue: 'South Africa', mappingConfidence: CONF_EXACT_COUNTRY, provenance: 'country_derived', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '보르도', mappedAttribute: 'region', canonicalValue: 'Bordeaux', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '부르고뉴', mappedAttribute: 'region', canonicalValue: 'Burgundy', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '나파', mappedAttribute: 'region', canonicalValue: 'Napa Valley', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '나파 밸리', mappedAttribute: 'region', canonicalValue: 'Napa Valley', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '토스카나', mappedAttribute: 'region', canonicalValue: 'Tuscany', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '샴페인', mappedAttribute: 'region', canonicalValue: 'Champagne', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '모젤', mappedAttribute: 'region', canonicalValue: 'Mosel', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '리오하', mappedAttribute: 'region', canonicalValue: 'Rioja', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '멘도사', mappedAttribute: 'region', canonicalValue: 'Mendoza', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '말버러', mappedAttribute: 'region', canonicalValue: 'Marlborough', mappingConfidence: CONF_EXACT_REGION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '바롤로', mappedAttribute: 'appellation', canonicalValue: 'Barolo', mappingConfidence: CONF_EXACT_APPELLATION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '브루넬로', mappedAttribute: 'appellation', canonicalValue: 'Brunello di Montalcino', mappingConfidence: CONF_EXACT_APPELLATION, provenance: 'region_parents', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '카베르네', mappedAttribute: 'grape_primary', canonicalValue: 'Cabernet Sauvignon', mappingConfidence: CONF_SHORT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '메를로', mappedAttribute: 'grape_primary', canonicalValue: 'Merlot', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  {
    surface: '피노',
    mappedAttribute: 'grape_primary',
    canonicalValue: 'Pinot Noir',
    mappingConfidence: CONF_AMBIGUOUS_GRAPE,
    provenance: 'grape_aliases',
    resolutionMode: 'context_required',
    exportToDefaultMappings: false,
    ambiguityHint: {
      entityType: 'grape_primary',
      retrievalConstraint: {
        attribute: 'grape_family',
        operator: '=',
        value: 'Pinot',
      },
      lexicalExpansions: ['pinot'],
      semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
      clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
      explorationBranches: [
        {
          label: 'Pinot Noir',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Noir',
          },
          matchValues: ['Pinot Noir'],
          lexicalExpansions: ['pinot noir'],
          semanticExpansions: ['pinot noir'],
        },
        {
          label: 'Pinot Gris',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Gris',
          },
          matchValues: ['Pinot Gris', 'Pinot Grigio'],
          lexicalExpansions: ['pinot gris', 'pinot grigio'],
          semanticExpansions: ['pinot gris', 'pinot grigio'],
        },
        {
          label: 'Pinot Blanc',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Blanc',
          },
          matchValues: ['Pinot Blanc'],
          lexicalExpansions: ['pinot blanc'],
          semanticExpansions: ['pinot blanc'],
        },
      ],
    },
  },
  { surface: '피노 누아르', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Noir', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노누아', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Noir', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노누아르', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Noir', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노 그리지오', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Gris', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노그리지오', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Gris', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노 그리', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Gris', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '피노그리', mappedAttribute: 'grape_primary', canonicalValue: 'Pinot Gris', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '샤르도네', mappedAttribute: 'grape_primary', canonicalValue: 'Chardonnay', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
  { surface: '소비뇽 블랑', mappedAttribute: 'grape_primary', canonicalValue: 'Sauvignon Blanc', mappingConfidence: CONF_EXACT_GRAPE, provenance: 'grape_aliases', resolutionMode: 'direct', exportToDefaultMappings: true },
];
