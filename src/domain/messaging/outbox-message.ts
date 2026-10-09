import type { IntegrationEvent } from "../events/integration-event";
import { type BackoffPolicy, nextAttemptAt } from "../shared/backoff";
import { InvariantViolationError } from "../shared/domain-error";

/** Publicacao com falha: 1s, 2s, 4s ... ate 1 min entre tentativas, sem limite (evento confirmado nao se perde). */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

/**
 * Evento gravado na mesma transacao do efeito financeiro e publicado depois
 * por um worker. `id` = eventId do envelope, para o consumidor deduplicar.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...envelope }) as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt === undefined ? undefined : new Date(state.nextAttemptAt),
      state.publishedAt === undefined ? undefined : new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`evento ${this.id} ja publicado`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a proxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date, policy: BackoffPolicy = OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`evento ${this.id} ja publicado; nao ha retry`);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
  }
}
