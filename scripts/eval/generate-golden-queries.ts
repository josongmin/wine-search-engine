#!/usr/bin/env tsx
/**
 * Golden Query Generator: Reads Silver NDJSON and produces Bronze-tier
 * golden queries (LLM-assisted) for all 8 scenarios.
 *
 * Generates queries per entity with scenario distribution, then writes
 * to NDJSON with full leakage keys and graded relevance labels.
 *
 * This is the RULE-BASED generator (no LLM call). For LLM-assisted
 * generation, extend the promptForEntity() function to call Claude API.
 *
 * Usage:
 *   npx tsx scripts/eval/generate-golden-queries.ts
 *   npx tsx scripts/eval/generate-golden-queries.ts --input data/silver-docquery.ndjson
 *   npx tsx scripts/eval/generate-golden-queries.ts --fixture-repo ../wine-engine-fixture
 *
 * This script produces an engine-local derived artifact only. It does NOT
 * define release-gate benchmark truth; fixture-native corpora in the external
 * fixture repository remain the SSOT.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parseNdjson } from '../etl/ndjson.js';
import type {
  EnrichedSilverRecord,
  GoldenQuery,
  GoldenQueryClass,
  Scenario,
  RelevanceJudgment,
} from '../etl/types.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  buildEntityIdBySourceId,
  loadGoldCanonicalLookupForBuild,
} from '../etl/snapshot-entity-identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = resolveDataPath('data/silver-docquery.ndjson');
const DEFAULT_OUTPUT = resolveDataPath('data/golden-queries-bronze.snapshot.jsonl');
const RUN_ID = `run-${new Date().toISOString().slice(0, 10)}-001`;

// Scenario targets (total = 500)
const SCENARIO_TARGETS: Record<Scenario, { count: number; queryClass: GoldenQueryClass }> = {
  A: { count: 75, queryClass: 'exact_entity' },
  B: { count: 60, queryClass: 'ambiguous_short_form' },
  C: { count: 75, queryClass: 'semantic_preference' },
  D: { count: 60, queryClass: 'pure_constraint' },
  E: { count: 50, queryClass: 'exploration' },
  F: { count: 50, queryClass: 'similar_compare' },
  G: { count: 50, queryClass: 'catalog_browse' },
  H: { count: 40, queryClass: 'noisy_recall' },
  no_match: { count: 40, queryClass: 'no_match' },
};

// Language distribution: EN 60% / KO 30% / Mixed 10%
// Within each scenario, distribute languages to hit these global targets.
// Target: EN 60%, KO 30%, Mixed 10% — enforced by assignLanguage() below.

/**
 * Assigns language to a query within a scenario based on index to achieve
 * the 60/30/10 target distribution across the full query set.
 */
function assignLanguage(idx: number): 'en' | 'ko' | 'mixed' {
  const mod = idx % 10;
  // 0-5 → en (60%), 6-8 → ko (30%), 9 → mixed (10%)
  if (mod <= 5) return 'en';
  if (mod <= 8) return 'ko';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  /** Optional path to wine-engine-fixture (ADR-007 gold canonical overlay). */
  fixtureRepo?: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--fixture-repo') {
      const next = argv[++i];
      if (next != null && next.length > 0) out.fixtureRepo = next;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQid(scenario: Scenario, index: number): string {
  return `q-${scenario.toLowerCase().replace('_', '')}-${String(index).padStart(4, '0')}`;
}

function aliasCluster(record: EnrichedSilverRecord): string {
  // Cluster by producer prefix (e.g. all "Léoville-*" share a cluster)
  const lower = record.producer.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return lower.slice(0, 30);
}

function removeAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

/** Build a same-producer relevance set (ADR-007: `entity_id` is canonical public identity). */
function buildProducerRelevanceSet(
  target: EnrichedSilverRecord,
  all: readonly EnrichedSilverRecord[],
  canonicalEntityId: (r: EnrichedSilverRecord) => string,
): RelevanceJudgment[] {
  const judgments: RelevanceJudgment[] = [
    { entity_id: canonicalEntityId(target), grade: 3 },
  ];

  // Same producer, different wine = grade 1-2
  for (const rec of all) {
    if (rec.sourceId === target.sourceId) continue;
    if (rec.producer.toLowerCase() === target.producer.toLowerCase()) {
      const grade = rec.vintageYear === target.vintageYear ? 2 : 1;
      judgments.push({ entity_id: canonicalEntityId(rec), grade: grade as 1 | 2 });
      if (judgments.length >= 5) break;
    }
  }

  return judgments;
}

// ---------------------------------------------------------------------------
// Query generators per scenario
// ---------------------------------------------------------------------------

type CanonicalEntityIdOf = (record: EnrichedSilverRecord) => string;

type QueryGen = (
  record: EnrichedSilverRecord,
  all: readonly EnrichedSilverRecord[],
  idx: number,
  canonicalEntityId: CanonicalEntityIdOf,
) => GoldenQuery | null;

const scenarioA: QueryGen = (rec, all, idx, cid) => {
  // Exact entity with full name + vintage
  const lang = assignLanguage(idx);
  const query = lang === 'ko' && rec.aliases.noisyRecallProjection.length > 0
    ? rec.aliases.noisyRecallProjection[0]!
    : rec.canonicalLabel;
  return {
    qid: makeQid('A', idx),
    query,
    query_class: 'exact_entity',
    scenario: 'A',
    language: lang,
    retrieval_labels: {
      relevant: buildProducerRelevanceSet(rec, all, cid),
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: cid(rec),
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'exact_entity_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:exact_entity_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioB: QueryGen = (rec, _all, idx, cid) => {
  // Short / ambiguous alias (producer only, no vintage)
  const lang = assignLanguage(idx);
  const query = rec.producer;
  if (query.length < 3) return null;
  return {
    qid: makeQid('B', idx),
    query,
    query_class: 'ambiguous_short_form',
    scenario: 'B',
    language: lang,
    retrieval_labels: {
      relevant: [{ entity_id: cid(rec), grade: 2 }],
    },
    decision_labels: {
      expected_decision_status: 'ambiguous',
      ambiguity_expected: true,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'short_alias_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:short_alias_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioC: QueryGen = (rec, _all, idx, cid) => {
  // Semantic preference query (no wine name, style-based)
  const lang = assignLanguage(idx);
  let query: string;
  // Extract just the top-level region label (before any "/" separator)
  const regionLabel = rec.region ? rec.region.split('/')[0]!.trim() : '';
  if (lang === 'ko' || lang === 'mixed') {
    const bodyDesc = rec.body >= 0.7 ? '묵직한' : rec.body >= 0.4 ? '미디엄' : '가벼운';
    const typeDesc = rec.wineType === 'red' ? '레드' : rec.wineType === 'white' ? '화이트' : rec.wineType;
    const regionPart = regionLabel ? ` ${regionLabel}` : '';
    query = `${bodyDesc}${regionPart} ${typeDesc} 추천`;
  } else {
    const bodyDesc = rec.body >= 0.7 ? 'full-bodied' : rec.body >= 0.4 ? 'medium-bodied' : 'light-bodied';
    if (regionLabel) {
      // Vary phrasing: "recommend a full-bodied Barolo red" or "Tuscany red with medium body"
      query = idx % 2 === 0
        ? `recommend a ${bodyDesc} ${regionLabel} ${rec.wineType}`
        : `${regionLabel} ${rec.wineType} with ${bodyDesc.replace('-', ' ')} body`;
    } else {
      query = `recommend a ${bodyDesc} ${rec.wineType}`;
    }
  }
  return {
    qid: makeQid('C', idx),
    query,
    query_class: 'semantic_preference',
    scenario: 'C',
    language: lang,
    retrieval_labels: {
      relevant: [{ entity_id: cid(rec), grade: 2 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'semantic_pref_ko_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:semantic_pref_ko_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioD: QueryGen = (rec, _all, idx, cid) => {
  // Constraint query (price + region + type)
  if (rec.priceUsd === null) return null;
  const lang = assignLanguage(idx);
  let query: string;
  // Extract just the top-level region label (before any "/" separator)
  const regionLabel = rec.region ? rec.region.split('/')[0]!.trim() : '';
  if (lang === 'ko' || lang === 'mixed') {
    const priceLabel =
      rec.priceUsd < 50 ? '5만원 이하' : rec.priceUsd < 150 ? '15만원 이하' : '50만원 이하';
    const typeDesc = rec.wineType === 'red' ? '레드' : rec.wineType === 'white' ? '화이트' : rec.wineType;
    const regionPart = regionLabel ? `${regionLabel} ` : '';
    query = `${regionPart}${typeDesc} ${priceLabel}`;
  } else {
    const priceLabel =
      rec.priceUsd < 50 ? 'under $50' : rec.priceUsd < 150 ? 'under $150' : 'under $500';
    if (regionLabel) {
      // Vary phrasing: "red wine from Barolo under $150" or "good Rioja red for under $50"
      query = idx % 2 === 0
        ? `${rec.wineType} from ${regionLabel} ${priceLabel}`
        : `good ${regionLabel} ${rec.wineType} for ${priceLabel}`;
    } else {
      query = `${rec.wineType} ${priceLabel}`;
    }
  }
  return {
    qid: makeQid('D', idx),
    query,
    query_class: 'pure_constraint',
    scenario: 'D',
    language: lang,
    retrieval_labels: {
      relevant: [{ entity_id: cid(rec), grade: 2 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'constraint_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:constraint_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioE: QueryGen = (rec, _all, idx, cid) => {
  // Exploration / recommendation
  const pairing = rec.pairingTags[0];
  if (!pairing) return null;
  const lang = assignLanguage(idx);
  const query = lang === 'en'
    ? `wine for ${pairing}`
    : `${pairing}에 어울리는 와인`;
  return {
    qid: makeQid('E', idx),
    query,
    query_class: 'exploration',
    scenario: 'E',
    language: lang,
    retrieval_labels: {
      relevant: [{ entity_id: cid(rec), grade: 1 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'exploration_pairing_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:exploration_pairing_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

/** Find wines similar to seed by style (same type + body ± 0.2). */
function findSimilarWines(
  seed: EnrichedSilverRecord,
  all: readonly EnrichedSilverRecord[],
  canonicalEntityId: CanonicalEntityIdOf,
): RelevanceJudgment[] {
  const judgments: RelevanceJudgment[] = [];
  for (const rec of all) {
    if (rec.sourceId === seed.sourceId) continue; // exclude seed
    if (rec.wineType !== seed.wineType) continue;
    const bodyDiff = Math.abs(rec.body - seed.body);
    if (bodyDiff > 0.25) continue;
    // Same region = grade 3, different region = grade 2
    const sameRegion =
      rec.region.toLowerCase() === seed.region.toLowerCase();
    judgments.push({
      entity_id: canonicalEntityId(rec),
      grade: sameRegion ? 3 : 2,
    });
    if (judgments.length >= 5) break;
  }
  return judgments;
}

const scenarioF: QueryGen = (rec, all, idx, cid) => {
  // Similar / compare ("비슷한 와인")
  const lang = assignLanguage(idx);
  const query = lang === 'en'
    ? `wines similar to ${rec.canonicalLabel}`
    : `${rec.canonicalLabel} 비슷한 와인`;
  const similarWines = findSimilarWines(rec, all, cid);
  if (similarWines.length === 0) return null; // need at least 1 similar wine
  return {
    qid: makeQid('F', idx),
    query,
    query_class: 'similar_compare',
    scenario: 'F',
    language: lang,
    retrieval_labels: {
      // Seed entity = grade 0 (it's not a "similar wine" to itself).
      // Actual similar wines get grade 2-3.
      relevant: [
        { entity_id: cid(rec), grade: 0 },
        ...similarWines,
      ],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'similar_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:similar_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioG: QueryGen = (rec, all, idx, cid) => {
  // Catalog browse (producer wines)
  const lang = assignLanguage(idx);
  const query = lang === 'en'
    ? `${rec.producer} best wines`
    : `${rec.producer} 대표 와인`;
  const producerWines = all
    .filter((r) => r.producer.toLowerCase() === rec.producer.toLowerCase())
    .slice(0, 5)
    .map((r): RelevanceJudgment => ({
      entity_id: cid(r),
      grade: r.popularityScore > 0.5 ? 3 : 2,
    }));

  if (producerWines.length < 2) return null; // need at least 2 wines for browse

  return {
    qid: makeQid('G', idx),
    query,
    query_class: 'catalog_browse',
    scenario: 'G',
    language: lang,
    retrieval_labels: { relevant: producerWines },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'catalog_browse_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:catalog_browse_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const scenarioH: QueryGen = (rec, _all, idx, cid) => {
  // Noisy / typo query
  const lang = assignLanguage(idx);
  const folded = removeAccents(rec.canonicalLabel).toLowerCase();
  const vintage = rec.vintageYear
    ? ` ${String(rec.vintageYear).slice(2)}`
    : '';
  const query = `${folded}${vintage}`;
  return {
    qid: makeQid('H', idx),
    query,
    query_class: 'noisy_recall',
    scenario: 'H',
    language: lang,
    retrieval_labels: {
      relevant: [{ entity_id: cid(rec), grade: 3 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: cid(rec),
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: cid(rec),
      query_template_id: 'noisy_recall_v1',
      generation_run_id: RUN_ID,
      alias_cluster_id: aliasCluster(rec),
    },
    annotation_tier: 'bronze',
    annotated_by: ['rule:noisy_recall_v1'],
    release_gate_eligible: false,
    created_at: new Date().toISOString(),
  };
};

const GENERATORS: Record<Scenario, QueryGen> = {
  A: scenarioA,
  B: scenarioB,
  C: scenarioC,
  D: scenarioD,
  E: scenarioE,
  F: scenarioF,
  G: scenarioG,
  H: scenarioH,
  no_match: (_rec, _all, _idx, _cid) => null, // handled separately below
};

// ---------------------------------------------------------------------------
// No-match query generation
// ---------------------------------------------------------------------------

function generateNoMatchQueries(count: number): GoldenQuery[] {
  const queries: GoldenQuery[] = [];
  const fictitious = [
    'Château Fantaisie 2025',
    'Domaine Invisible Grand Cru',
    'Silver Phoenix Napa Reserve 2022',
    'Bodega Fantasma Rioja Especial',
    'Weingut Traumberg Spätlese 2023',
    '환상의 와이너리 그랑크뤼',
    'Fictitious Estates Merlot Premium NV',
    'Vignoble Mirage Saint-Émilion 2020',
    'Tenuta Ombra Barolo Riserva 2019',
    'asdfgh winery zxcvbn 2024',
    'ㄱㄴㄷ 와이너리 스페셜',
    'Domaine du Vent Imaginaire Côtes du Rhône',
    'Quantum Valley Vineyards Shiraz 2021',
    'Château du Rêve Pauillac 2018',
    'Monte Segreto Brunello di Montalcino',
    'Clos de la Lune Champagne Rosé NV',
    'Villa Miraggio Amarone della Valpolicella',
    'Hacienda Espejismo Tempranillo Reserva',
    'Schloss Geistreich Riesling Auslese',
    'Bodegas Silencio Ribera del Duero',
    '꿈의 보르도 프리미엄 레드',
    'Cape Phantom Stellenbosch Pinotage',
    'Leeuwin Illusion Margaret River Chardonnay',
    'Viña Espectro Maipo Valley Carmenere',
    'Estate of Echoes Willamette Pinot Noir',
    'Douro Dreams Vintage Port Reserve',
    'Azienda Agricola Fantasma Chianti Classico',
    'Podere Immaginario Toscana IGT',
    'Château Nulle Part Margaux 2019',
    'Opus Zero Napa Valley Cabernet 2023',
    'Cloudy Dreams Marlborough Sauvignon Blanc',
    'Granja Encantada Mendoza Malbec',
    'Domain Onirique Burgundy Pinot Noir',
    'Fattoria del Sogno Vino Nobile di Montepulciano',
    'Weingut Phantasie Mosel Kabinett',
    'Cuvée Chimère Languedoc Rosé',
    'Rancho Misterioso Baja California Nebbiolo',
    'Château Mirage Pessac-Léognan Blanc',
    'Tenuta Arcobaleno Etna Rosso',
    'Quinta da Miragem Douro Red',
  ];

  for (let i = 0; i < Math.min(count, fictitious.length); i++) {
    const name = fictitious[i]!;
    const lang = name.match(/[가-힣]/) ? 'ko' : 'en';
    queries.push({
      qid: makeQid('no_match', i),
      query: name,
      query_class: 'no_match',
      scenario: 'no_match',
      language: lang as 'en' | 'ko',
      retrieval_labels: { relevant: [] },
      decision_labels: {
        expected_decision_status: 'failed',
        ambiguity_expected: false,
        requires_abstain: true,
      },
      leakage_keys: {
        entity_id: `no-match-${i}`,
        query_template_id: 'no_match_fictitious_v1',
        generation_run_id: RUN_ID,
        alias_cluster_id: 'no-match',
      },
      annotation_tier: 'bronze',
      annotated_by: ['rule:no_match_v1'],
      release_gate_eligible: false,
      created_at: new Date().toISOString(),
    });
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading enriched Silver from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records } = parseNdjson<EnrichedSilverRecord>(content, args.input);
  console.log(`  Loaded ${records.length} records`);

  const goldLookup = await loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepo });
  const sourceToCanonical = buildEntityIdBySourceId(records, goldLookup);
  const canonicalEntityId: CanonicalEntityIdOf = (r) => {
    const id = sourceToCanonical.get(r.sourceId);
    if (id === undefined) {
      throw new Error(`Missing canonical entity id mapping for sourceId=${r.sourceId}`);
    }
    return id;
  };

  // Shuffle records for random sampling
  const shuffled = [...records].sort(
    () => crypto.randomBytes(4).readUInt32LE(0) / 0xffffffff - 0.5,
  );

  const allQueries: GoldenQuery[] = [];

  for (const [scenario, target] of Object.entries(SCENARIO_TARGETS) as [Scenario, { count: number; queryClass: GoldenQueryClass }][]) {
    if (scenario === 'no_match') {
      allQueries.push(...generateNoMatchQueries(target.count));
      continue;
    }

    const gen = GENERATORS[scenario];
    let generated = 0;
    let attempted = 0;

    for (const rec of shuffled) {
      if (generated >= target.count) break;
      attempted++;
      const q = gen(rec, records, generated, canonicalEntityId);
      if (q) {
        allQueries.push(q);
        generated++;
      }
    }

    console.log(`  Scenario ${scenario}: ${generated}/${target.count} generated (${attempted} attempted)`);
  }

  // Write output
  const lines = allQueries.map((q) => JSON.stringify(q)).join('\n');
  await fs.writeFile(args.output, lines + '\n', 'utf8');

  // Summary
  const byScenario = new Map<string, number>();
  for (const q of allQueries) {
    byScenario.set(q.scenario, (byScenario.get(q.scenario) ?? 0) + 1);
  }
  console.log(`\n  Total queries: ${allQueries.length}`);
  for (const [s, c] of byScenario) {
    console.log(`    ${s}: ${c}`);
  }
  console.log(`  Written to: ${args.output}`);
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
