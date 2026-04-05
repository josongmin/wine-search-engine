/**
 * Step 12.2: Organic/Biodynamic Certification Enrichment
 *
 * Enriches wine records with organic/biodynamic certification flags using:
 * 1. Wikidata SPARQL (structured open data, free/CC0)
 * 2. LLM inference fallback (when Wikidata misses)
 *
 * RFC: v0.2 Epic 12 (Data Enrichment)
 */

/**
 * Certification enrichment result
 */
export interface CertificationEnrichment {
  readonly entityId: string;
  readonly organic: boolean;
  readonly biodynamic: boolean;
  readonly vegan: boolean;
  readonly naturalWine: boolean;
  readonly certificationSource: 'wikidata' | 'llm_inferred' | 'none';
  readonly certificationConfidence: 'verified' | 'probable' | 'low';
}

/**
 * Query Wikidata SPARQL endpoint for producer certification info.
 * Free, open data (CC0 licensed).
 *
 * Query: Find wineries with certification information
 *
 * ?producer = producer name
 * wdt:P31 wd:Q156362 = instance of winery
 * wdt:P6868 = certified by
 */
export async function queryWikidataCertification(
  producerName: string,
): Promise<{
  organic: boolean;
  biodynamic: boolean;
  source: 'wikidata' | 'none';
}> {
  // Wikidata SPARQL endpoint
  const endpoint = 'https://query.wikidata.org/sparql';

  const sparql = `
    SELECT ?cert ?certLabel WHERE {
      ?producer wdt:P31 wd:Q156362 .
      ?producer rdfs:label "${producerName}"@en .
      ?producer wdt:P6868 ?cert .
      ?cert rdfs:label ?certLabel .
      FILTER(LANG(?certLabel) = "en")
    }
    LIMIT 10
  `;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({ query: sparql }).toString(),
    });

    if (!response.ok) {
      return { organic: false, biodynamic: false, source: 'none' };
    }

    const data = (await response.json()) as {
      results?: {
        bindings?: Array<{
          certLabel?: {
            value?: string;
          };
        }>;
      };
    };

    const certLabels = (data.results?.bindings ?? [])
      .map((b) => b.certLabel?.value?.toLowerCase() ?? '')
      .join(' ');

    const organic = /organic|organisch|biologique/.test(certLabels);
    const biodynamic = /biodynamic|biodynam|demeter|biodyvin/.test(certLabels);

    return {
      organic,
      biodynamic,
      source: certLabels ? 'wikidata' : 'none',
    };
  } catch (error) {
    console.error(`Wikidata query failed for ${producerName}:`, error);
    return { organic: false, biodynamic: false, source: 'none' };
  }
}

/**
 * Infer certification from tasting notes using simple keyword matching.
 * Fallback for when Wikidata misses a producer.
 */
export function inferCertificationFromNotes(
  tastingNotes: string,
): {
  organic: boolean;
  biodynamic: boolean;
  vegan: boolean;
  naturalWine: boolean;
} {
  const notes = tastingNotes.toLowerCase();

  return {
    organic: /\borganic\b|\borganisch\b|\bbiologique\b|\b유기농\b/.test(notes),
    biodynamic:
      /\bbiodynamic\b|\bbiodynam\b|\bdemeter\b|\bbiodyvin\b|\b생동력농법\b/.test(
        notes,
      ),
    vegan: /\bvegan\b|\bveganfriendly\b|\bno animal products\b|\b비건\b/.test(
      notes,
    ),
    naturalWine:
      /\bnatural wine\b|\bnatural ferment\b|\bminimal intervention\b|\bno[\s-]?added\b|\bnatural|\b자연와인\b/.test(
        notes,
      ),
  };
}

/**
 * Enrich a single wine record with certification data.
 */
export async function enrichWineCertifications(
  entityId: string,
  producerName: string,
  tastingNotes: string,
): Promise<CertificationEnrichment> {
  // Step 1: Try Wikidata
  const wikidata = await queryWikidataCertification(producerName);

  if (wikidata.source === 'wikidata') {
    return {
      entityId,
      organic: wikidata.organic,
      biodynamic: wikidata.biodynamic,
      vegan: false, // Not available from Wikidata
      naturalWine: false, // Not available from Wikidata
      certificationSource: 'wikidata',
      certificationConfidence: 'verified',
    };
  }

  // Step 2: Fallback to LLM inference from notes
  const inferred = inferCertificationFromNotes(tastingNotes);

  if (
    inferred.organic ||
    inferred.biodynamic ||
    inferred.vegan ||
    inferred.naturalWine
  ) {
    return {
      entityId,
      organic: inferred.organic,
      biodynamic: inferred.biodynamic,
      vegan: inferred.vegan,
      naturalWine: inferred.naturalWine,
      certificationSource: 'llm_inferred',
      certificationConfidence: 'probable',
    };
  }

  // Step 3: No data found
  return {
    entityId,
    organic: false,
    biodynamic: false,
    vegan: false,
    naturalWine: false,
    certificationSource: 'none',
    certificationConfidence: 'low',
  };
}

/**
 * Batch enrich wine records for certifications.
 */
export async function enrichWineCertificationsBatch(
  wines: Array<{
    readonly entityId: string;
    readonly producer: string;
    readonly searchTextEn: string;
  }>,
  batchSize: number = 10,
): Promise<Map<string, CertificationEnrichment>> {
  const results = new Map<string, CertificationEnrichment>();

  for (let i = 0; i < wines.length; i += batchSize) {
    const batch = wines.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (wine) => {
        try {
          const enriched = await enrichWineCertifications(
            wine.entityId,
            wine.producer,
            wine.searchTextEn,
          );
          results.set(wine.entityId, enriched);
        } catch (error) {
          console.error(`Failed to enrich ${wine.entityId}:`, error);
        }
      }),
    );

    // Slight delay between batches to respect Wikidata rate limits
    if (i + batchSize < wines.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}
