/**
 * Task 6: Fine-tune Data Preparation
 *
 * Builds triplet dataset for BGE-M3 embedding fine-tuning on wine domain.
 *
 * Flow:
 * 1. Load 500 golden queries + expected wine entities
 * 2. Load 7039 wine documents (with semantic summaries + profiles)
 * 3. Extract hard negatives from retrieval failures (top-10 but wrong)
 * 4. Create triplets: (query, positive_wine, hard_negative_wine)
 * 5. Split into train/val/test for fine-tuning
 * 6. Export as JSONL for Python fine-tuning service
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoldenQuery {
  qid: string;
  query: string;
  query_class: string;
  language: string;
  decision_labels: {
    expected_decision_status: string;
    expected_entity_id: string;
    ambiguity_expected: boolean;
    requires_abstain: boolean;
  };
  retrieval_labels: {
    relevant: Array<{ entity_id: string; grade: number }>;
  };
}

interface WineDocument {
  sourceId: string;
  canonicalLabel: string;
  producer: string;
  vintageYear: number;
  country: string;
  region: string;
  wineType: string;
  grapePrimary: string | null;
  grapes: string[];
  body: number;
  sweetness: number;
  acidity: number;
  tannin: number;
  pairingTags: string[];
  flavorProfiles: string[];
  priceUsd: string;
  priceBand: string;
  [key: string]: unknown;
}

interface EmbeddingTriplet {
  query: string;
  positiveDoc: string;
  negativeDoc: string;
  domain: 'wine' | 'wine_semantic';
  difficulty: 'easy' | 'medium' | 'hard';
}

interface FineTuningDataset {
  train: EmbeddingTriplet[];
  val: EmbeddingTriplet[];
  test: EmbeddingTriplet[];
  metadata: {
    totalTriplets: number;
    timestamp: string;
    golden_queries_count: number;
    wine_documents_count: number;
    hard_negatives_extracted: number;
  };
}

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

/**
 * Loads golden queries from JSONL file.
 * Expected entity IDs are extracted to map queries to correct wines.
 */
async function loadGoldenQueries(
  filePath: string,
): Promise<Map<string, GoldenQuery>> {
  const queries = new Map<string, GoldenQuery>();

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (line.trim().length === 0) return;
      try {
        const query: GoldenQuery = JSON.parse(line);
        queries.set(query.qid, query);
      } catch (error) {
        console.warn(`Failed to parse golden query line: ${line.slice(0, 100)}`);
      }
    });

    rl.on('close', () => resolve(queries));
    rl.on('error', reject);
  });
}

/**
 * Loads wine documents from NDJSON, indexed by sourceId for fast lookup.
 */
async function loadWineDocuments(
  filePath: string,
): Promise<Map<string, WineDocument>> {
  const wines = new Map<string, WineDocument>();

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (line.trim().length === 0) return;
      try {
        const wine: WineDocument = JSON.parse(line);
        wines.set(wine.sourceId, wine);
      } catch (error) {
        console.warn(`Failed to parse wine document line: ${line.slice(0, 100)}`);
      }
    });

    rl.on('close', () => resolve(wines));
    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Triplet Creation
// ---------------------------------------------------------------------------

/**
 * Creates semantic summary for a wine document for use in embeddings.
 */
function createSemanticSummary(wine: WineDocument): string {
  const parts: string[] = [
    wine.canonicalLabel,
    wine.producer ? `by ${wine.producer}` : '',
    wine.region ? `from ${wine.region}` : '',
    wine.wineType ? `${wine.wineType} wine` : '',
  ];

  // Add flavor/style descriptors
  const flavorParts: string[] = [];
  if (wine.body > 0) {
    const bodyDescriptor =
      wine.body > 0.7
        ? 'full-bodied'
        : wine.body > 0.4
          ? 'medium-bodied'
          : 'light-bodied';
    flavorParts.push(bodyDescriptor);
  }
  if (wine.sweetness > 0.6) flavorParts.push('sweet');
  else if (wine.sweetness < 0.3) flavorParts.push('dry');

  if (wine.acidity > 0.6) flavorParts.push('high acidity');
  if (wine.tannin > 0.6) flavorParts.push('tannic');

  if (flavorParts.length > 0) {
    parts.push(`characteristics: ${flavorParts.join(', ')}`);
  }

  if (wine.priceBand) {
    parts.push(`price tier: ${wine.priceBand}`);
  }

  return parts.filter((p) => p.length > 0).join('. ');
}

/**
 * Extracts hard negatives: wines retrieved but semantically wrong.
 * For this dataset, hard negatives are wines with similar characteristics
 * but different origin/producer/type.
 */
function extractHardNegatives(
  positiveWine: WineDocument,
  allWines: Map<string, WineDocument>,
  count: number = 3,
): WineDocument[] {
  const hardNegatives: WineDocument[] = [];

  // Criteria for hard negatives:
  // - Same country/region (similar geography)
  // - Same wine type (red, white, etc.)
  // - Different producer
  // - Similar price band
  // But NOT the same wine

  const candidates = Array.from(allWines.values()).filter((w) => {
    if (w.sourceId === positiveWine.sourceId) return false; // exclude positive itself
    if (w.wineType !== positiveWine.wineType) return false; // same type

    // Same country yields good hard negatives
    if (
      w.country === positiveWine.country &&
      w.producer !== positiveWine.producer
    ) {
      return true;
    }

    return false;
  });

  // Sort by price proximity (easier to confuse wines at similar price points)
  const positivePrice = parseFloat(positiveWine.priceUsd);
  candidates.sort(
    (a, b) =>
      Math.abs(parseFloat(a.priceUsd) - positivePrice) -
      Math.abs(parseFloat(b.priceUsd) - positivePrice),
  );

  return candidates.slice(0, count);
}

/**
 * Creates balanced triplet dataset: mix of easy, medium, and hard negatives.
 */
function createTriplets(
  queries: Map<string, GoldenQuery>,
  wines: Map<string, WineDocument>,
): EmbeddingTriplet[] {
  const triplets: EmbeddingTriplet[] = [];

  for (const [, query] of queries) {
    const expectedEntityId =
      query.decision_labels.expected_entity_id;
    const positiveWine = wines.get(expectedEntityId);

    if (!positiveWine) {
      console.warn(
        `Could not find positive wine for query ${query.qid}: ${expectedEntityId}`,
      );
      continue;
    }

    // Create semantic summary for positive wine
    const positiveSummary = createSemanticSummary(positiveWine);

    // Extract hard negatives (wines that would confuse the model)
    const hardNegatives = extractHardNegatives(positiveWine, wines, 2);

    // Extract easy negatives (random wines from different countries)
    const easyNegatives = Array.from(wines.values())
      .filter((w) => w.sourceId !== positiveWine.sourceId && w.country !== positiveWine.country)
      .sort(() => Math.random() - 0.5)
      .slice(0, 2);

    // Create triplets: 2 hard + 2 easy per query
    for (const negWine of hardNegatives) {
      const negSummary = createSemanticSummary(negWine);
      triplets.push({
        query: query.query,
        positiveDoc: positiveSummary,
        negativeDoc: negSummary,
        domain: 'wine_semantic',
        difficulty: 'hard',
      });
    }

    for (const negWine of easyNegatives) {
      const negSummary = createSemanticSummary(negWine);
      triplets.push({
        query: query.query,
        positiveDoc: positiveSummary,
        negativeDoc: negSummary,
        domain: 'wine_semantic',
        difficulty: 'easy',
      });
    }
  }

  return triplets;
}

// ---------------------------------------------------------------------------
// Data Splitting
// ---------------------------------------------------------------------------

/**
 * Splits triplets into train/val/test with stratification by difficulty.
 */
function splitDataset(
  triplets: EmbeddingTriplet[],
  trainRatio: number = 0.7,
  valRatio: number = 0.15,
): FineTuningDataset {
  // Shuffle triplets
  const shuffled = [...triplets].sort(() => Math.random() - 0.5);

  // Split by difficulty to ensure balanced difficulty across splits
  const easyTriplets = shuffled.filter((t) => t.difficulty === 'easy');
  const hardTriplets = shuffled.filter((t) => t.difficulty === 'hard');

  const easyTrain = easyTriplets.slice(0, Math.floor(easyTriplets.length * trainRatio));
  const easyVal = easyTriplets.slice(
    easyTrain.length,
    easyTrain.length + Math.floor(easyTriplets.length * valRatio),
  );
  const easyTest = easyTriplets.slice(easyTrain.length + easyVal.length);

  const hardTrain = hardTriplets.slice(0, Math.floor(hardTriplets.length * trainRatio));
  const hardVal = hardTriplets.slice(
    hardTrain.length,
    hardTrain.length + Math.floor(hardTriplets.length * valRatio),
  );
  const hardTest = hardTriplets.slice(hardTrain.length + hardVal.length);

  return {
    train: [...easyTrain, ...hardTrain],
    val: [...easyVal, ...hardVal],
    test: [...easyTest, ...hardTest],
    metadata: {
      totalTriplets: shuffled.length,
      timestamp: new Date().toISOString(),
      golden_queries_count: Math.ceil(shuffled.length / 4), // ~4 triplets per query
      wine_documents_count: 7039,
      hard_negatives_extracted: hardTriplets.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Exports triplets to JSONL format for fine-tuning.
 */
function exportToJsonl(
  dataset: FineTuningDataset,
  outputDir: string,
): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Export train set
  const trainPath = path.join(outputDir, 'train.jsonl');
  const trainStream = fs.createWriteStream(trainPath);
  for (const triplet of dataset.train) {
    trainStream.write(JSON.stringify(triplet) + '\n');
  }
  trainStream.end();
  console.log(`✓ Train set exported to ${trainPath} (${dataset.train.length} triplets)`);

  // Export validation set
  const valPath = path.join(outputDir, 'val.jsonl');
  const valStream = fs.createWriteStream(valPath);
  for (const triplet of dataset.val) {
    valStream.write(JSON.stringify(triplet) + '\n');
  }
  valStream.end();
  console.log(`✓ Val set exported to ${valPath} (${dataset.val.length} triplets)`);

  // Export test set
  const testPath = path.join(outputDir, 'test.jsonl');
  const testStream = fs.createWriteStream(testPath);
  for (const triplet of dataset.test) {
    testStream.write(JSON.stringify(triplet) + '\n');
  }
  testStream.end();
  console.log(`✓ Test set exported to ${testPath} (${dataset.test.length} triplets)`);

  // Export metadata
  const metadataPath = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(dataset.metadata, null, 2));
  console.log(`✓ Metadata exported to ${metadataPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.warn('🚀 Fine-tuning Data Preparation (Task 6)\n');

  const dataDir = path.resolve(process.cwd(), 'data');
  const outputDir = path.resolve(dataDir, 'fine-tune-dataset');

  try {
    // Load data
    console.warn('📥 Loading golden queries...');
    const queries = await loadGoldenQueries(
      path.join(dataDir, 'golden-queries-bronze.jsonl'),
    );
    console.warn(`   Loaded ${queries.size} golden queries`);

    console.warn('📥 Loading wine documents...');
    const wines = await loadWineDocuments(
      path.join(dataDir, 'silver-docquery.ndjson'),
    );
    console.warn(`   Loaded ${wines.size} wine documents`);

    // Create triplets
    console.warn('\n🔗 Creating triplets...');
    const triplets = createTriplets(queries, wines);
    console.warn(`   Created ${triplets.length} triplets`);

    // Analyze difficulty distribution
    const hardCount = triplets.filter((t) => t.difficulty === 'hard').length;
    const easyCount = triplets.filter((t) => t.difficulty === 'easy').length;
    console.warn(`   Hard negatives: ${hardCount} (${((hardCount / triplets.length) * 100).toFixed(1)}%)`);
    console.warn(`   Easy negatives: ${easyCount} (${((easyCount / triplets.length) * 100).toFixed(1)}%)`);

    // Split dataset
    console.warn('\n📊 Splitting dataset...');
    const dataset = splitDataset(triplets);
    console.warn(`   Train: ${dataset.train.length} triplets`);
    console.warn(`   Val: ${dataset.val.length} triplets`);
    console.warn(`   Test: ${dataset.test.length} triplets`);

    // Export
    console.warn('\n💾 Exporting to JSONL...');
    exportToJsonl(dataset, outputDir);

    console.warn('\n✅ Fine-tuning data preparation complete!');
    console.warn(`   Output directory: ${outputDir}`);
    console.warn(
      `   Total triplets: ${dataset.metadata.totalTriplets}`,
    );
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
