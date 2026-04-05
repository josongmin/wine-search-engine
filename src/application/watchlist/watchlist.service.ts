import { randomUUID } from 'node:crypto';
import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
  WatchlistTrigger,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistDeliveryLogRepositoryPort,
  WatchlistRepositoryPort,
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
  readonly watchlistRepository: WatchlistRepositoryPort;
  readonly deliveryLogRepository: WatchlistDeliveryLogRepositoryPort;
  readonly idGenerator?: () => string;
}

export class WatchlistService implements WatchlistServicePort {
  private readonly watchlistRepository: WatchlistRepositoryPort;
  private readonly deliveryLogRepository: WatchlistDeliveryLogRepositoryPort;
  private readonly idGenerator: () => string;

  constructor(deps: WatchlistServiceDeps) {
    this.watchlistRepository = deps.watchlistRepository;
    this.deliveryLogRepository = deps.deliveryLogRepository;
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

    await this.watchlistRepository.save(entry);
    return entry;
  }

  async getById(id: string): Promise<WatchlistEntry | null> {
    return this.watchlistRepository.findById(id);
  }

  async listByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    return this.watchlistRepository.findByEntityId(entityId);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.watchlistRepository.delete(id);
    if (deleted) {
      await this.deliveryLogRepository.deleteByWatchlistId(id);
    }
    return deleted;
  }

  async listDeliveries(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[] | null> {
    const entry = await this.watchlistRepository.findById(watchlistId);
    if (entry === null) {
      return null;
    }

    return this.deliveryLogRepository.listByWatchlistId(watchlistId);
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

    await this.deliveryLogRepository.append(log);
  }

  async clear(): Promise<void> {
    await this.watchlistRepository.clear();
    await this.deliveryLogRepository.clear();
  }
}
