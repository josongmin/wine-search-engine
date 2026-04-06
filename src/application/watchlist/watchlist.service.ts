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

export interface WatchlistOwnershipQuery {
  readonly watchlistId: string;
  readonly userId: string;
}

export interface WatchlistServicePort {
  create(command: CreateWatchlistCommand): Promise<WatchlistEntry>;
  getByIdForUser(query: WatchlistOwnershipQuery): Promise<WatchlistEntry | null>;
  listByUserId(userId: string): Promise<readonly WatchlistEntry[]>;
  listByEntityId(entityId: string): Promise<readonly WatchlistEntry[]>;
  deleteForUser(query: WatchlistOwnershipQuery): Promise<boolean>;
  listDeliveries(
    query: WatchlistOwnershipQuery,
  ): Promise<readonly WatchlistDeliveryLogEntry[] | null>;
  recordDeliveryLog(command: RecordWatchlistDeliveryLogCommand): Promise<boolean>;
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

  async getByIdForUser(query: WatchlistOwnershipQuery): Promise<WatchlistEntry | null> {
    return this.findOwnedEntry(query);
  }

  async listByUserId(userId: string): Promise<readonly WatchlistEntry[]> {
    return this.storage.findByUserId(userId);
  }

  async listByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    return this.storage.findByEntityId(entityId);
  }

  async deleteForUser(query: WatchlistOwnershipQuery): Promise<boolean> {
    const entry = await this.findOwnedEntry(query);
    if (entry === null) {
      return false;
    }

    return this.storage.delete(entry.id);
  }

  async listDeliveries(
    query: WatchlistOwnershipQuery,
  ): Promise<readonly WatchlistDeliveryLogEntry[] | null> {
    const entry = await this.findOwnedEntry(query);
    if (entry === null) {
      return null;
    }

    return this.storage.listByWatchlistId(query.watchlistId);
  }

  async recordDeliveryLog(command: RecordWatchlistDeliveryLogCommand): Promise<boolean> {
    const entry = await this.storage.findById(command.watchlistId);
    if (entry === null) {
      return false;
    }

    const log: WatchlistDeliveryLogEntry = {
      id: this.idGenerator(),
      watchlistId: command.watchlistId,
      attempt: command.attempt,
      statusCode: command.statusCode,
      errorMessage: command.errorMessage,
      deliveredAt: command.deliveredAt ?? new Date(),
    };

    await this.storage.append(log);
    return true;
  }

  private async findOwnedEntry(
    query: WatchlistOwnershipQuery,
  ): Promise<WatchlistEntry | null> {
    const entry = await this.storage.findById(query.watchlistId);
    if (entry === null || entry.userId !== query.userId) {
      return null;
    }

    return entry;
  }
}
