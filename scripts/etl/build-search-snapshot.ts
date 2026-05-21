#!/usr/bin/env tsx

import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNdjson } from './ndjson.js';
import type { EnrichedSilverRecord, PriceBand, WineType } from './types.js';
import { atomicWriteFile } from './etl-utils.js';
import {
  buildSearchSnapshotContentHash,
  buildSearchSnapshotId,
  hashStableJson,
  hashText,
  serializeNdjson,
  stableJsonStringify,
  type EntitySnapshotRecord,
  type SearchSnapshotManifest,
} from './search-snapshot-schema.js';
import { resolveAliasClaimsAndBuildAmbiguityRegistry } from './build-ambiguity-registry.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { buildAliasArtifact } from './build-alias-artifact.js';
import {
  loadActiveSourceEntityContinuity,
  loadGoldCanonicalLookupForBuild,
  resolveDefaultFixtureRepoRoot,
  resolveWineSnapshotEntity,
  type SourceEntityContinuityRecord as _SourceEntityContinuityRecord,
} from './snapshot-entity-identity.js';
import type {
  CanonicalEntityId,
  SourceRecordId,
} from '../../src/domain/shared/types/entity-id.js';
import {
  SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
  SOURCE_SYSTEM_VIVINO_SILVER,
} from '../../src/domain/shared/constants/source-systems.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { loadRequiredFixtureTargetIds } from './verify-runtime-gold-catalog-coverage.js';
import { hasHangul } from './build-alias-artifact.js';
import {
  BEGINNER_SUITABILITY_VERSION,
  GIFT_SUITABILITY_VERSION,
} from '../../src/domain/attribute/service/ontology-normalizer.js';

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;
export const DEFAULT_OUTPUT_DIR = ETL_ARTIFACT_FILES.searchSnapshotsDir;
export const DEFAULT_NL_MAPPINGS = ETL_ARTIFACT_FILES.nlMappings;
export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

export interface Args {
  readonly input: string;
  readonly outputDir: string;
  readonly nlMappings: string;
  readonly fixtureRepoRoot?: string | undefined;
  readonly runtimeStatePath?: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let nlMappings = DEFAULT_NL_MAPPINGS;
  let fixtureRepoRoot: string | undefined;
  let runtimeStatePath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? DEFAULT_INPUT;
      i += 1;
    } else if (arg === '--output-dir' || arg === '-o') {
      outputDir = argv[i + 1] ?? DEFAULT_OUTPUT_DIR;
      i += 1;
    } else if (arg === '--nl-mappings') {
      nlMappings = argv[i + 1] ?? DEFAULT_NL_MAPPINGS;
      i += 1;
    } else if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1];
      i += 1;
    } else if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? DEFAULT_RUNTIME_STATE_PATH;
      i += 1;
    }
  }
  return { input, outputDir, nlMappings, fixtureRepoRoot, runtimeStatePath };
}

function parseNlMappings(raw: string): { readonly mappingCount: number; readonly payload: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('NL mappings JSON must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const mappings = record['mappings'];
  if (!Array.isArray(mappings)) {
    throw new Error('NL mappings JSON must contain a mappings[] array');
  }
  return {
    mappingCount: mappings.length,
    payload: parsed,
  };
}

export interface BuildSearchSnapshotResult {
  readonly manifest: SearchSnapshotManifest;
  readonly snapshotRoot: string;
  readonly manifestPath: string;
}

type SnapshotBuildRecord = EnrichedSilverRecord & {
  readonly benchmarkAnchorEntityId?: CanonicalEntityId | undefined;
  readonly sourceSystemOverride?: string | undefined;
};

const BENCHMARK_ANCHOR_SUITABILITY_GENERATED_AT = '2026-04-17T00:00:00.000Z';
const BENCHMARK_ANCHOR_SUITABILITY_MODEL = 'gpt-5.4-mini';
const BENCHMARK_ANCHOR_GIFT_PROMPT_VERSION = 'gift-suitability-scorer-v2';
const BENCHMARK_ANCHOR_BEGINNER_PROMPT_VERSION = 'beginner-suitability-scorer-v2';

const SILVER_WINE_TYPES: readonly WineType[] = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'dessert',
  'fortified',
] as const;

const SILVER_PRICE_BANDS: readonly PriceBand[] = [
  'value',
  'mid',
  'premium',
  'luxury',
] as const;

const BENCHMARK_ANCHOR_SUITABILITY: Readonly<Record<string, {
  readonly gift: {
    readonly score: number;
    readonly evidenceAxes: readonly string[];
    readonly snippet: string;
    readonly rationale: string;
  };
  readonly beginner: {
    readonly score: number;
    readonly evidenceAxes: readonly string[];
    readonly snippet: string;
    readonly rationale: string;
  };
}>> = {
  'chateau-margaux-2015': {
    gift: {
      score: 0.96,
      evidenceAxes: ['occasion', 'classification', 'producer_prestige', 'pairing', 'flavor_profile', 'search_text'],
      snippet: 'occasion_tags: celebration, investment wine, special dinner; classification: Premier Grand Cru Classé; producer_prestige: 0.98; pairing_tags: beef, lamb, duck; flavor_profiles: blackcurrant, violet, cedar, graphite, tobacco, espresso, truffle; search_text_en: Chateau Margaux 2015 Bordeaux Premier Grand Cru Classé Cabernet Sauvignon full body structured tannins complex finish blackcurrant violet cedar graphite',
      rationale: 'Very strong gift suitability based on explicit catalog evidence: it is tagged for celebration and special dinner, carries a top-tier official classification, and has very high producer prestige. The flavor and search text describe a complex, structured, premium-style wine, which supports gifting for serious wine recipients. The score is kept below 100 because the catalog does not explicitly mention gift packaging or broader social gifting cues.',
    },
    beginner: {
      score: 0.18,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'tannin', 'alcohol_pct', 'flavor_profiles', 'search_text_en'],
      snippet: 'body 0.88; sweetness 0.04; acidity 0.72; tannin 0.82; alcohol_pct 13.5; flavor_profiles: blackcurrant, violet, cedar, graphite, tobacco, espresso, truffle; search_text_en: full body structured tannins complex finish',
      rationale: 'This looks like a highly structured, dry red wine with very high body and tannin, plus notable acidity and complex, savory/aromatic descriptors. Those traits usually make a wine less immediately approachable for beginners. The low sweetness also suggests little softness from residual sugar. I’m keeping the score low because the catalog explicitly points to intensity and structure rather than easy-drinking simplicity.',
    },
  },
  'romanee-conti-2015': {
    gift: {
      score: 0.98,
      evidenceAxes: ['occasion', 'classification', 'producer'],
      snippet: 'occasion_tags: investment wine, collector, ultimate celebration; classification: Grand Cru; producer: Domaine de la Romanée-Conti; producer_prestige: 1; search_text_en: ... world finest',
      rationale: 'Extremely strong gift suitability based on explicit catalog evidence: it is tagged for collector/investment use and ultimate celebration, carries Grand Cru classification, and comes from Domaine de la Romanée-Conti with producer_prestige marked 1. The search text also describes it as \'world finest,\' reinforcing exceptional status. This is a highly prestigious, occasion-appropriate wine for a special gift.',
    },
    beginner: {
      score: 0.28,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'tannin', 'alcohol_pct', 'flavor_profiles'],
      snippet: 'body: 0.85; sweetness: 0.05; acidity: 0.82; tannin: 0.7; alcohol_pct: 13; flavor_profiles: red cherry, rose petal, earth, spice, truffle, incense, forest floor, dried violets',
      rationale: 'The catalog shows a very full-bodied red with very low sweetness, high acidity, and fairly high tannin, which typically makes a wine less immediately easy for beginners. The flavor profile is complex and earthy/floral rather than simple or obviously soft, suggesting a more demanding style. Alcohol is moderate at 13%, which helps a little, but the overall structure points to low beginner-friendliness.',
    },
  },
  'moet-brut-nv': {
    gift: {
      score: 0.88,
      evidenceAxes: ['occasion', 'classification', 'producer_prestige', 'pairing', 'flavor_profile', 'wine_type', 'search_text'],
      snippet: 'occasion_tags: celebration, casual dining, aperitif; classification: Champagne NV; producer_prestige: 0.82; pairing_tags: aperitif, seafood, light snacks; flavor_profiles: green apple, citrus, brioche, toast, pear, biscuit; wine_type: sparkling; search_text_en: ... entry level classic',
      rationale: 'Strong gift suitability is supported by explicit celebration-oriented occasion tags, a recognized Champagne NV classification, and high producer prestige. The flavor profile and pairing tags suggest broad appeal and easy gifting versatility, while the sparkling wine type and classic search text reinforce a safe, widely appreciated choice. Score is high, though not maximal, because the catalog evidence does not explicitly mention premium packaging or special gift presentation.',
    },
    beginner: {
      score: 0.62,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'flavor_profiles', 'search_text_en'],
      snippet: 'body: 0.55; sweetness: 0.2; acidity: 0.8; flavor_profiles: green apple, citrus, brioche, toast, pear, biscuit; search_text_en: ... entry level classic',
      rationale: 'This looks moderately beginner-friendly based on explicit catalog evidence: it has low sweetness, moderate body, and no tannin, which can make it approachable. However, the acidity is quite high, which may be less easy for some beginners. The flavor profile is familiar and descriptive rather than challenging, and the search text explicitly says \'entry level classic,\' supporting accessibility. I kept the score moderate rather than high because the high acidity is a notable hurdle.',
    },
  },
  'yquem-2015': {
    gift: {
      score: 0.96,
      evidenceAxes: ['occasion', 'classification', 'producer_prestige', 'pairing', 'flavor_profile', 'wine_type', 'search_text'],
      snippet: 'occasion_tags: celebration, dessert course, collector; classification: Premier Cru Supérieur; producer_prestige: 1; pairing_tags: foie gras, blue cheese, fruit tart, crème brûlée; flavor_profiles: apricot, honey, botrytis, orange peel, vanilla, caramel, saffron; wine_type: dessert; search_text_en: ... greatest dessert wine',
      rationale: 'This is highly gift-suitable based on explicit catalog evidence: it has strong celebratory and collector occasion tags, a top-tier official classification, and explicit producer prestige. The pairing and flavor language also signal a distinctive, luxurious dessert wine profile that fits gifting well. I am keeping the score below 100 because the catalog does not provide broader gift-specific context beyond these strong wine-quality and occasion signals.',
    },
    beginner: {
      score: 0.72,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'wine type', 'flavor_profiles', 'alcohol_pct'],
      snippet: 'body: 0.9; sweetness: 0.98; acidity: 0.78; tannin: 0; alcohol_pct: 14; wine_type: dessert; flavor_profiles: apricot, honey, botrytis, orange peel, vanilla, caramel, saffron',
      rationale: 'This looks quite approachable for many beginners because it is explicitly very sweet, has no tannin, and is described with familiar dessert-like flavors such as apricot, honey, vanilla, and caramel. The high acidity suggests it should not feel cloying despite the sweetness. The main caution is that it is a dessert wine with 14% alcohol, so it may feel rich and intense rather than light or neutral. Overall, the explicit catalog evidence points to a fairly beginner-friendly style, especially for someone open to sweet wines.',
    },
  },
  'sassicaia-2018': {
    gift: {
      score: 0.94,
      evidenceAxes: ['classification', 'producer_prestige', 'occasion', 'pairing', 'flavor_profile', 'search_text'],
      snippet: 'Bolgheri Sassicaia DOC; producer_prestige: 0.96; occasion_tags: special dinner, wine enthusiast; pairing_tags: beef, lamb, truffle, aged cheese; flavor_profiles: blackcurrant, cedar, herbs, tobacco, dark cherry, mint, graphite; search_text_en: Italian icon',
      rationale: 'Very strong gift suitability based on explicit catalog evidence: an official DOC classification tied to Sassicaia, very high producer prestige, and occasion tags that directly signal gifting contexts like special dinner and wine enthusiast. The pairing and flavor language also suggest a serious, widely appreciated premium red. Score is high, though kept below 100 because the catalog does not explicitly mention gift packaging or broader celebratory positioning.',
    },
    beginner: {
      score: 0.22,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'tannin', 'alcohol_pct', 'flavor_profiles', 'wine_type'],
      snippet: 'body: 0.88; sweetness: 0.04; acidity: 0.74; tannin: 0.85; alcohol_pct: 14; wine_type: red; flavor_profiles: blackcurrant, cedar, herbs, tobacco, dark cherry, mint, graphite',
      rationale: 'This looks like a challenging beginner wine based on explicit catalog data: it is very full-bodied, very dry, high in acidity, and especially high in tannin, with 14% alcohol. The flavor profile also suggests a more structured, savory style (cedar, herbs, tobacco, graphite) rather than an easy, soft, fruit-forward wine. I’m keeping the score low because the catalog evidence points to a wine that is likely less approachable for beginners.',
    },
  },
  'masi-amarone-2015': {
    gift: {
      score: 0.88,
      evidenceAxes: ['classification', 'producer_prestige', 'occasion', 'pairing', 'flavor_profile', 'wine_type', 'alcohol_pct', 'search_text'],
      snippet: 'Amarone della Valpolicella DOCG; producer_prestige: 0.85; occasion_tags: special dinner, wine enthusiast; pairing_tags: beef, game, aged cheese, chocolate; flavor_profiles: dried cherry, chocolate, fig, dark plum, tobacco, star anise, coffee; wine_type: red; alcohol_pct: 15; search_text_en: ... rich',
      rationale: 'Strong gift suitability is supported by multiple explicit catalog signals: a prestigious DOCG classification, high producer prestige, and occasion tags that directly indicate gifting contexts (special dinner, wine enthusiast). The pairing and flavor profile language suggests a rich, distinctive wine that suits celebratory or enthusiast-oriented gifting. The high alcohol level and Amarone style further reinforce a serious, premium red wine profile. Evidence is strong enough for a high score, though not maximal because there is no explicit gift/packaging or broader brand-recognition evidence beyond the provided prestige field.',
    },
    beginner: {
      score: 0.18,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'tannin', 'alcohol_pct', 'flavor_profiles', 'search_text_en'],
      snippet: 'body: 0.95; sweetness: 0.08; acidity: 0.65; tannin: 0.8; alcohol_pct: 15; flavor_profiles: dried cherry, chocolate, fig, dark plum, tobacco, star anise, coffee; search_text_en: rich',
      rationale: 'This looks like a very full-bodied, dry, high-tannin, high-alcohol red with concentrated, savory/dark flavors. Those explicit traits usually make a wine less immediately approachable for beginners, especially the strong tannin and alcohol. The only beginner-friendly cue is the rich, fruit-driven flavor profile, but the overall structure suggests a challenging wine.',
    },
  },
  'opus-one-2018': {
    gift: {
      score: 0.92,
      evidenceAxes: ['occasion', 'classification', 'producer_prestige', 'pairing', 'flavor_profile', 'search_text'],
      snippet: 'occasion_tags: celebration, special dinner, investment wine; classification: Napa Valley AVA; producer_prestige: 0.97; pairing_tags: beef, lamb, truffle, venison; flavor_profiles: blackcurrant, plum, dark cherry, graphite, tobacco, cedar, dark chocolate; search_text_en: Opus One 2018 Napa Valley Cabernet Sauvignon Merlot blend blackcurrant plum dark cherry graphite tobacco cedar dark chocolate Rothschild Mondavi',
      rationale: 'Strong gift suitability is supported by explicit celebration and special-dinner occasion tags, very high producer prestige, and a formal Napa Valley AVA classification. The wine also has luxury-leaning search text and rich, classic flavor descriptors plus premium food-pairing tags, all of which make it a strong gifting choice. Score is high but not perfect because the catalog evidence does not explicitly mention gift packaging or a dedicated gifting designation.',
    },
    beginner: {
      score: 0.28,
      evidenceAxes: ['body', 'sweetness', 'acidity', 'tannin', 'alcohol_pct', 'flavor_profiles', 'wine_type', 'search_text_en'],
      snippet: 'body: 0.88; sweetness: 0.06; acidity: 0.72; tannin: 0.84; alcohol_pct: 14.5; flavor_profiles: blackcurrant, plum, dark cherry, graphite, tobacco, cedar, dark chocolate; wine_type: red; search_text_en: Opus One 2018 Napa Valley Cabernet Sauvignon Merlot blend blackcurrant plum dark cherry graphite tobacco cedar dark chocolate Rothschild Mondavi',
      rationale: 'This looks like a full-bodied, dry red with high tannin and fairly high acidity, which typically makes it less immediately easy for beginners. The flavor profile is also dominated by dark fruit plus graphite, tobacco, cedar, and dark chocolate, suggesting a structured, complex style rather than a soft or simple one. The catalog evidence supports a lower beginner-friendliness score, though not the absolute minimum because the wine is not described as extremely high-alcohol or overtly harsh.',
    },
  },
};

function assertSuitabilityCoverage(records: readonly EnrichedSilverRecord[]): void {
  const missingGift = records.filter((record) => record.giftSuitabilityClassification?.score == null);
  if (missingGift.length > 0) {
    throw new Error(
      `Search snapshot build requires full giftSuitabilityClassification coverage; missing ${missingGift.length}/${records.length} records`,
    );
  }

  const missingBeginner = records.filter((record) => record.beginnerSuitabilityClassification?.score == null);
  if (missingBeginner.length > 0) {
    throw new Error(
      `Search snapshot build requires full beginnerSuitabilityClassification coverage; missing ${missingBeginner.length}/${records.length} records`,
    );
  }
}

function resolveFixtureRepoRoot(explicit: string | undefined): string | undefined {
  if (explicit != null && explicit.length > 0) {
    return explicit;
  }
  return resolveDefaultFixtureRepoRoot();
}

async function loadActiveBenchmarkCarryForwardRecords(args: {
  readonly currentRecords: readonly SnapshotBuildRecord[];
  readonly fixtureRepoRoot?: string | undefined;
  readonly runtimeStatePath?: string | undefined;
}): Promise<readonly SnapshotBuildRecord[]> {
  const fixtureRepoRoot = resolveFixtureRepoRoot(args.fixtureRepoRoot);
  if (fixtureRepoRoot == null) {
    return [];
  }
  const runtimeStatePath = args.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  if (!existsSync(runtimeStatePath)) {
    return [];
  }

  let requiredTargetIds: readonly string[];
  try {
    requiredTargetIds = await loadRequiredFixtureTargetIds(fixtureRepoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (requiredTargetIds.length === 0) {
    return [];
  }

  const runtimeStateRaw = await fs.readFile(runtimeStatePath, 'utf8');
  const runtimeState = JSON.parse(runtimeStateRaw) as { manifestPath?: unknown };
  if (typeof runtimeState.manifestPath !== 'string' || runtimeState.manifestPath.length === 0) {
    return [];
  }
  if (!existsSync(runtimeState.manifestPath)) {
    return [];
  }

  const manifestRaw = await fs.readFile(runtimeState.manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    artifacts?: { documentsNdjson?: unknown; entitiesNdjson?: unknown };
  };
  const documentsPath = manifest.artifacts?.documentsNdjson;
  const entitiesPath = manifest.artifacts?.entitiesNdjson;
  if (
    typeof documentsPath !== 'string' || documentsPath.length === 0 || !existsSync(documentsPath)
    || typeof entitiesPath !== 'string' || entitiesPath.length === 0 || !existsSync(entitiesPath)
  ) {
    return [];
  }

  const [documentsRaw, entitiesRaw] = await Promise.all([
    fs.readFile(documentsPath, 'utf8'),
    fs.readFile(entitiesPath, 'utf8'),
  ]);
  const previousRecords = parseNdjson<EnrichedSilverRecord>(documentsRaw, documentsPath).records;
  const previousEntities = parseNdjson<EntitySnapshotRecord>(entitiesRaw, entitiesPath).records;
  const previousRecordBySourceId = new Map(previousRecords.map((record) => [record.sourceId, record] as const));
  const currentSourceIds = new Set(args.currentRecords.map((record) => record.sourceId));
  const requiredSet = new Set(requiredTargetIds);
  const carryForward = new Map<SourceRecordId, SnapshotBuildRecord>();

  for (const entity of previousEntities) {
    const metadata = entity.metadata as {
      benchmarkEntityId?: unknown;
      sourceRecordRefs?: readonly { sourceSystem?: string; sourceRecordId?: string }[];
    };
    const benchmarkEntityId =
      typeof metadata.benchmarkEntityId === 'string' ? metadata.benchmarkEntityId : undefined;
    if (!requiredSet.has(entity.entityId) && (benchmarkEntityId == null || !requiredSet.has(benchmarkEntityId))) {
      continue;
    }
    const refs = Array.isArray(metadata.sourceRecordRefs) ? metadata.sourceRecordRefs : [];
    for (const ref of refs) {
      if (ref?.sourceSystem !== SOURCE_SYSTEM_VIVINO_SILVER || typeof ref.sourceRecordId !== 'string') {
        continue;
      }
      if (currentSourceIds.has(ref.sourceRecordId as SourceRecordId)) {
        continue;
      }
      const record = previousRecordBySourceId.get(ref.sourceRecordId as SourceRecordId);
      if (record !== undefined) {
        carryForward.set(record.sourceId, record);
      }
    }
  }

  return [...carryForward.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

async function assertRequiredBenchmarkCoverage(args: {
  readonly fixtureRepoRoot?: string | undefined;
  readonly entities: readonly EntitySnapshotRecord[];
}): Promise<void> {
  const missing = await findMissingRequiredBenchmarkCoverage(args);
  if (missing.length > 0) {
    throw new Error(
      `Search snapshot build is missing required benchmark anchor coverage: ${missing.join(', ')}`,
    );
  }
}

async function findMissingRequiredBenchmarkCoverage(args: {
  readonly fixtureRepoRoot?: string | undefined;
  readonly entities: readonly EntitySnapshotRecord[];
}): Promise<readonly string[]> {
  const fixtureRepoRoot = resolveFixtureRepoRoot(args.fixtureRepoRoot);
  if (fixtureRepoRoot == null) {
    return [];
  }
  let requiredTargetIds: readonly string[];
  try {
    requiredTargetIds = await loadRequiredFixtureTargetIds(fixtureRepoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (requiredTargetIds.length === 0) {
    return [];
  }

  const covered = new Set<string>();
  for (const entity of args.entities) {
    if (requiredTargetIds.includes(entity.entityId)) {
      covered.add(entity.entityId);
    }
    const benchmarkEntityId = (entity.metadata as { benchmarkEntityId?: unknown }).benchmarkEntityId;
    if (typeof benchmarkEntityId === 'string' && requiredTargetIds.includes(benchmarkEntityId)) {
      covered.add(benchmarkEntityId);
    }
  }

  const missing = requiredTargetIds.filter((targetId) => !covered.has(targetId));
  return missing;
}

async function loadBenchmarkAnchorCatalogRecords(missingTargetIds: readonly string[]): Promise<readonly SnapshotBuildRecord[]> {
  if (missingTargetIds.length === 0) {
    return [];
  }

  const { WINES } = await import('../seed-wines-real.js');
  const requiredSet = new Set(missingTargetIds);
  const records: SnapshotBuildRecord[] = [];

  for (const doc of WINES) {
    if (!requiredSet.has(doc.entityId)) {
      continue;
    }

    const identitySafeAliases = doc.aliasesIdentitySafe ?? [];
    const noisyRecallAliases = doc.aliasesNoisyRecall ?? [];
    const proposedAliases = [
      ...identitySafeAliases.map((value) => ({
        value,
        type: 'translation' as const,
        source: 'benchmark-anchor:identity_safe_v1',
        confidencePrior: 0.95,
        needsReview: false,
      })),
      ...noisyRecallAliases.map((value) => ({
        value,
        type: hasHangul(value) ? 'phonetic' as const : 'catalog_noise_alias' as const,
        source: 'benchmark-anchor:noisy_recall_v1',
        confidencePrior: hasHangul(value) ? 0.82 : 0.68,
        needsReview: false,
      })),
    ];

    records.push(attachBenchmarkAnchorSuitability({
      sourceId: `benchmark-anchor-${doc.entityId}` as SourceRecordId,
      externalId: doc.entityId,
      canonicalLabel: doc.canonicalLabel,
      producer: doc.producer ?? doc.canonicalLabel,
      vintageYear: doc.vintageYear ?? null,
      country: doc.country ?? '',
      region: doc.region ?? '',
      appellation: doc.appellation ?? null,
      wineType: toRequiredSilverWineType(doc.wineType, doc.entityId),
      grapePrimary: doc.grapePrimary ?? null,
      grapes: doc.grapes ?? [],
      body: doc.body ?? null,
      sweetness: doc.sweetness ?? null,
      acidity: doc.acidity ?? null,
      tannin: doc.tannin ?? null,
      pairingTags: doc.pairing ?? [],
      ...(doc.occasion !== undefined ? { occasion: doc.occasion } : {}),
      flavorProfiles: doc.flavorProfiles ?? [],
      searchTextEn: doc.searchTextEn ?? doc.semanticSummary ?? doc.canonicalLabel,
      ratingAvg: null,
      ratingsCount: 0,
      priceUsd: doc.priceUsd ?? null,
      priceBand: toRequiredSilverPriceBand(doc.priceBand, doc.entityId),
      popularityScore: doc.popularityScore ?? 0,
      scrapedAt: null,
      alcoholPct: doc.alcoholPct ?? null,
      ...(doc.bottleSizeMl !== undefined ? { bottleSizeMl: doc.bottleSizeMl } : {}),
      ...(doc.bottleSize !== undefined ? { bottleSize: doc.bottleSize } : {}),
      ...(doc.closure !== undefined ? { closure: doc.closure } : {}),
      producerPrestige: doc.producerPrestige ?? null,
      isTopRated: readSeedIsTopRated(doc, doc.entityId),
      ...(doc.grapeFamily !== undefined ? { grapeFamily: doc.grapeFamily } : {}),
      ...(doc.regionHierarchy !== undefined ? { regionHierarchy: doc.regionHierarchy } : {}),
      ...(doc.finishLength !== undefined ? { finishLength: doc.finishLength } : {}),
      ...(doc.classification !== undefined ? { classification: doc.classification } : {}),
      ...(doc.oakTreatment !== undefined ? { oakTreatment: doc.oakTreatment } : {}),
      ...(doc.soilType !== undefined ? { soilType: doc.soilType } : {}),
      ...(doc.producerType !== undefined ? { producerType: doc.producerType } : {}),
      benchmarkAnchorEntityId: doc.entityId,
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
      aliases: {
        proposed: proposedAliases,
        identitySafeProjection: identitySafeAliases,
        noisyRecallProjection: noisyRecallAliases,
      },
    }));
  }

  return records.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function resolveSourceSystemForRecord(record: EnrichedSilverRecord): string {
  return (record as SnapshotBuildRecord).sourceSystemOverride
    ?? (record.sourceId.startsWith('benchmark-anchor-')
      ? SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG
      : SOURCE_SYSTEM_VIVINO_SILVER);
}

function toRequiredSilverWineType(value: string | undefined, entityId: string): WineType {
  if (value !== undefined && (SILVER_WINE_TYPES as readonly string[]).includes(value)) {
    return value as WineType;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid wineType=${JSON.stringify(value)}`);
}

function toRequiredSilverPriceBand(value: string | undefined, entityId: string): PriceBand {
  if (value !== undefined && (SILVER_PRICE_BANDS as readonly string[]).includes(value)) {
    return value as PriceBand;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid priceBand=${JSON.stringify(value)}`);
}

function readSeedIsTopRated(doc: object, entityId: string): boolean {
  const value = (doc as { readonly isTopRated?: unknown }).isTopRated;
  if (value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid isTopRated=${JSON.stringify(value)}`);
}

export function buildGiftSuitabilityContentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update([
    record.canonicalLabel,
    record.producer,
    record.country,
    record.region,
    record.wineType,
    record.priceBand,
    record.searchTextEn,
    record.pairingTags.join('|'),
    record.flavorProfiles.join('|'),
    record.classification ?? '',
    String(record.producerPrestige ?? ''),
    String(record.alcoholPct ?? ''),
    (record.occasion ?? []).join('|'),
  ].join('\n')).digest('hex');
}

export function buildBeginnerSuitabilityContentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update([
    record.canonicalLabel,
    record.producer,
    record.wineType,
    record.priceBand,
    String(record.body ?? ''),
    String(record.sweetness ?? ''),
    String(record.acidity ?? ''),
    String(record.tannin ?? ''),
    String(record.alcoholPct ?? ''),
    record.grapePrimary ?? '',
    record.flavorProfiles.join('|'),
    record.searchTextEn,
  ].join('\n')).digest('hex');
}

function attachBenchmarkAnchorSuitability(record: SnapshotBuildRecord): SnapshotBuildRecord {
  if (record.benchmarkAnchorEntityId === undefined) {
    return record;
  }
  const seed = BENCHMARK_ANCHOR_SUITABILITY[record.benchmarkAnchorEntityId];
  if (seed === undefined) {
    return record;
  }
  return {
    ...record,
    giftSuitabilityClassification: {
      score: seed.gift.score,
      fingerprint: {
        modelId: BENCHMARK_ANCHOR_SUITABILITY_MODEL,
        contentHash: buildGiftSuitabilityContentHash(record),
        version: GIFT_SUITABILITY_VERSION,
        generatedAt: BENCHMARK_ANCHOR_SUITABILITY_GENERATED_AT,
      },
      provenance: {
        source: 'llm_gift_suitability_scorer',
        promptVersion: BENCHMARK_ANCHOR_GIFT_PROMPT_VERSION,
        evidenceAxes: seed.gift.evidenceAxes,
        snippet: seed.gift.snippet,
        rationale: seed.gift.rationale,
      },
    },
    beginnerSuitabilityClassification: {
      score: seed.beginner.score,
      fingerprint: {
        modelId: BENCHMARK_ANCHOR_SUITABILITY_MODEL,
        contentHash: buildBeginnerSuitabilityContentHash(record),
        version: BEGINNER_SUITABILITY_VERSION,
        generatedAt: BENCHMARK_ANCHOR_SUITABILITY_GENERATED_AT,
      },
      provenance: {
        source: 'llm_beginner_suitability_scorer',
        promptVersion: BENCHMARK_ANCHOR_BEGINNER_PROMPT_VERSION,
        evidenceAxes: seed.beginner.evidenceAxes,
        snippet: seed.beginner.snippet,
        rationale: seed.beginner.rationale,
      },
    },
  };
}

function buildArtifactsForRecords(args: {
  readonly records: readonly SnapshotBuildRecord[];
  readonly goldLookup: ReadonlyMap<string, string>;
  readonly sourceContinuityLookup: ReadonlyMap<SourceRecordId, {
    readonly entityId: CanonicalEntityId;
    readonly identitySignature: string;
    readonly benchmarkEntityId?: CanonicalEntityId;
  }>;
}): {
  readonly entityArtifact: readonly EntitySnapshotRecord[];
  readonly resolvedAliases: ReturnType<typeof resolveAliasClaimsAndBuildAmbiguityRegistry>['resolvedAliases'];
  readonly ambiguityRows: ReturnType<typeof resolveAliasClaimsAndBuildAmbiguityRegistry>['ambiguityRows'];
} {
  const entityArtifact: EntitySnapshotRecord[] = [];
  const entityIdBySourceId = new Map<SourceRecordId, CanonicalEntityId>();

  for (const record of args.records) {
    const resolved = resolveWineSnapshotEntity(record, args.goldLookup, args.sourceContinuityLookup);
    const runtimeEntityId = record.benchmarkAnchorEntityId ?? resolved.entityId;
    const benchmarkEntityId = record.benchmarkAnchorEntityId ?? resolved.benchmarkEntityId;
    const occasion = record.occasionClassification?.values ?? record.occasion;
    entityArtifact.push({
      entityId: runtimeEntityId,
      entityType: 'wine',
      canonicalLabel: record.canonicalLabel,
      identitySignature: resolved.identitySignature,
      relations: {},
      attributes: {
        grapes: record.grapes,
        wineType: record.wineType,
        style: record.wineType,
        ...(record.body != null ? { body: record.body } : {}),
        ...(record.sweetness != null ? { sweetness: record.sweetness } : {}),
        ...(record.acidity != null ? { acidity: record.acidity } : {}),
        ...(record.tannin != null ? { tannin: record.tannin } : {}),
        region: record.region,
        priceBand: record.priceBand,
        giftSuitabilityScore: record.giftSuitabilityClassification?.score,
        beginnerSuitabilityScore: record.beginnerSuitabilityClassification?.score,
        ...(record.vintageYear != null ? { vintage: record.vintageYear } : {}),
        pairing: record.pairingTags,
        ...(occasion !== undefined && occasion.length > 0
          ? { occasion: [...occasion] }
          : {}),
      },
      metadata: {
        source: 'snapshot:silver_trackc_v1',
        trustTier: 'high',
        externalId: record.externalId,
        producer: record.producer,
        country: record.country,
        region: record.region,
        ...(record.appellation != null ? { appellation: record.appellation } : {}),
        identityResolution: resolved.resolution,
        ...(benchmarkEntityId != null ? { benchmarkEntityId } : {}),
        sourceRecordRefs: [
          { sourceSystem: resolveSourceSystemForRecord(record), sourceRecordId: record.sourceId },
        ],
      },
    } as const);
    entityIdBySourceId.set(record.sourceId, runtimeEntityId);
  }
  entityArtifact.sort((left, right) => left.entityId.localeCompare(right.entityId));
  const aliasArtifact = buildAliasArtifact(args.records, entityIdBySourceId);
  const { resolvedAliases, ambiguityRows } = resolveAliasClaimsAndBuildAmbiguityRegistry(aliasArtifact);
  return { entityArtifact, resolvedAliases, ambiguityRows };
}

export async function buildSearchSnapshot(args: Args): Promise<BuildSearchSnapshotResult> {
  const [recordContent, nlMappingsRaw] = await Promise.all([
    fs.readFile(args.input, 'utf8'),
    fs.readFile(args.nlMappings, 'utf8'),
  ]);

  const parsed = parseNdjson<EnrichedSilverRecord>(recordContent, args.input);
  const baseRecords: SnapshotBuildRecord[] = [...parsed.records]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  assertSuitabilityCoverage(baseRecords);
  const [goldLookup, sourceContinuityLookup, carryForwardRecords] = await Promise.all([
    loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepoRoot }),
    loadActiveSourceEntityContinuity(args.runtimeStatePath),
    loadActiveBenchmarkCarryForwardRecords({
      currentRecords: baseRecords,
      fixtureRepoRoot: args.fixtureRepoRoot,
      runtimeStatePath: args.runtimeStatePath,
    }),
  ]);
  const records = [...baseRecords, ...carryForwardRecords]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  let finalRecords = records;
  let {
    entityArtifact,
    resolvedAliases,
    ambiguityRows,
  } = buildArtifactsForRecords({
    records: finalRecords,
    goldLookup,
    sourceContinuityLookup,
  });
  const missingBenchmarkCoverage = await findMissingRequiredBenchmarkCoverage({
    fixtureRepoRoot: args.fixtureRepoRoot,
    entities: entityArtifact,
  });
  if (missingBenchmarkCoverage.length > 0) {
    const benchmarkAnchorRecords = await loadBenchmarkAnchorCatalogRecords(missingBenchmarkCoverage);
    finalRecords = [...finalRecords, ...benchmarkAnchorRecords]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    ({
      entityArtifact,
      resolvedAliases,
      ambiguityRows,
    } = buildArtifactsForRecords({
      records: finalRecords,
      goldLookup,
      sourceContinuityLookup,
    }));
  }
  await assertRequiredBenchmarkCoverage({
    fixtureRepoRoot: args.fixtureRepoRoot,
    entities: entityArtifact,
  });
  const nlMappings = parseNlMappings(nlMappingsRaw);

  const documentsNdjson = serializeNdjson(finalRecords);
  const entitiesNdjson = serializeNdjson(entityArtifact);
  const aliasesNdjson = serializeNdjson(resolvedAliases);
  const ambiguityNdjson = serializeNdjson(ambiguityRows);
  const nlMappingsCanonical = `${stableJsonStringify(nlMappings.payload)}\n`;

  const hashes = {
    documents: hashText(documentsNdjson),
    vespaFeed: hashText(''),
    entities: hashStableJson(entityArtifact),
    aliases: hashStableJson(resolvedAliases),
    ambiguityRegistry: hashStableJson(ambiguityRows),
    nlMappings: hashText(nlMappingsCanonical),
  } as const;

  const contentHash = buildSearchSnapshotContentHash(hashes);
  const snapshotId = buildSearchSnapshotId(contentHash);
  const snapshotRoot = path.join(args.outputDir, snapshotId);

  const manifest: SearchSnapshotManifest = {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    generatedAt: new Date().toISOString(),
    contentHash,
    sourceInputPath: args.input,
    artifacts: {
      documentsNdjson: path.join(snapshotRoot, 'documents.ndjson'),
      vespaFeedNdjson: path.join(snapshotRoot, 'vespa-feed.ndjson'),
      entitiesNdjson: path.join(snapshotRoot, 'entities.ndjson'),
      aliasesNdjson: path.join(snapshotRoot, 'aliases.ndjson'),
      ambiguityRegistryNdjson: path.join(snapshotRoot, 'ambiguity-registry.ndjson'),
      nlMappingsJson: path.join(snapshotRoot, 'nl-mappings.json'),
      metadataJson: path.join(snapshotRoot, 'metadata.json'),
    },
    counts: {
      documents: finalRecords.length,
      vespaFeed: 0,
      entities: entityArtifact.length,
      aliases: resolvedAliases.length,
      ambiguityRegistry: ambiguityRows.length,
      nlMappings: nlMappings.mappingCount,
    },
    hashes,
  };

  const metadata = {
    snapshotId,
    generatedAt: manifest.generatedAt,
    sourceInputPath: args.input,
    counts: manifest.counts,
    hashes: manifest.hashes,
  } as const;

  await fs.mkdir(snapshotRoot, { recursive: true });
  await Promise.all([
    atomicWriteFile(manifest.artifacts.documentsNdjson, documentsNdjson),
    fs.rm(manifest.artifacts.vespaFeedNdjson, { force: true }),
    atomicWriteFile(manifest.artifacts.entitiesNdjson, entitiesNdjson),
    atomicWriteFile(manifest.artifacts.aliasesNdjson, aliasesNdjson),
    atomicWriteFile(manifest.artifacts.ambiguityRegistryNdjson, ambiguityNdjson),
    atomicWriteFile(manifest.artifacts.nlMappingsJson, nlMappingsCanonical),
    atomicWriteFile(manifest.artifacts.metadataJson, `${JSON.stringify(metadata, null, 2)}\n`),
    atomicWriteFile(path.join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  return {
    manifest,
    snapshotRoot,
    manifestPath: path.join(snapshotRoot, 'manifest.json'),
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildSearchSnapshot(args);
  console.log(`Built search snapshot ${result.manifest.snapshotId}`);
  console.log(`snapshot_root=${result.snapshotRoot}`);
  console.log(`manifest=${result.manifestPath}`);
  console.log(`documents=${result.manifest.counts.documents}`);
  console.log(`entities=${result.manifest.counts.entities}`);
  console.log(`aliases=${result.manifest.counts.aliases}`);
  console.log(`ambiguity_registry=${result.manifest.counts.ambiguityRegistry}`);
  console.log(`nl_mappings=${result.manifest.counts.nlMappings}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
