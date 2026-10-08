import type { MikroORM } from "@mikro-orm/postgresql";
import type {
  ClaimedOutboxMessage,
  DuePendingReference,
  OutboxStore,
  PendingReferenceFinder,
} from "../../application/ports";
import { translateDriverError } from "./mikro-orm-unit-of-work";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

/**
 * Outbox em SQL direto: a reivindicacao precisa de UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED),
 * que nao cabe no Unit of Work. Cada metodo e um comando atomico e curto (autocommit).
 */
export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(owner: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]> {
    // SKIP LOCKED: dois publicadores no mesmo instante pegam lotes disjuntos, sem esperar um pelo outro.
    // locked_until < now(): lease vencido (publicador morreu) volta a ser elegivel.
    const rows = await this.execute<OutboxRow>(
      `update outbox_messages
          set locked_by = ?, locked_until = now() + (? * interval '1 millisecond')
        where id in (
          select id from outbox_messages
           where published_at is null
             and (next_attempt_at is null or next_attempt_at <= now())
             and (locked_until is null or locked_until < now())
           order by occurred_at
           limit ?
           for update skip locked)
       returning id, aggregate_id, event_type, payload, occurred_at, attempts`,
      [owner, leaseMs, limit],
    );
    return rows
      .map((row) => ({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
      }))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(ids: readonly string[], owner: string, at: Date): Promise<string[]> {
    if (ids.length === 0) return [];
    // So quem ainda detem o lease marca. Se outro assumiu e publicou tambem, o evento saiu duas vezes
    // (o consumidor deduplica por eventId), mas e marcado uma vez so. Um comando para o lote inteiro.
    const rows = await this.execute<{ id: string }>(
      `update outbox_messages
          set published_at = ?, locked_by = null, locked_until = null, last_error = null
        where id in (?) and locked_by = ? and published_at is null
       returning id`,
      [at, ids, owner],
    );
    return rows.map((row) => row.id);
  }

  async reschedule(id: string, owner: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = null, locked_until = null
        where id = ? and locked_by = ? and published_at is null`,
      [attempts, nextAttemptAt, error.slice(0, 1000), id, owner],
    );
  }

  async oldestPendingAgeMs(now: Date): Promise<number> {
    const [row] = await this.execute<{ oldest: Date | null }>(
      `select min(occurred_at) as oldest from outbox_messages where published_at is null`,
      [],
    );
    return row?.oldest ? Math.max(0, now.getTime() - new Date(row.oldest).getTime()) : 0;
  }

  private async execute<T>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return (await this.orm.em.fork().execute(sql, params)) as T[];
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}

export class SqlPendingReferenceFinder implements PendingReferenceFinder {
  constructor(private readonly orm: MikroORM) {}

  async findDue(now: Date, limit: number): Promise<DuePendingReference[]> {
    try {
      const rows = (await this.orm.em.fork().execute(
        `select id, wallet_id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
          order by next_reference_check_at
          limit ?`,
        [now, limit],
      )) as { id: string; wallet_id: string }[];
      return rows.map((row) => ({ transactionId: row.id, walletId: row.wallet_id }));
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}
