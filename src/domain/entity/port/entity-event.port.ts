import type { DomainEvent } from '../../shared/event/domain-event.js';
import type { EntityId } from '../../shared/types/index.js';
import type { EntityType } from '../model/entity-type.js';

/**
 * Event emitted when two entities are merged into one.
 */
export interface EntityMergedEvent extends DomainEvent {
  readonly eventType: 'entity.merged';
  readonly payload: {
    readonly sourceId: EntityId;
    readonly targetId: EntityId;
    readonly survivorId: EntityId;
    readonly entityType: EntityType;
    readonly reason: string;
  };
}

/**
 * Event emitted when an entity is split into multiple entities.
 */
export interface EntitySplitEvent extends DomainEvent {
  readonly eventType: 'entity.split';
  readonly payload: {
    readonly originalId: EntityId;
    readonly resultIds: readonly EntityId[];
    readonly entityType: EntityType;
    readonly reason: string;
  };
}

/**
 * Event emitted when a new entity is created.
 */
export interface EntityCreatedEvent extends DomainEvent {
  readonly eventType: 'entity.created';
  readonly payload: {
    readonly entityId: EntityId;
    readonly entityType: EntityType;
    readonly canonicalLabel: string;
    readonly identitySignature: string;
  };
}

/**
 * Port for publishing entity lifecycle events.
 * Implementations may write to a message bus, event store, or log.
 */
export interface EntityEventPort {
  /** Emit an event indicating two entities were merged. */
  emitMerged(event: EntityMergedEvent): Promise<void>;

  /** Emit an event indicating an entity was split. */
  emitSplit(event: EntitySplitEvent): Promise<void>;

  /** Emit an event indicating a new entity was created. */
  emitCreated(event: EntityCreatedEvent): Promise<void>;
}
