/**
 * In-memory `ModelRegistryPort` implementation for development, tests,
 * and the Phase-5 closed-loop orchestration glue.
 *
 * Rollback semantics: the current 'active' entry is demoted to
 * 'rolled_back' (stamped with the reason + rolledBackAt), and the most
 * recently-activated prior artifact that is NOT in 'rolled_back' state
 * is re-promoted to 'active'. If no prior entry is eligible, the
 * registry ends with no active model.
 *
 * All state lives in-process — production deployments must swap this
 * for a durable registry (Postgres, object store, etc.).
 */

import type { ModelArtifact, ModelRegistryEntry } from '../../domain/learning/model/model-registry-entry.js';
import type { ModelRegistryPort } from '../../domain/learning/port/model-registry.port.js';

interface MutableEntry {
  artifact: ModelArtifact;
  status: 'active' | 'shadow' | 'rolled_back';
  activatedAt?: number;
  rolledBackAt?: number;
  rollbackReason?: string;
  /** Insertion order — used to surface "newest first" in list(). */
  insertionIndex: number;
  /** Wall-clock of most recent activation; used to pick a rollback target. */
  lastActivatedAt?: number;
}

function toImmutable(e: MutableEntry): ModelRegistryEntry {
  return {
    artifact: e.artifact,
    status: e.status,
    ...(e.activatedAt !== undefined ? { activatedAt: e.activatedAt } : {}),
    ...(e.rolledBackAt !== undefined ? { rolledBackAt: e.rolledBackAt } : {}),
    ...(e.rollbackReason !== undefined ? { rollbackReason: e.rollbackReason } : {}),
  };
}

function keyOf(modelId: string, version: string): string {
  return `${modelId}\u0000${version}`;
}

export class InMemoryModelRegistry implements ModelRegistryPort {
  private readonly entries = new Map<string, MutableEntry>();
  private nextInsertionIndex = 0;
  private activationCounter = 0;

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port contract; in-memory has no I/O
  async register(artifact: ModelArtifact): Promise<void> {
    const key = keyOf(artifact.modelId, artifact.version);
    if (this.entries.has(key)) {
      // Idempotent: silently drop duplicate registrations of the same
      // (modelId, version). Re-registration is almost always a retry and
      // clobbering state would erase activation history.
      return;
    }
    this.entries.set(key, {
      artifact,
      status: 'shadow',
      insertionIndex: this.nextInsertionIndex++,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port contract
  async activate(modelId: string, version: string): Promise<void> {
    const key = keyOf(modelId, version);
    const target = this.entries.get(key);
    if (target === undefined) {
      throw new Error(`ModelRegistry.activate: unknown model ${modelId}@${version}`);
    }
    // Demote any currently-active entry to 'shadow' (not 'rolled_back' —
    // rollback is a distinct explicit action).
    for (const e of this.entries.values()) {
      if (e.status === 'active' && e !== target) {
        e.status = 'shadow';
      }
    }
    target.status = 'active';
    target.activatedAt = Date.now();
    // Use a monotonic counter so two activations in the same ms tick
    // retain a well-defined ordering for rollback target selection.
    target.lastActivatedAt = ++this.activationCounter;
    // Clear any stale rollback metadata if this entry is being re-activated.
    delete target.rolledBackAt;
    delete target.rollbackReason;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port contract
  async rollback(reason: string): Promise<void> {
    let activeEntry: MutableEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.status === 'active') {
        activeEntry = e;
        break;
      }
    }
    if (activeEntry === undefined) {
      throw new Error('ModelRegistry.rollback: no active model to roll back');
    }

    activeEntry.status = 'rolled_back';
    activeEntry.rolledBackAt = Date.now();
    activeEntry.rollbackReason = reason;

    // Re-activate the most recently-activated non-rolled-back entry
    // (prefer 'shadow' siblings that were previously active).
    let candidate: MutableEntry | undefined;
    for (const e of this.entries.values()) {
      if (e === activeEntry) continue;
      if (e.status === 'rolled_back') continue;
      if (e.lastActivatedAt === undefined) continue;
      if (candidate === undefined || (e.lastActivatedAt > (candidate.lastActivatedAt ?? -1))) {
        candidate = e;
      }
    }
    if (candidate !== undefined) {
      candidate.status = 'active';
      candidate.lastActivatedAt = ++this.activationCounter;
      candidate.activatedAt = Date.now();
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port contract
  async getActive(): Promise<ModelRegistryEntry | null> {
    for (const e of this.entries.values()) {
      if (e.status === 'active') return toImmutable(e);
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port contract
  async list(): Promise<readonly ModelRegistryEntry[]> {
    const all = Array.from(this.entries.values());
    all.sort((a, b) => b.insertionIndex - a.insertionIndex);
    return all.map(toImmutable);
  }
}
