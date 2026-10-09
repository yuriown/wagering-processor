import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ClaimedOutboxMessage, EventPublisher, PublishResult } from "../../src/application/ports";
import { PublishOutbox } from "../../src/application/publish-outbox";
import { PendingReferenceSweep, ResolvePendingReference } from "../../src/application/resolve-pending-reference";
import { EventFactory } from "../../src/application/event-factory";
import { TransientInfrastructureError } from "../../src/application/errors";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { SqlOutboxStore, SqlPendingReferenceFinder } from "../../src/infrastructure/persistence/sql-outbox-store";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system";
import { type TestApplication, buildApplication, command, ctx, expectLedgerConsistent, openWallet } from "../support/application";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { type TestQueues, createTestQueues, drain } from "../support/queues";

// Esperas reais de visibilidade e backoff do SQS (segundos), nao relogio falso.
setDefaultTimeout(30_000);

let db: TestDatabase;
let app: TestApplication;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDatabase();
  app = buildApplication(db);
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues?.drop();
  await db?.drop();
});

/** Publicador real (SQS) que tambem anota o que cada instancia enviou. */
class RecordingPublisher implements EventPublisher {
  readonly sent: string[] = [];
  private readonly inner = new SqsEventPublisher(queues.sqs, async () => queues.eventsUrl);

  async publish(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    this.sent.push(...messages.map((m) => m.id));
    return this.inner.publish(messages);
  }
}

class FailingPublisher implements EventPublisher {
  async publish(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    return messages.map((m) => ({ id: m.id, ok: false, error: "broker fora" }));
  }
}

function relay(owner: string, publisher: EventPublisher, options: { leaseMs?: number; batchSize?: number } = {}) {
  return new PublishOutbox(new SqlOutboxStore(db.orm), publisher, new SystemClock(), app.metrics, app.logger, {
    owner,
    batchSize: options.batchSize ?? 10,
    leaseMs: options.leaseMs ?? 30_000,
  });
}

async function pendingEvents(): Promise<number> {
  const [{ count }] = await db.sql`select count(*)::int as count from outbox_messages where published_at is null`;
  return count;
}

async function drainOutbox(...relays: PublishOutbox[]): Promise<void> {
  for (let i = 0; i < 100 && (await pendingEvents()) > 0; i++) {
    await Promise.all(relays.map((r) => r.runOnce()));
  }
}

describe("outbox", () => {
  test("commit confirmado, processo morre antes de publicar: outra instancia publica depois", async () => {
    const wallet = await openWallet(app, "100.00");
    await app.process.execute(command(wallet, "BET", "10.00"), ctx());
    // Nenhum relay rodou: os eventos estao so no banco, confirmados junto com o debito.
    const [{ count }] = await db.sql`select count(*)::int as count from outbox_messages where aggregate_id = ${wallet.id} and published_at is null`;
    expect(count).toBe(4); // OPENING (Processed + BalanceChanged) + BET (Processed + BalanceChanged)

    await drainOutbox(relay("instancia-nova", new RecordingPublisher()));
    expect(await pendingEvents()).toBe(0);
    const published = await drain(queues.sqs, queues.eventsUrl);
    const envelopes = published.map((m) => JSON.parse(m.Body!));
    const mine = envelopes.filter((e) => e.aggregateId === wallet.id);
    expect(mine.map((e) => e.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    expect(published.every((m) => m.Attributes?.MessageGroupId === JSON.parse(m.Body!).aggregateId)).toBe(true);
    const changed = mine.find((e) => e.eventType === "WalletBalanceChanged" && e.data.direction === "DEBIT");
    expect(changed.data).toMatchObject({ money: { amount: "10.00", currency: "BRL" }, balanceAfter: { amount: "90.00", currency: "BRL" } });
  });

  test("dois publicadores concorrentes: lotes disjuntos, nenhum evento perdido, cada um marcado uma vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(app, "100.00")));
    await Promise.all(wallets.map((w) => app.process.execute(command(w, "BET", "1.00"), ctx())));
    const [{ total }] = await db.sql`select count(*)::int as total from outbox_messages where published_at is null`;
    expect(total).toBe(40);

    const a = new RecordingPublisher();
    const b = new RecordingPublisher();
    await drainOutbox(relay("publicador-a", a, { batchSize: 7 }), relay("publicador-b", b, { batchSize: 7 }));

    expect(await pendingEvents()).toBe(0);
    expect(a.sent.length).toBeGreaterThan(0);
    expect(b.sent.length).toBeGreaterThan(0);
    expect(a.sent.filter((id) => b.sent.includes(id))).toEqual([]); // SKIP LOCKED: ninguem pegou o mesmo
    expect(new Set([...a.sent, ...b.sent]).size).toBe(40);
    const published = await drain(queues.sqs, queues.eventsUrl);
    expect(new Set(published.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(40);
  });

  test("falha ao publicar: tentativa reagendada com backoff, lease liberado, publica depois", async () => {
    const wallet = await openWallet(app, "100.00");
    expect(await pendingEvents()).toBe(2);
    await relay("instavel", new FailingPublisher()).runOnce();
    const rows = await db.sql`
      select attempts, next_attempt_at > now() as later, locked_by, last_error from outbox_messages where aggregate_id = ${wallet.id}`;
    expect(rows).toEqual([
      { attempts: 1, later: true, locked_by: null, last_error: "broker fora" },
      { attempts: 1, later: true, locked_by: null, last_error: "broker fora" },
    ]);

    // Antes do prazo, ninguem pega.
    expect(await relay("outro", new RecordingPublisher()).runOnce()).toBe(0);
    await Bun.sleep(1_100); // backoff de 1 s na primeira tentativa
    expect(await relay("outro", new RecordingPublisher()).runOnce()).toBe(2);
    expect(await pendingEvents()).toBe(0);
    await drain(queues.sqs, queues.eventsUrl);
  });

  test("publicador morre com o lote na mao: o lease expira e outro assume; o atrasado nao marca de novo", async () => {
    const wallet = await openWallet(app, "100.00");
    const store = new SqlOutboxStore(db.orm);
    const claimed = await store.claim("publicador-morto", 10, 300);
    expect(claimed.length).toBe(2);

    const survivor = relay("sobrevivente", new RecordingPublisher());
    expect(await survivor.runOnce()).toBe(0); // lease ainda valido
    await Bun.sleep(350);
    expect(await survivor.runOnce()).toBe(2);
    expect(await pendingEvents()).toBe(0);

    // O "morto" volta e tenta marcar: o lease nao e mais dele.
    expect(await store.markPublished([claimed[0]!.id], "publicador-morto", new Date())).toEqual([]);
    const [row] = await db.sql`select count(*)::int as count from outbox_messages where aggregate_id = ${wallet.id} and published_at is not null`;
    expect(row.count).toBe(2);
    await drain(queues.sqs, queues.eventsUrl);
  });
});

describe("worker de referencias pendentes", () => {
  function resolver(maxAttempts?: number) {
    const ids = new UuidV7Generator();
    const clock = new SystemClock();
    return new ResolvePendingReference(app.runner, ids, clock, new EventFactory(ids, clock), app.metrics, app.logger, maxAttempts);
  }

  const sweep = (r = resolver()) =>
    new PendingReferenceSweep(new SqlPendingReferenceFinder(db.orm), r, new SystemClock(), app.logger);

  async function statusOf(transactionId: string) {
    const [row] = await db.sql`select status, failure_code, reference_attempts from wager_transactions where id = ${transactionId}`;
    return row;
  }

  test("ROLLBACK antes da BET: quando a BET chega, o worker aplica o ROLLBACK", async () => {
    const wallet = await openWallet(app, "100.00");
    const rollback = await app.process.execute(
      command(wallet, "ROLLBACK", "30.00", { referenceExternalTransactionId: "bet-tardia" }),
      ctx(),
    );
    expect(rollback.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    await app.process.execute(command(wallet, "BET", "30.00", { externalTransactionId: "bet-tardia" }), ctx());
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");

    // A chegada da BET antecipou a verificacao: uma varredura resolve.
    expect(await sweep().runOnce()).toBeGreaterThanOrEqual(1);
    expect(await statusOf(rollback.transaction.id)).toMatchObject({ status: "PROCESSED", failure_code: null });
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("100.00");
    const [event] = await db.sql`
      select count(*)::int as count from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ${rollback.transaction.id} and event_type = 'WagerTransactionProcessed'`;
    expect(event.count).toBe(1);
  });

  test("referencia que nunca chega: esgotado o limite, REJECTED com REFERENCE_NOT_FOUND e evento", async () => {
    const wallet = await openWallet(app, "100.00");
    const refund = await app.process.execute(
      command(wallet, "REFUND", "30.00", { referenceExternalTransactionId: "fantasma" }),
      ctx(),
    );
    const impatient = sweep(resolver(3));
    for (let i = 0; i < 5; i++) {
      await db.sql`update wager_transactions set next_reference_check_at = now() - interval '1 second'
                    where id = ${refund.transaction.id} and status = 'PENDING_REFERENCE'`;
      await impatient.runOnce();
    }
    expect(await statusOf(refund.transaction.id)).toEqual({
      status: "REJECTED",
      failure_code: FailureCode.ReferenceNotFound,
      reference_attempts: 3,
    });
    const [event] = await db.sql`
      select payload -> 'data' ->> 'failureCode' as code from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ${refund.transaction.id} and event_type = 'WagerTransactionRejected'`;
    expect(event.code).toBe("REFERENCE_NOT_FOUND");
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("100.00");
  });

  test("falha permanente vira FAILED auditavel e nao trava as outras pendencias da varredura", async () => {
    // Wallet A: REFUND esperando a BET; a BET chega (A fica na frente da fila de vencidas).
    const a = await openWallet(app, "100.00");
    const refundA = await app.process.execute(
      command(a, "REFUND", "30.00", { referenceExternalTransactionId: "bet-a" }),
      ctx(),
    );
    await app.process.execute(command(a, "BET", "30.00", { externalTransactionId: "bet-a" }), ctx());
    // Wallet B: o mesmo, saudavel, vencendo depois de A.
    const b = await openWallet(app, "100.00");
    const refundB = await app.process.execute(
      command(b, "REFUND", "40.00", { referenceExternalTransactionId: "bet-b" }),
      ctx(),
    );
    await app.process.execute(command(b, "BET", "40.00", { externalTransactionId: "bet-b" }), ctx());

    // Corrompe o saldo de A por fora (so superusuario, triggers desligados): o ledger diz 70, a wallet diz 999.
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = 999 where id = ${a.id}`;
    });
    const before = app.metrics.count("pending_reference_resolutions_total", { result: "failed" });

    await sweep().runOnce();

    // A: o banco recusou o lancamento (quebraria a corrente do ledger). Tentar de novo daria o mesmo erro.
    expect(await statusOf(refundA.transaction.id)).toMatchObject({ status: "FAILED", failure_code: FailureCode.ProcessingFailed });
    const [failed] = await db.sql`
      select processed_at is not null as decided, next_reference_check_at from wager_transactions where id = ${refundA.transaction.id}`;
    expect(failed).toEqual({ decided: true, next_reference_check_at: null });
    const [{ entries }] = await db.sql`select count(*)::int as entries from wallet_ledger_entries where transaction_id = ${refundA.transaction.id}`;
    expect(entries).toBe(0);
    expect(app.metrics.count("pending_reference_resolutions_total", { result: "failed" })).toBe(before + 1);
    expect(app.logger.lines.some((l) => l.level === "error" && l.message.includes("FAILED"))).toBe(true);
    // Consultavel pela API de leitura, com o codigo estavel.
    expect((await app.queries.getTransaction(refundA.transaction.id)).failureCode).toBe(FailureCode.ProcessingFailed);

    // B: resolvida na mesma varredura, mesmo vindo depois da que falhou.
    expect(await statusOf(refundB.transaction.id)).toMatchObject({ status: "PROCESSED" });
    expect(await expectLedgerConsistent(db.sql, b.id)).toBe("100.00");

    // A nao volta na proxima varredura: FAILED e terminal.
    const due = await new SqlPendingReferenceFinder(db.orm).findDue(new Date(Date.now() + 3_600_000), 1_000);
    expect(due.map((d) => d.transactionId)).not.toContain(refundA.transaction.id);
  });

  test("falha transitoria numa pendencia nao bloqueia as outras e a mantem pendente", async () => {
    const a = await openWallet(app, "100.00");
    const refundA = await app.process.execute(
      command(a, "REFUND", "10.00", { referenceExternalTransactionId: "bet-ta" }),
      ctx(),
    );
    await app.process.execute(command(a, "BET", "10.00", { externalTransactionId: "bet-ta" }), ctx());
    const b = await openWallet(app, "100.00");
    const refundB = await app.process.execute(
      command(b, "REFUND", "10.00", { referenceExternalTransactionId: "bet-tb" }),
      ctx(),
    );
    await app.process.execute(command(b, "BET", "10.00", { externalTransactionId: "bet-tb" }), ctx());

    const real = resolver();
    const flaky = {
      execute: (transactionId: string, walletId: string) =>
        transactionId === refundA.transaction.id
          ? Promise.reject(new TransientInfrastructureError("banco fora", "connection"))
          : real.execute(transactionId, walletId),
    } as unknown as ResolvePendingReference;
    await new PendingReferenceSweep(new SqlPendingReferenceFinder(db.orm), flaky, new SystemClock(), app.logger).runOnce();

    expect(await statusOf(refundA.transaction.id)).toMatchObject({ status: "PENDING_REFERENCE" });
    expect(await statusOf(refundB.transaction.id)).toMatchObject({ status: "PROCESSED" });
    // Na varredura seguinte, com o banco de volta, A e resolvida.
    await sweep().runOnce();
    expect(await statusOf(refundA.transaction.id)).toMatchObject({ status: "PROCESSED" });
  });

  test("varios workers sobre a mesma pendencia: aplicada uma vez so", async () => {
    const wallet = await openWallet(app, "100.00");
    const refund = await app.process.execute(
      command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: "bet-x" }),
      ctx(),
    );
    await app.process.execute(command(wallet, "BET", "40.00", { externalTransactionId: "bet-x" }), ctx());
    const results = await Promise.all(Array.from({ length: 5 }, () => resolver().execute(refund.transaction.id, wallet.id)));
    expect(results.filter((r) => r === "processed").length).toBe(1);
    expect(results.filter((r) => r === "skipped").length).toBe(4);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("100.00");
  });
});
