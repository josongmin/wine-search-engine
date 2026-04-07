import { Anthropic } from '@anthropic-ai/sdk';
import type { PairingTag } from '../../src/domain/query/service/pairing-extractor.js';
import { PAIRING_TAXONOMY } from '../../src/domain/query/service/pairing-extractor.js';

/**
 * Step 12.3, Stage 1: Food Pairing Taxonomy Normalization
 *
 * Normalizes and expands food pairing tags at index time.
 * Input: Vivino's `food_pairings` array + tasting notes
 * Output: Standardized pairing tags from PAIRING_TAXONOMY
 *
 * RFC: v0.2 Epic 12, Step 12.3
 */

export interface WineForPairing {
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly foodPairings?: readonly string[];
}

export interface PairingNormalizationResult {
  readonly tags: PairingTag[];
  readonly source: 'vivino_plus_notes' | 'notes_only' | 'vivino_only';
  readonly confidence: 'high' | 'medium' | 'low';
}

const PAIRING_NORMALIZATION_PROMPT = `
Given a wine and its Vivino food pairings list, normalize them to a standard taxonomy.

Wine: {canonicalLabel}
Tasting notes excerpt: {searchTextEn}
Vivino pairings: {foodPairings}

Standard taxonomy (choose only from these):
${PAIRING_TAXONOMY.join(', ')}

Output ONLY a valid JSON object (no markdown):
{
  "tags": ["tag1", "tag2"],
  "source": "vivino_plus_notes|notes_only|vivino_only",
  "confidence": "high|medium|low"
}

Rules:
- Map Vivino names to standard tags (e.g. "red meat" → "beef", "fish" → "white_fish")
- Infer from tasting notes if Vivino pairing is empty
- If wine is sweet/dessert style, include "dessert" tag
- Confidence high: 2+ consistent sources; medium: 1 source; low: inferred only
`;

/**
 * Normalizes food pairings for a single wine using Claude.
 */
export async function normalizePairings(
  wine: WineForPairing,
  client: Anthropic,
): Promise<PairingNormalizationResult> {
  const prompt = PAIRING_NORMALIZATION_PROMPT.replace(
    '{canonicalLabel}',
    wine.canonicalLabel,
  )
    .replace('{searchTextEn}', wine.searchTextEn.substring(0, 300))
    .replace(
      '{foodPairings}',
      wine.foodPairings?.join(', ') ?? '(none provided)',
    );

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Non-greedy match: extract the first complete JSON object
  const jsonMatch = textContent.text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from response: ${textContent.text}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    tags: parsed.tags as PairingTag[],
    source: parsed.source,
    confidence: parsed.confidence,
  };
}

/**
 * Batch normalize pairings with rate limiting.
 */
export async function normalizePairingsBatch(
  wines: WineForPairing[],
  client: Anthropic,
  batchSize: number = 10,
): Promise<Map<string, PairingNormalizationResult>> {
  const results = new Map<string, PairingNormalizationResult>();

  for (let i = 0; i < wines.length; i += batchSize) {
    const batch = wines.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (wine) => {
        try {
          const normalized = await normalizePairings(wine, client);
          results.set(wine.canonicalLabel, normalized);
        } catch (error) {
          console.error(`Failed to normalize pairings for ${wine.canonicalLabel}:`, error);
        }
      }),
    );

    // Slight delay between batches
    if (i + batchSize < wines.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}
