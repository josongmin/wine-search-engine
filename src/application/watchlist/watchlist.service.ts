import { randomUUID } from 'node:crypto';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
  WatchlistTrigger,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistStoragePort,
} from '../../domain/watchlist/port/watchlist-repository.port.js';

export interface CreateWatchlistCommand {
  readonly userId: string;
  readonly entityId: string;
  readonly triggerConditions: readonly WatchlistTrigger[];
  readonly callbackUrl: string;
  readonly expiresAt: Date | null;
}

export interface RecordWatchlistDeliveryLogCommand {
  readonly watchlistId: string;
  readonly attempt: number;
  readonly statusCode: number | null;
  readonly errorMessage: string | null;
  readonly deliveredAt?: Date;
}

export interface WatchlistServicePort {
  create(command: CreateWatchlistCommand): Promise<WatchlistEntry>;
  getById(id: string): Promise<WatchlistEntry | null>;
  listByEntityId(entityId: string): Promise<readonly WatchlistEntry[]>;
  delete(id: string): Promise<boolean>;
  listDeliveries(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[] | null>;
  recordDeliveryLog(command: RecordWatchlistDeliveryLogCommand): Promise<void>;
  clear(): Promise<void>;
}

interface WatchlistServiceDeps {
  readonly storage: WatchlistStoragePort;
  readonly idGenerator?: () => string;
}

export class WatchlistService implements WatchlistServicePort {
  private readonly storage: WatchlistStoragePort;
  private readonly idGenerator: () => string;

  constructor(deps: WatchlistServiceDeps) {
    this.storage = deps.storage;
    this.idGenerator = deps.idGenerator ?? randomUUID;
  }

  async create(command: CreateWatchlistCommand): Promise<WatchlistEntry> {
    const entry: WatchlistEntry = {
      id: this.idGenerator(),
      userId: command.userId,
      entityId: command.entityId,
      triggerConditions: command.triggerConditions,
      callbackUrl: command.callbackUrl,
      createdAt: new Date(),
      expiresAt: command.expiresAt,
    };

    await this.storage.save(entry);
    return entry;
  }

  async getById(id: string): Promise<WatchlistEntry | null> {
    return this.storage.findById(id);
  }

  async listByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    return this.storage.findByEntityId(entityId);
  }

  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  async listDeliveries(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[] | null> {
    const entry = await this.storage.findById(watchlistId);
    if (entry === null) {
      return null;
    }

    return this.storage.listByWatchlistId(watchlistId);
  }

  async recordDeliveryLog(command: RecordWatchlistDeliveryLogCommand): Promise<void> {
    const log: WatchlistDeliveryLogEntry = {
      id: this.idGenerator(),
      watchlistId: command.watchlistId,
      attempt: command.attempt,
      statusCode: command.statusCode,
      errorMessage: command.errorMessage,
      deliveredAt: command.deliveredAt ?? new Date(),
    };

    await this.storage.append(log);
  }

  async clear(): Promise<void> {
    await this.storage.clear();
  }
}
