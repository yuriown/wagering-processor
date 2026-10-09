import { OutboxMessage } from "../domain/messaging/outbox-message";
import type { AppLogger, ClaimedOutboxMessage, Clock, EventPublisher, Metrics, OutboxStore, PublishResult } from "./ports";

export interface PublishOutboxOptions {
  /** Identifica este publicador no lease (instancia + pid). */
  owner: string;
  batchSize: number;
  /** Prazo para publicar o lote; depois disso outro publicador pode assumir. */
  leaseMs: number;
}

/**
 * Relay da outbox. Cada rodada reivindica um lote (SKIP LOCKED + lease), publica
 * e marca. Se o processo morrer no meio, o lease expira e outro publicador
 * assume: nada se perde. O preco e a entrega pelo menos uma vez: um evento pode
 * sair duas vezes, e o consumidor deduplica por eventId.
 */
export class PublishOutbox {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly options: PublishOutboxOptions,
  ) {}

  /** Uma rodada. Devolve quantos eventos foram publicados. */
  async runOnce(): Promise<number> {
    const lag = await this.store.oldestPendingAgeMs(this.clock.now());
    this.metrics.observe("outbox_lag_seconds", lag / 1000);

    const claimed = await this.store.claim(this.options.owner, this.options.batchSize, this.options.leaseMs);
    if (claimed.length === 0) return 0;

    const results = await this.publishSafely(claimed);
    const byId = new Map(results.map((r) => [r.id, r]));
    let published = 0;
    for (const message of claimed) {
      const result = byId.get(message.id) ?? { id: message.id, ok: false, error: "sem resultado do broker" };
      const now = this.clock.now();
      if (result.ok) {
        const mine = await this.store.markPublished(message.id, this.options.owner, now);
        if (!mine) this.metrics.increment("outbox_lease_lost_total");
        published += 1;
        this.metrics.increment("outbox_published_total", { eventType: message.eventType });
        continue;
      }
      // O dominio calcula o backoff; aqui so persiste o resultado.
      const retry = OutboxMessage.rehydrate({ ...message, nextAttemptAt: undefined, publishedAt: undefined });
      retry.scheduleRetry(now);
      await this.store.reschedule(message.id, this.options.owner, retry.attempts, retry.nextAttemptAt ?? now, result.error ?? "erro");
      this.metrics.increment("outbox_publish_failures_total", { eventType: message.eventType });
      this.logger.warn("falha ao publicar evento; nova tentativa agendada", {
        eventId: message.id,
        eventType: message.eventType,
        attempts: retry.attempts,
      });
    }
    return published;
  }

  private async publishSafely(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    try {
      return await this.publisher.publish(messages);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return messages.map((m) => ({ id: m.id, ok: false, error: reason }));
    }
  }
}
