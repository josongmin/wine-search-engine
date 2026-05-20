import fs from 'node:fs/promises';
import { z } from 'zod';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import {
  LAMBDAMART_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
} from '../../domain/ranking/service/lambdamart-ranker.js';
const MAX_INVALID_ENTRY_INDICES_TO_LOG = 8;

const MAX_LTR_MODELS_FROM_FILE = 128;

const NumberArrayOfFiniteLengthSchema = z.array(z.number().finite());

const RuntimeLtrModelEntrySchema = z.object({
  queryClass: z.string().min(1),
  weights: NumberArrayOfFiniteLengthSchema,
  bias: z.number().finite(),
  featureSchemaHash: z.string().min(1),
  trainingExampleCount: z.number().int().nonnegative(),
  ndcg5ValidationScore: z.number().finite(),
  trainedAt: z.union([
    z.date(),
    z.number(),
    z.string().datetime(),
    z.string(),
  ]),
});

interface RuntimeLtrModelArtifact {
  readonly models?: readonly unknown[];
  readonly entries?: readonly unknown[];
  readonly queryClassModels?: Readonly<Record<string, unknown>>;
  readonly version?: string;
}

interface RuntimeLtrModelEntrySource {
  readonly raw: unknown;
  readonly index: number;
}

function parseTrainedAt(raw: unknown): Date | undefined {
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw : undefined;
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  if (typeof raw === 'string') {
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  return undefined;
}

function mapToModel(entry: unknown): QueryClassWeights | undefined {
  const parsed = RuntimeLtrModelEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return undefined;
  }

  const trainedAt = parseTrainedAt(parsed.data.trainedAt);
  if (trainedAt === undefined) {
    return undefined;
  }

  if (parsed.data.weights.length !== LAMBDAMART_FEATURE_DIMENSION) {
    return undefined;
  }

  if (parsed.data.featureSchemaHash !== LTR_FEATURE_SCHEMA_HASH) {
    return undefined;
  }

  return {
    queryClass: parsed.data.queryClass,
    featureSchemaHash: parsed.data.featureSchemaHash,
    weights: parsed.data.weights,
    bias: parsed.data.bias,
    trainingExampleCount: parsed.data.trainingExampleCount,
    ndcg5ValidationScore: parsed.data.ndcg5ValidationScore,
    trainedAt,
  };
}

function extractModelEntries(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const root = parsed as RuntimeLtrModelArtifact;

  if (Array.isArray(root.models)) {
    return root.models;
  }

  if (Array.isArray(root.entries)) {
    return root.entries;
  }

  if (root.queryClassModels !== undefined) {
    return Object.entries(root.queryClassModels).map(([queryClass, model]) =>
      typeof model === 'object' && model !== null ? { ...model, queryClass } : model,
    );
  }

  return [];
}

function parseModelEntries(parsed: unknown): readonly RuntimeLtrModelEntrySource[] {
  const entries = extractModelEntries(parsed);
  return entries.map((raw, index) => ({ raw, index }));
}

export async function loadRuntimeLtrModels(filePath: string): Promise<ReadonlyMap<string, QueryClassWeights> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    bootstrapLogger.warn(
      { filePath, err },
      '[Container] Runtime LTR model file unavailable; skipping local LTR bootstrap',
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    bootstrapLogger.warn(
      { filePath, err },
      '[Container] Runtime LTR model file contains invalid JSON; skipping local LTR bootstrap',
    );
    return undefined;
  }

  const parsedEntries = parseModelEntries(parsed).slice(0, MAX_LTR_MODELS_FROM_FILE);
  const invalidEntries: number[] = [];
  const modelEntries = [];
  for (const { raw: entry, index } of parsedEntries) {
    const mapped = mapToModel(entry);
    if (mapped === undefined) {
      invalidEntries.push(index);
      continue;
    }
    modelEntries.push(mapped);
  }

  if (invalidEntries.length > 0) {
    bootstrapLogger.warn(
      { filePath, invalidCount: invalidEntries.length, firstInvalidIndices: invalidEntries.slice(0, MAX_INVALID_ENTRY_INDICES_TO_LOG) },
      '[Container] Runtime LTR model file skipped invalid entries',
    );
  }

  if (modelEntries.length === 0) {
    bootstrapLogger.warn(
      { filePath, recordCount: parsedEntries.length },
      '[Container] Runtime LTR model file loaded but no valid model entries were found',
    );
    return undefined;
  }

  const map = new Map<string, QueryClassWeights>();
  for (const model of modelEntries) {
    if (map.has(model.queryClass)) {
      bootstrapLogger.warn(
        { filePath, queryClass: model.queryClass },
        '[Container] Runtime LTR model file has duplicate queryClass; keeping first entry',
      );
      continue;
    }
    map.set(model.queryClass, model);
  }

  bootstrapLogger.info(
    {
      filePath,
      modelCount: map.size,
    },
    '[Container] Loaded runtime LTR models from local artifact',
  );

  return map;
}
