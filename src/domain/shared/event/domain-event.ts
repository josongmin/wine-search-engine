/**
 * Base interface for all domain events emitted within the Wine Intelligence Engine.
 * Domain events represent facts that have occurred in the domain and are immutable
 * once created.
 */
export interface DomainEvent {
  /** Unique identifier for this event instance. */
  readonly eventId: string;

  /** Timestamp when the event occurred. */
  readonly occurredAt: Date;

  /** Discriminator string identifying the event type (e.g. "wine.resolved", "query.classified"). */
  readonly eventType: string;

  /** The event payload containing domain-specific data. */
  readonly payload: Record<string, unknown>;
}
