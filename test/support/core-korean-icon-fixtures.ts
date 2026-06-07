import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import {
  createEntityId,
  createSourceRecordId,
  type EntityId,
  type SourceRecordId,
} from '../../src/domain/shared/types/index.js';
import { buildNormalizedQueryViews } from '../../src/domain/query/service/query-normalizer.js';
import type { EnrichedSilverRecord, ProposedAlias } from '../../scripts/etl/types.js';
import type { TestFixtureAlias } from '../integration/helpers/test-container.js';

const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');
const FIXTURE_SCRAPED_AT = '2026-04-22T00:00:00.000Z';
const FIXTURE_ALIAS_SOURCE = 'fixture:core_korean_icon_alias_v1';

const CatalogEntrySchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().min(1),
  country: z.string().min(1),
  region: z.string().min(1),
  appellation: z.string().min(1).optional(),
  grapes: z.array(z.string().min(1)).min(1),
  wineType: z.enum(['red', 'white', 'sparkling', 'dessert', 'rosé', 'fortified']),
  vintageYear: z.number().int().min(1900).max(2030),
  priceUsd: z.number().finite().positive(),
  body: z.number().int().min(1).max(5).nullable(),
  tannin: z.number().int().min(1).max(5).nullable(),
  acidity: z.number().int().min(1).max(5).nullable(),
  criticScore: z.number().int().min(0).max(100),
  style: z.string().min(1),
  koreanAliases: z.array(z.string().min(1)).max(20),
}).strict();

type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export interface CoreKoreanEntityCase {
  readonly query: string;
  readonly expectedEntityId: string;
  readonly identitySafe?: boolean;
}

interface CoreKoreanAmbiguityCase {
  readonly query: string;
  readonly expectedCandidateEntityId?: string;
  readonly forbiddenResolvedEntityId?: string;
  readonly allowResolved?: boolean;
  readonly ambiguityTypes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

export type CoreKoreanReleaseGateSource =
  | 'korean_wine_aliases'
  | 'entity_alias_catalog'
  | 'gold_wine_catalog'
  | 'noisy_entity_benchmark'
  | 'user_requirement'
  | 'web_usage';

export interface CoreKoreanReleaseGateCase extends CoreKoreanEntityCase {
  readonly sources: readonly CoreKoreanReleaseGateSource[];
  readonly identitySafe?: boolean;
}

export const CORE_KOREAN_ICON_QUERY_CASES: readonly CoreKoreanEntityCase[] = [
  { query: '샤토 라투르', expectedEntityId: 'w-chateau-latour-2016' },
  { query: '샤또 라피트', expectedEntityId: 'w-chateau-lafite-rothschild-2016' },
  { query: '샤또 무통', expectedEntityId: 'w-chateau-mouton-rothschild-2018' },
  { query: '샤또 오브리옹', expectedEntityId: 'w-chateau-haut-brion-2015' },
  { query: '페트뤼스', expectedEntityId: 'w-petrus-2016' },
  { query: '슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015' },
  { query: '로마네 콩티', expectedEntityId: 'w-drc-romanee-conti-2017' },
  { query: '아르망 루소', expectedEntityId: 'w-armand-rousseau-chambertin-2018' },
  { query: '코쉬 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019' },
  { query: '크뤼그', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv' },
  { query: '돔 페리뇽', expectedEntityId: 'w-dom-perignon-2013' },
  { query: '루이 로드레 크리스탈', expectedEntityId: 'w-louis-roederer-cristal-2014' },
  { query: '사시카이아', expectedEntityId: 'w-sassicaia-2018' },
  { query: '티냐넬로', expectedEntityId: 'w-tignanello-2019' },
  { query: '오르넬라이아', expectedEntityId: 'w-ornellaia-2018' },
  { query: '자코모 콘테르노', expectedEntityId: 'w-giacomo-conterno-monfortino-2015', identitySafe: false },
  { query: '베가 시실리아', expectedEntityId: 'w-vega-sicilia-unico-2012', identitySafe: false },
  { query: '핑구스', expectedEntityId: 'w-pingus-2019' },
  { query: '알마비바', expectedEntityId: 'w-almaviva-2019' },
  { query: '돈 멜초', expectedEntityId: 'w-don-melchor-2019' },
  { query: '스크리밍 이글', expectedEntityId: 'w-screaming-eagle-2018' },
  { query: '할란 이스테이트', expectedEntityId: 'w-harlan-estate-2016' },
  { query: '펜폴즈 그레인지', expectedEntityId: 'w-penfolds-grange-2017' },
  { query: '에곤 뮐러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020' },
  { query: '샤또 디켐', expectedEntityId: 'w-chateau-dyquem-2015' },
] as const;

export const CORE_KOREAN_ICON_RELEASE_GATE_CASES: readonly CoreKoreanReleaseGateCase[] = [
  { query: '오푸스원', expectedEntityId: 'w-opus-one-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'noisy_entity_benchmark'] },
  { query: '오푸스 원', expectedEntityId: 'w-opus-one-2018', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '오퍼스원', expectedEntityId: 'w-opus-one-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'noisy_entity_benchmark'] },
  { query: '오퍼스 원', expectedEntityId: 'w-opus-one-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'noisy_entity_benchmark', 'web_usage'] },
  { query: '오 푸 스 원', expectedEntityId: 'w-opus-one-2018', sources: ['korean_wine_aliases', 'noisy_entity_benchmark'] },
  { query: '오 푸 스 원 18', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: '오푸스ㅇ', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: '오퍼스ㅇ', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: '오푸', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: '오푸스원 2018 Napa Valley', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: 'Opus One 나파', expectedEntityId: 'w-opus-one-2018', sources: ['noisy_entity_benchmark'] },
  { query: '오퍼스', expectedEntityId: 'w-opus-one-2018', sources: ['user_requirement'] },
  { query: '오푸스', expectedEntityId: 'w-opus-one-2018', sources: ['user_requirement'] },
  { query: 'opu', expectedEntityId: 'w-opus-one-2018', sources: ['user_requirement'] },

  { query: '샤또 마고', expectedEntityId: 'w-chateau-margaux-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'noisy_entity_benchmark'] },
  { query: '샤토 마고', expectedEntityId: 'w-chateau-margaux-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'noisy_entity_benchmark'] },
  { query: '샤또마고', expectedEntityId: 'w-chateau-margaux-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'noisy_entity_benchmark'] },
  { query: '샤토마고', expectedEntityId: 'w-chateau-margaux-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '샤또 마고 2015', expectedEntityId: 'w-chateau-margaux-2015', sources: ['noisy_entity_benchmark'] },
  { query: '샤또 Margaux 2015', expectedEntityId: 'w-chateau-margaux-2015', sources: ['noisy_entity_benchmark'] },
  { query: '마고 샤또', expectedEntityId: 'w-chateau-margaux-2015', sources: ['entity_alias_catalog', 'noisy_entity_benchmark'], identitySafe: false },

  { query: '샤또 라투르', expectedEntityId: 'w-chateau-latour-2016', sources: ['gold_wine_catalog'] },
  { query: '샤토 라투르', expectedEntityId: 'w-chateau-latour-2016', sources: ['gold_wine_catalog'] },
  { query: '샤또 라뚜르', expectedEntityId: 'w-chateau-latour-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '라뚜르', expectedEntityId: 'w-chateau-latour-2016', sources: ['gold_wine_catalog'], identitySafe: false },
  { query: '라투르', expectedEntityId: 'w-chateau-latour-2016', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },

  { query: '샤또 라피트', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['gold_wine_catalog'] },
  { query: '샤토 라피트', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases'] },
  { query: '샤토 라피트 로칠드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토 라피트 로쉴드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 라피트 로칠드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 라피트 로쉴드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 라피뜨 로쉴드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '라피트', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['entity_alias_catalog', 'gold_wine_catalog'], identitySafe: false },
  { query: '라피트 로칠드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '라피트 로쉴드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '라피뜨 로칠드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['gold_wine_catalog'] },
  { query: '라피뜨 로쉴드', expectedEntityId: 'w-chateau-lafite-rothschild-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },

  { query: '샤또 무통', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['gold_wine_catalog'] },
  { query: '샤토 무통', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases'] },
  { query: '샤토 무통 로칠드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토 무통 로쉴드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토 무똥 로칠드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 무통 로칠드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 무똥 로쉴드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '무통 로칠드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['gold_wine_catalog'] },
  { query: '무통 로쉴드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '무똥 로칠드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '무똥 로쉴드', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '무통', expectedEntityId: 'w-chateau-mouton-rothschild-2018', sources: ['entity_alias_catalog', 'gold_wine_catalog'], identitySafe: false },

  { query: '샤또 오브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['gold_wine_catalog'] },
  { query: '샤토 오브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases'] },
  { query: '오브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '오 브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['gold_wine_catalog'] },
  { query: '오-브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토 오 브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 오 브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토 오-브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 오-브리옹', expectedEntityId: 'w-chateau-haut-brion-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },

  { query: '페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '페트러스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '페트루스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '샤또 페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤토 페트루스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤또페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤토페트루스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },

  { query: '슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '슈발블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '샤토 슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토슈발블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '샤또슈발블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },

  { query: '로마네 콩티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'web_usage'] },
  { query: '로마네콩티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '로마네 꽁티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'noisy_entity_benchmark'] },
  { query: '로마네꽁띠', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '로마네 꽁띠', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases'] },
  { query: '로마네 콘티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 드 라 로마네 콩티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 드 라 로마네 꽁띠', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 드 라 로마네 콘티', expectedEntityId: 'w-drc-romanee-conti-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },

  { query: '아르망 루소', expectedEntityId: 'w-armand-rousseau-chambertin-2018', sources: ['gold_wine_catalog'] },
  { query: '아르망루소', expectedEntityId: 'w-armand-rousseau-chambertin-2018', sources: ['gold_wine_catalog'] },
  { query: '코쉬 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '코슈 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '코슈 듀리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'web_usage'] },
  { query: '코슈-뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases'] },
  { query: '코슈-듀리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases'] },
  { query: '도멘 코슈-뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 코슈 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 코쉬-뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '도멘 코쉬 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },

  { query: '크뤼그', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '크룩', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '크루그', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '크루그 그랑 퀴베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '크뤼그 그랑 퀴베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '크룩 그랑 퀴베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '크루그 그랑 뀌베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '크뤼그 그랑 뀌베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '크룩 그랑 뀌베', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '돔 페리뇽', expectedEntityId: 'w-dom-perignon-2013', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '돔페리뇽', expectedEntityId: 'w-dom-perignon-2013', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '돔 페리뇬', expectedEntityId: 'w-dom-perignon-2013', sources: ['gold_wine_catalog'] },
  { query: '돔페리농', expectedEntityId: 'w-dom-perignon-2013', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '돔 페리뇽 모엣', expectedEntityId: 'w-dom-perignon-2013', sources: ['entity_alias_catalog'] },
  { query: '루이 로드레 크리스탈', expectedEntityId: 'w-louis-roederer-cristal-2014', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '루이로드레 크리스탈', expectedEntityId: 'w-louis-roederer-cristal-2014', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },

  { query: '사시카이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog', 'noisy_entity_benchmark'] },
  { query: '사시까이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '사시까이야', expectedEntityId: 'w-sassicaia-2018', sources: ['entity_alias_catalog'] },
  { query: '싸시까이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '쌔시까이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases'] },
  { query: '사시카야', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '사씨카이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '사씨카이야', expectedEntityId: 'w-sassicaia-2018', sources: ['entity_alias_catalog'] },
  { query: '사씨까이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '티냐넬로', expectedEntityId: 'w-tignanello-2019', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '띠냐넬로', expectedEntityId: 'w-tignanello-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '티그나넬로', expectedEntityId: 'w-tignanello-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '오르넬라이아', expectedEntityId: 'w-ornellaia-2018', sources: ['entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '오넬라이아', expectedEntityId: 'w-ornellaia-2018', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '오르넬라이야', expectedEntityId: 'w-ornellaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '오르넬라야', expectedEntityId: 'w-ornellaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '자코모 콘테르노', expectedEntityId: 'w-giacomo-conterno-monfortino-2015', sources: ['gold_wine_catalog'], identitySafe: false },
  { query: '자코모콘테르노', expectedEntityId: 'w-giacomo-conterno-monfortino-2015', sources: ['gold_wine_catalog'] },
  { query: '몬포르티노', expectedEntityId: 'w-giacomo-conterno-monfortino-2015', sources: ['gold_wine_catalog'] },

  { query: '베가 시실리아', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'gold_wine_catalog'], identitySafe: false },
  { query: '베가시실리아', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '베가 시칠리아', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '베가 시실리아 우니코', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '베가시실리아 우니코', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '베가 시실리아 우니꼬', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '베가시실리아 우니꼬', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '베가 시칠리아 우니코', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '우니코', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['gold_wine_catalog'] },
  { query: '우니꼬', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '핑구스', expectedEntityId: 'w-pingus-2019', sources: ['gold_wine_catalog'] },
  { query: '핑거스', expectedEntityId: 'w-pingus-2019', sources: ['gold_wine_catalog'] },
  { query: '도미니오 데 핑구스', expectedEntityId: 'w-pingus-2019', sources: ['korean_wine_aliases', 'web_usage'] },
  { query: '도미니오 드 핑구스', expectedEntityId: 'w-pingus-2019', sources: ['korean_wine_aliases', 'web_usage'] },
  { query: '알마비바', expectedEntityId: 'w-almaviva-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'] },
  { query: '알마 비바', expectedEntityId: 'w-almaviva-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '돈 멜초', expectedEntityId: 'w-don-melchor-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '돈멜초', expectedEntityId: 'w-don-melchor-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '돈 멜쵸르', expectedEntityId: 'w-don-melchor-2019', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '돈 멜초르', expectedEntityId: 'w-don-melchor-2019', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '스크리밍 이글', expectedEntityId: 'w-screaming-eagle-2018', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '스크리밍이글', expectedEntityId: 'w-screaming-eagle-2018', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '할란 이스테이트', expectedEntityId: 'w-harlan-estate-2016', sources: ['gold_wine_catalog'] },
  { query: '할란 에스테이트', expectedEntityId: 'w-harlan-estate-2016', sources: ['korean_wine_aliases', 'web_usage'] },
  { query: '할란', expectedEntityId: 'w-harlan-estate-2016', sources: ['gold_wine_catalog'] },
  { query: '펜폴즈 그레인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['gold_wine_catalog'] },
  { query: '펜폴즈 그랜지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '그레인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['gold_wine_catalog'] },
  { query: '그랜지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'], identitySafe: false },
  { query: '그래인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases'] },
  { query: '펜폴즈 그래인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases'] },
  { query: '에곤 뮐러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '에곤뮐러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'gold_wine_catalog'] },
  { query: '에곤 뮬러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤뮬러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤 뮐러 샤르츠호프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤뮐러 샤르츠호프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤 뮬러 샤르츠호프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤뮬러 샤르츠호프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤 뮐러 샤르초프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '에곤 뮬러 샤르초프베르거', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 디켐', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['gold_wine_catalog', 'web_usage'] },
  { query: '샤토 디켐', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases'] },
  { query: '샤또디켐', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['gold_wine_catalog'] },
  { query: '샤토디켐', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '샤토 디껨', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또 디껨', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤토디껨', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
  { query: '샤또디껨', expectedEntityId: 'w-chateau-dyquem-2015', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'] },
] as const;

export const CORE_KOREAN_ICON_AMBIGUITY_CASES: readonly CoreKoreanAmbiguityCase[] = [
  {
    query: '샤또',
    ambiguityTypes: ['producer_prefix', 'entity_family'],
    severity: 'high',
  },
  {
    query: '샤토',
    ambiguityTypes: ['producer_prefix', 'entity_family'],
    severity: 'high',
  },
  {
    query: '마고',
    expectedCandidateEntityId: 'w-chateau-margaux-2015',
    forbiddenResolvedEntityId: 'w-chateau-margaux-2015',
    allowResolved: true,
    ambiguityTypes: ['region', 'entity'],
    severity: 'high',
  },
  {
    query: '크리스탈',
    expectedCandidateEntityId: 'w-louis-roederer-cristal-2014',
    forbiddenResolvedEntityId: 'w-louis-roederer-cristal-2014',
    ambiguityTypes: ['common_noun', 'entity'],
    severity: 'high',
  },
  {
    query: '바롤로',
    expectedCandidateEntityId: 'w-giacomo-conterno-monfortino-2015',
    forbiddenResolvedEntityId: 'w-giacomo-conterno-monfortino-2015',
    allowResolved: true,
    ambiguityTypes: ['appellation', 'entity'],
    severity: 'high',
  },
  {
    query: '디켐',
    expectedCandidateEntityId: 'w-chateau-dyquem-2015',
    forbiddenResolvedEntityId: 'w-chateau-dyquem-2015',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: '페트루스',
    expectedCandidateEntityId: 'w-petrus-2016',
    forbiddenResolvedEntityId: 'w-petrus-2016',
    ambiguityTypes: ['korean_typo', 'entity'],
    severity: 'high',
  },
  {
    query: '이켐',
    expectedCandidateEntityId: 'w-chateau-dyquem-2015',
    forbiddenResolvedEntityId: 'w-chateau-dyquem-2015',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: 'DRC',
    expectedCandidateEntityId: 'w-drc-romanee-conti-2017',
    forbiddenResolvedEntityId: 'w-drc-romanee-conti-2017',
    ambiguityTypes: ['acronym', 'entity'],
    severity: 'high',
  },
  {
    query: '라뚜르',
    expectedCandidateEntityId: 'w-chateau-latour-2016',
    forbiddenResolvedEntityId: 'w-chateau-latour-2016',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: '라피트',
    expectedCandidateEntityId: 'w-chateau-lafite-rothschild-2016',
    forbiddenResolvedEntityId: 'w-chateau-lafite-rothschild-2016',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: '무통',
    expectedCandidateEntityId: 'w-chateau-mouton-rothschild-2018',
    forbiddenResolvedEntityId: 'w-chateau-mouton-rothschild-2018',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: '그랜지',
    expectedCandidateEntityId: 'w-penfolds-grange-2017',
    forbiddenResolvedEntityId: 'w-penfolds-grange-2017',
    ambiguityTypes: ['short_form', 'entity'],
    severity: 'high',
  },
  {
    query: '베가 시실리아',
    expectedCandidateEntityId: 'w-vega-sicilia-unico-2012',
    forbiddenResolvedEntityId: 'w-vega-sicilia-unico-2012',
    ambiguityTypes: ['broad_icon', 'entity'],
    severity: 'high',
  },
  {
    query: '자코모 콘테르노',
    expectedCandidateEntityId: 'w-giacomo-conterno-monfortino-2015',
    forbiddenResolvedEntityId: 'w-giacomo-conterno-monfortino-2015',
    ambiguityTypes: ['family', 'entity'],
    severity: 'high',
  },
  {
    query: '오푸스투',
    expectedCandidateEntityId: 'w-opus-one-2018',
    forbiddenResolvedEntityId: 'w-opus-one-2018',
    ambiguityTypes: ['near_miss', 'entity'],
    severity: 'high',
  },
  {
    query: '사시카야',
    expectedCandidateEntityId: 'w-sassicaia-2018',
    forbiddenResolvedEntityId: 'w-sassicaia-2018',
    ambiguityTypes: ['korean_typo', 'entity'],
    severity: 'high',
  },
  {
    query: '사씨카이야',
    expectedCandidateEntityId: 'w-sassicaia-2018',
    forbiddenResolvedEntityId: 'w-sassicaia-2018',
    ambiguityTypes: ['korean_typo', 'entity'],
    severity: 'high',
  },
  {
    query: '코르통 샤를마뉴',
    expectedCandidateEntityId: 'w-coche-dury-corton-charlemagne-2019',
    forbiddenResolvedEntityId: 'w-coche-dury-corton-charlemagne-2019',
    ambiguityTypes: ['appellation', 'entity'],
    severity: 'high',
  },
  {
    query: '샹베르탱',
    expectedCandidateEntityId: 'w-armand-rousseau-chambertin-2018',
    forbiddenResolvedEntityId: 'w-armand-rousseau-chambertin-2018',
    ambiguityTypes: ['appellation', 'entity'],
    severity: 'high',
  },
  {
    query: '펜폴즈',
    expectedCandidateEntityId: 'w-penfolds-grange-2017',
    forbiddenResolvedEntityId: 'w-penfolds-grange-2017',
    ambiguityTypes: ['producer', 'entity'],
    severity: 'high',
  },
  {
    query: '샤르츠호프베르거',
    expectedCandidateEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020',
    forbiddenResolvedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020',
    ambiguityTypes: ['vineyard', 'entity'],
    severity: 'high',
  },
] as const;

const CORE_KOREAN_ICON_AMBIGUOUS_SURFACES: ReadonlySet<string> = new Set(
  CORE_KOREAN_ICON_AMBIGUITY_CASES.map((testCase) => normalizeSurfaceKey(testCase.query)),
);

interface CoreKoreanIconFixtureBundle {
  readonly cases: readonly CoreKoreanEntityCase[];
  readonly releaseGateCases: readonly CoreKoreanReleaseGateCase[];
  readonly ambiguityCases: readonly CoreKoreanAmbiguityCase[];
  readonly fixtureAliases: readonly TestFixtureAlias[];
  readonly fixtureDocuments: readonly RetrievalDocument[];
  readonly runtimeRecords: readonly EnrichedSilverRecord[];
  readonly entityIdBySourceId: ReadonlyMap<SourceRecordId, EntityId>;
}

let fixtureBundlePromise: Promise<CoreKoreanIconFixtureBundle> | undefined;

function parseNdjsonLines<T>(content: string, schema: z.ZodType<T>, filePath: string): readonly T[] {
  const records: T[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    const parsed = schema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success) {
      throw new Error(
        `Schema validation failed at ${filePath}:${index + 1}: ${parsed.error.message}`,
      );
    }
    records.push(parsed.data);
  }
  return records;
}

function normalizeSensoryNullable(value: number | null): number | null {
  return value === null ? null : Number((value / 5).toFixed(3));
}

function normalizeSensory(value: number | null): number | undefined {
  return value === null ? undefined : Number((value / 5).toFixed(3));
}

function inferSweetness(wineType: CatalogEntry['wineType']): number {
  switch (wineType) {
    case 'dessert':
      return 0.95;
    case 'sparkling':
      return 0.2;
    default:
      return 0.1;
  }
}

function derivePriceBand(priceUsd: number): 'value' | 'mid' | 'premium' | 'luxury' {
  if (priceUsd < 25) {
    return 'value';
  }
  if (priceUsd < 60) {
    return 'mid';
  }
  if (priceUsd <= 200) {
    return 'premium';
  }
  return 'luxury';
}

function buildSearchTextKo(entry: CatalogEntry, koreanAliases: readonly string[]): string {
  return [
    ...koreanAliases,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

function buildSearchTextEn(entry: CatalogEntry): string {
  return [
    entry.canonicalLabel,
    entry.producer,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

function collectCaseQueriesByEntityId(
  cases: readonly CoreKoreanEntityCase[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of cases) {
    if (testCase.identitySafe === false) {
      continue;
    }
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  return grouped;
}

function isIdentitySafeReleaseGateCase(
  testCase: CoreKoreanReleaseGateCase,
): boolean {
  return testCase.identitySafe !== false;
}

export function isIdentitySafeCoreKoreanEntityCase(
  testCase: CoreKoreanEntityCase,
): boolean {
  return testCase.identitySafe !== false;
}

function collectAmbiguousRecallQueriesByEntityId(
  cases: readonly CoreKoreanAmbiguityCase[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of cases) {
    const entityId = testCase.expectedCandidateEntityId;
    if (entityId === undefined) {
      continue;
    }
    const existing = grouped.get(entityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(entityId, existing);
  }
  return grouped;
}

function collectRecallOnlyReleaseGateQueriesByEntityId(
  cases: readonly CoreKoreanReleaseGateCase[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of cases) {
    if (testCase.identitySafe !== false) {
      continue;
    }
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  return grouped;
}

function collectRequiredEntityIds(
  cases: readonly CoreKoreanEntityCase[],
  releaseGateCases: readonly CoreKoreanReleaseGateCase[],
  ambiguityCases: readonly CoreKoreanAmbiguityCase[],
): readonly string[] {
  return uniqueSurfaceList([
    ...cases.map((testCase) => testCase.expectedEntityId),
    ...releaseGateCases.map((testCase) => testCase.expectedEntityId),
    ...ambiguityCases
      .map((testCase) => testCase.expectedCandidateEntityId)
      .filter((entityId): entityId is string => entityId !== undefined),
  ]);
}

function normalizeSurfaceKey(value: string): string {
  return buildNormalizedQueryViews(value).strict;
}

function isIdentitySafeCoreSurface(value: string): boolean {
  return !CORE_KOREAN_ICON_AMBIGUOUS_SURFACES.has(normalizeSurfaceKey(value));
}

function uniqueSurfaceList(values: Iterable<string>): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function buildFixtureAliasRows(
  entry: CatalogEntry,
  entityId: EntityId,
  caseQueries: readonly string[],
): readonly TestFixtureAlias[] {
  const surfaces = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]).filter(isIdentitySafeCoreSurface);

  return surfaces.map((surface) => ({
    surfaceForm: surface,
    entityId,
    confidence: surface === entry.canonicalLabel ? 1 : 0.95,
  }));
}

function toRetrievalDocument(
  entry: CatalogEntry,
  entityId: EntityId,
  caseQueries: readonly string[],
  ambiguousRecallQueries: readonly string[],
): RetrievalDocument {
  const identitySafe = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]).filter(isIdentitySafeCoreSurface);
  const noisyRecall = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
    ...ambiguousRecallQueries,
  ]);

  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: entry.canonicalLabel,
    aliasesIdentitySafe: identitySafe,
    aliasesNoisyRecall: noisyRecall,
    producer: entry.producer,
    region: entry.region,
    grapes: entry.grapes,
    searchTextKo: buildSearchTextKo(entry, noisyRecall),
    searchTextEn: buildSearchTextEn(entry),
    semanticSummary: `${entry.canonicalLabel}. ${entry.style}.`,
    body: normalizeSensory(entry.body),
    sweetness: inferSweetness(entry.wineType),
    style: entry.style,
    priceBand: derivePriceBand(entry.priceUsd),
    pairing: [],
    availability: true,
    popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
    vintageYear: entry.vintageYear,
    acidity: normalizeSensory(entry.acidity),
    tannin: normalizeSensory(entry.tannin),
    wineType: entry.wineType,
    grapePrimary: entry.grapes[0],
    country: entry.country,
    appellation: entry.appellation ?? entry.region,
    producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
    criticScoreNormalized: Number((entry.criticScore / 100).toFixed(3)),
    ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
    ratingsCount: 1_000,
    priceUsd: entry.priceUsd,
  };
}

function toProposedAliases(
  entry: CatalogEntry,
  caseQueries: readonly string[],
): readonly ProposedAlias[] {
  const proposalSurfaces = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
  ]).filter(isIdentitySafeCoreSurface);

  return proposalSurfaces.map((value) => ({
    value,
    type: 'translation',
    source: FIXTURE_ALIAS_SOURCE,
    confidencePrior: 0.95,
    needsReview: false,
  }));
}

function toEnrichedSilverRecord(
  entry: CatalogEntry,
  sourceId: SourceRecordId,
  caseQueries: readonly string[],
  ambiguousRecallQueries: readonly string[],
): EnrichedSilverRecord {
  const identitySafeProjection = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]).filter(isIdentitySafeCoreSurface);
  const noisyRecallProjection = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
    ...ambiguousRecallQueries,
  ]);

  return {
    sourceId,
    externalId: entry.entityId,
    canonicalLabel: entry.canonicalLabel,
    producer: entry.producer,
    vintageYear: entry.vintageYear,
    country: entry.country,
    region: entry.region,
    appellation: entry.appellation ?? null,
    wineType: entry.wineType,
    grapePrimary: entry.grapes[0] ?? null,
    grapes: entry.grapes,
    body: normalizeSensoryNullable(entry.body),
    sweetness: inferSweetness(entry.wineType),
    acidity: normalizeSensoryNullable(entry.acidity),
    tannin: normalizeSensoryNullable(entry.tannin),
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: buildSearchTextEn(entry),
    ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
    ratingsCount: 1_000,
    priceUsd: entry.priceUsd,
    priceBand: derivePriceBand(entry.priceUsd),
    popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
    scrapedAt: FIXTURE_SCRAPED_AT,
    alcoholPct: null,
    producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
    isTopRated: entry.criticScore >= 97,
    aliases: {
      proposed: toProposedAliases(entry, caseQueries),
      identitySafeProjection,
      noisyRecallProjection,
    },
  };
}

async function loadCoreCatalogEntries(
  cases: readonly CoreKoreanEntityCase[],
  releaseGateCases: readonly CoreKoreanReleaseGateCase[],
  ambiguityCases: readonly CoreKoreanAmbiguityCase[],
): Promise<readonly CatalogEntry[]> {
  const content = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  const records = parseNdjsonLines(content, CatalogEntrySchema, GOLD_CATALOG_PATH);
  const recordByEntityId = new Map(records.map((record) => [record.entityId, record] as const));
  const entries = collectRequiredEntityIds(cases, releaseGateCases, ambiguityCases).map((entityId) => {
    const record = recordByEntityId.get(entityId);
    if (record === undefined) {
      throw new Error(
        `Missing gold catalog entry for core Korean icon case: ${entityId}`,
      );
    }
    return record;
  });

  return uniqueSurfaceList(entries.map((entry) => entry.entityId))
    .map((entityId) => recordByEntityId.get(entityId))
    .filter((entry): entry is CatalogEntry => entry !== undefined);
}

async function buildFixtureBundle(): Promise<CoreKoreanIconFixtureBundle> {
  const cases = CORE_KOREAN_ICON_QUERY_CASES;
  const releaseGateCases = CORE_KOREAN_ICON_RELEASE_GATE_CASES;
  const ambiguityCases = CORE_KOREAN_ICON_AMBIGUITY_CASES;
  const catalogEntries = await loadCoreCatalogEntries(cases, releaseGateCases, ambiguityCases);
  const caseQueriesByEntityId = collectCaseQueriesByEntityId([
    ...cases,
    ...releaseGateCases.filter(isIdentitySafeReleaseGateCase),
  ]);
  const ambiguousRecallQueriesByEntityId = collectAmbiguousRecallQueriesByEntityId(ambiguityCases);
  const recallOnlyReleaseQueriesByEntityId =
    collectRecallOnlyReleaseGateQueriesByEntityId(releaseGateCases);

  const fixtureAliases: TestFixtureAlias[] = [];
  const fixtureDocuments: RetrievalDocument[] = [];
  const runtimeRecords: EnrichedSilverRecord[] = [];
  const entityIdBySourceId = new Map<SourceRecordId, EntityId>();

  for (const entry of catalogEntries) {
    const entityId = createEntityId(entry.entityId);
    const sourceId = createSourceRecordId(`core-${entry.entityId}`);
    const caseQueries = caseQueriesByEntityId.get(entry.entityId) ?? [];
    const ambiguousRecallQueries = uniqueSurfaceList([
      ...(ambiguousRecallQueriesByEntityId.get(entry.entityId) ?? []),
      ...(recallOnlyReleaseQueriesByEntityId.get(entry.entityId) ?? []),
    ]);

    fixtureAliases.push(...buildFixtureAliasRows(entry, entityId, caseQueries));
    fixtureDocuments.push(toRetrievalDocument(entry, entityId, caseQueries, ambiguousRecallQueries));
    runtimeRecords.push(toEnrichedSilverRecord(entry, sourceId, caseQueries, ambiguousRecallQueries));
    entityIdBySourceId.set(sourceId, entityId);
  }

  return {
    cases,
    releaseGateCases,
    ambiguityCases,
    fixtureAliases,
    fixtureDocuments,
    runtimeRecords,
    entityIdBySourceId,
  };
}

export async function loadCoreKoreanIconFixtureBundle(): Promise<CoreKoreanIconFixtureBundle> {
  fixtureBundlePromise ??= buildFixtureBundle();
  return fixtureBundlePromise;
}
