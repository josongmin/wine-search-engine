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
  { query: '페트뤼스', expectedEntityId: 'w-petrus-2016', identitySafe: false },
  // Bare Cheval Blanc is no longer identity-safe after the Korean stretch
  // backfill materialized multiple vintages (2010/2015/2017). The surface
  // remains recall-safe, but lookup must not force a singleton owner.
  { query: '슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015', identitySafe: false },
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
  // Requested-vintage runtime/catalog backfill (lookup-v2 korean-realworld-stretch
  // `requested_vintage_missing` packet). Each is a real, separately-released vintage
  // of an iconic family whose only runtime owner was a single other vintage; the
  // gold-catalog row materializes the entity and the family-core-witness registry
  // joins it to the producer family. identitySafe:false because the bare family
  // surface owns a DIFFERENT vintage — these vintage-qualified forms resolve via
  // vintage-aware family-member selection (the dual of the vintage-mismatch guard):
  // a vintage-conflicting query under a singleton witness re-enables the family-graph
  // expansion (normally suppressed for singletons), which surfaces the requested-vintage
  // sibling from the wrong-vintage anchor for selection. Closable ONLY when the bare
  // family surface is protected from displacement by the newly-materialized vintage:
  // Calon-Ségur's bare alias is pinned by a curated exact-safe registry row (→ the
  // incumbent 2003), so adding 2009/2012/2020 cannot hijack the bare query. Residue:
  // Solaia (no curated bare-alias pin → a gold sibling would displace the scope-target
  // incumbent for `솔라이아 2018`) and mixed-script "Opus 원 2019" (the surface recalls
  // NO opus entity — a separate alias-normalization gap) stay open.
  { query: '슈발 블랑 2010', expectedEntityId: 'w-cheval-blanc-2010', identitySafe: false },
  { query: '슈발 블랑 2017', expectedEntityId: 'w-cheval-blanc-2017', identitySafe: false },
  { query: '칼롱 세귀르 2009', expectedEntityId: 'w-calon-segur-2009', identitySafe: false },
  { query: '칼롱 세귀르 2012', expectedEntityId: 'w-calon-segur-2012', identitySafe: false },
  { query: '칼롱 세귀르 2020', expectedEntityId: 'w-calon-segur-2020', identitySafe: false },
  { query: '파비 2014', expectedEntityId: 'w-pavie-2014', identitySafe: false },
  { query: '파비 2017', expectedEntityId: 'w-pavie-2017', identitySafe: false },
  // Pol Roger line runtime/catalog backfill (lookup-v2 korean-realworld-stretch
  // `family_surface_needs_specific_line` packet). The only runtime owner was a single noisy
  // Vivino vintage ("2020 Pol Roger Champagne") with no specific line. These gold rows
  // materialize the real product lines (Brut Réserve flagship + prestige Cuvée Sir Winston
  // Churchill) as exact-safe identity singletons; the family-core-witness registry joins them
  // to the `pol roger` producer family. The two-digit vintage surface ("폴 로저 18") resolves
  // as an exact-safe identity SINGLETON: the requested 2018 vintage is a collision-free unique
  // owner, so a curated korean-exact-safe-registry row promotes "폴 로저 18" → the 2018 entity.
  // The exact-safe planner matches the full vintage-canonicalized surface BEFORE family-vintage
  // selection (search-snapshot-exact-safe-registry tries the vintageCanonicalized view), so it
  // resolves cleanly (identitySafe:true). This is the dual of multi-vintage families whose bare
  // surface is owned by a different vintage and stay requested_vintage_missing residue.
  { query: '폴로저 브뤼', expectedEntityId: 'w-pol-roger-brut-reserve-nv' },
  { query: '폴로저브뤼', expectedEntityId: 'w-pol-roger-brut-reserve-nv' },
  { query: 'Pol Roger 브뤼', expectedEntityId: 'w-pol-roger-brut-reserve-nv' },
  { query: '메종 폴 로저', expectedEntityId: 'w-pol-roger-brut-reserve-nv' },
  { query: '폴 로저 윈스턴 처칠', expectedEntityId: 'w-pol-roger-sir-winston-churchill-2015' },
  { query: '폴 로저 18', expectedEntityId: 'w-pol-roger-brut-vintage-2018' },
  // Château Ausone non-vintage backfill (lookup-v2 korean-realworld-stretch scope_target_missing).
  // Single gold vintage (2016) → bare/producer/orthography/mixed-script/brand surfaces are
  // collision-free exact-safe identity singletons of the 2016 owner (no multi-vintage ambiguity).
  // Vintage-qualified forms (오존 2015/2020) remain residue until those vintages are materialized.
  { query: '오존', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '샤또 오존', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '오쏜', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '샤또 Ausone', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '오존 생테밀리옹', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '오존생테밀리옹', expectedEntityId: 'w-chateau-ausone-2016' },
  { query: '샤또 오존 생테밀리옹', expectedEntityId: 'w-chateau-ausone-2016' },
  // Pure-vintage famous-wine backfill (lookup-v2 korean-realworld-stretch scope_target_missing).
  // Each residue surface is a vintage-qualified form whose requested vintage is a collision-free
  // unique owner → materialize the gold vintage entity + a curated korean-exact-safe-registry
  // singleton (surface vintage == entity vintage), so the exact-safe planner resolves it directly
  // (identitySafe:true). No bare-family residue → no multi-vintage ambiguity.
  { query: '탈보 2018', expectedEntityId: 'w-talbot-2018' },
  { query: '탈보 09', expectedEntityId: 'w-talbot-2009' },
  { query: '몽로즈 2019', expectedEntityId: 'w-montrose-2019' },
  { query: '몽로즈 10', expectedEntityId: 'w-montrose-2010' },
  { query: '팔머 2020', expectedEntityId: 'w-palmer-2020' },
  { query: '팔머 12', expectedEntityId: 'w-palmer-2012' },
  { query: '피숑 바롱 2009', expectedEntityId: 'w-pichon-baron-2009' },
  { query: '피숑 바롱 16', expectedEntityId: 'w-pichon-baron-2016' },
  { query: '퐁테 카네 2011', expectedEntityId: 'w-pontet-canet-2011' },
  { query: '퐁테 카네 14', expectedEntityId: 'w-pontet-canet-2014' },
  { query: '랭쉬 바주 2016', expectedEntityId: 'w-lynch-bages-2016' },
  { query: '랭쉬 바주 11', expectedEntityId: 'w-lynch-bages-2011' },
  { query: '코스 데스투르넬 2013', expectedEntityId: 'w-cos-destournel-2013' },
  { query: '코스 데스투르넬 15', expectedEntityId: 'w-cos-destournel-2015' },
  { query: '베이슈벨 2017', expectedEntityId: 'w-beychevelle-2017' },
  { query: '베이슈벨 13', expectedEntityId: 'w-beychevelle-2013' },
  { query: '몬텔레나 11', expectedEntityId: 'w-montelena-2011' },
  { query: '몬테 벨로 17', expectedEntityId: 'w-ridge-monte-bello-2017' },
  { query: '앙젤뤼스 2012', expectedEntityId: 'w-angelus-2012' },
  { query: '앙젤뤼스 18', expectedEntityId: 'w-angelus-2018' },
  { query: '앙젤뤼스 2016', expectedEntityId: 'w-angelus-2016' },
  // Remaining vintage residue via exact-safe singletons (caymus incl. the "카베르네 2019" strict-
  // collision surface → exact-safe pins it; opus/solaia/pavie missing vintages; bollinger 2020).
  { query: '케이머스 19', expectedEntityId: 'w-caymus-cabernet-2019' },
  { query: '케이머스 카베르네 2019', expectedEntityId: 'w-caymus-cabernet-2019' },
  { query: '케이머스 2010', expectedEntityId: 'w-caymus-cabernet-2010' },
  { query: '케이머스 2015', expectedEntityId: 'w-caymus-cabernet-2015' },
  { query: 'Opus 원 2019', expectedEntityId: 'w-opus-one-2019' },
  { query: '솔라이아 2016', expectedEntityId: 'w-solaia-2016' },
  { query: '솔라이아 2019', expectedEntityId: 'w-solaia-2019' },
  { query: '솔라이아 19', expectedEntityId: 'w-solaia-2019' },
  { query: '파비 19', expectedEntityId: 'w-pavie-2019' },
  { query: '볼랭저 20', expectedEntityId: 'w-bollinger-la-grande-annee-2020' },
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

  { query: '페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'gold_wine_catalog'], identitySafe: false },
  { query: '페트러스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'gold_wine_catalog'], identitySafe: false },
  { query: '페트루스', expectedEntityId: 'w-petrus-2016', sources: ['korean_wine_aliases', 'entity_alias_catalog'], identitySafe: false },
  { query: '샤또 페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤토 페트루스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤또페트뤼스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },
  { query: '샤토페트루스', expectedEntityId: 'w-petrus-2016', sources: ['entity_alias_catalog'] },

  // Bare / compact Cheval Blanc surfaces now fan out to multiple vintages in
  // lookup-v2. Keep them on the recall-only lane until an explicit reviewed
  // bare-surface owner policy exists.
  { query: '슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['entity_alias_catalog', 'gold_wine_catalog'], identitySafe: false },
  { query: '슈발블랑', expectedEntityId: 'w-cheval-blanc-2015', sources: ['entity_alias_catalog', 'gold_wine_catalog'], identitySafe: false },
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
  { query: '사시카야', expectedEntityId: 'w-sassicaia-2018', sources: ['user_requirement'], identitySafe: false },
  { query: '사씨카이아', expectedEntityId: 'w-sassicaia-2018', sources: ['korean_wine_aliases', 'entity_alias_catalog'] },
  { query: '사씨카이야', expectedEntityId: 'w-sassicaia-2018', sources: ['user_requirement'], identitySafe: false },
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
  { query: '베가시실리아', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'gold_wine_catalog'], identitySafe: false },
  { query: '베가 시칠리아', expectedEntityId: 'w-vega-sicilia-unico-2012', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'], identitySafe: false },
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
  { query: '그레인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['gold_wine_catalog'], identitySafe: false },
  { query: '그랜지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases', 'entity_alias_catalog', 'web_usage'], identitySafe: false },
  { query: '그래인지', expectedEntityId: 'w-penfolds-grange-2017', sources: ['korean_wine_aliases'], identitySafe: false },
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
