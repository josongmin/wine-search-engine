/**
 * ModelRegistryPort — lifecycle port for trained LTR model artifacts.
 *
 * The retrain orchestrator `register()`s a freshly-trained artifact as a
 * 'shadow' entry, then `activate()`s it once offline metrics clear the
 * promotion bar. Auto-rollback calls `rollback()` which demotes the
 * current active entry to 'rolled_back' and re-activates the most recent
 * prior active artifact, if any.
 */

import type { ModelArtifact, ModelRegistryEntry } from '../model/model-registry-entry.js';

export interface ModelRegistryPort {
  /** Register a new model artifact (does not activate it). */
  register(artifact: ModelArtifact): Promise<void>;

  /** Promote a registered model from shadow to active. */
  activate(modelId: string, version: string): Promise<void>;

  /** Roll back to a previous active model. */
  rollback(reason: string): Promise<void>;

  /** Get the currently active model. */
  getActive(): Promise<ModelRegistryEntry | null>;

  /** List all registered models (newest first). */
  list(): Promise<readonly ModelRegistryEntry[]>;
}
