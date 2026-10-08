import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IdempotencyConflictError, InboxConflictError, WalletAlreadyExistsError, WalletNotFoundError } from "../../src/application/errors";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { type TestApplication, buildApplication, command, ctx, expectLedgerConsistent, openWallet } from "../support/application";
import { type TestDatabase, createTestDatabase, expectAsync } from "../support/database";

let db: TestDatabase;
let app: TestApplication;

beforeAll(async () => {
  db = await createTestDatabase();
  app = buildApplication(db);
});

afterAll(async () => {
  await db?.drop();
});

async function outboxTypes(walletId: string): Promise<string[]> {
  const rows = await db.sql`select event_type from outbox_messages where aggregate_id = ${walletId} order by occurred_at, event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

describe("criar wallet", () => {
  test("saldo inicial gera OPENING, credito no ledger e eventos, no mesmo commit", async () => {
    const wallet = await openWallet(app, "1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    const [opening] = await db.sql`select kind, status, amount::text from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", amount: "1000.00" });
    expect((await outboxTypes(wallet.id)).sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("saldo zero: nenhuma transacao, nenhum lancamento", async () => {
    const wallet = await openWallet(app, "0.00");
    const [{ count }] = await db.sql`select count(*)::int as count from wager_transactions where wallet_id = ${wallet.id}`;
    expect(count).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  test("duplicada para o mesmo player + moeda e conflito; outra moeda pode", async () => {
    const wallet = await openWallet(app, "10.00");
    await expectAsync(
      app.createWallet.execute({ playerId: wallet.playerId, initialBalance: { amount: "5.00", currency: "BRL" } }, ctx()),
    ).rejects.toThrow(WalletAlreadyExistsError);
    await app.createWallet.execute({ playerId: wallet.playerId, initialBalance: { amount: "5.00", currency: "USD" } }, ctx());
  });

  test("criacoes simultaneas da mesma wallet: exatamente uma vence", async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        app.createWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }, ctx()),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
  });
});

describe("processar transacao", () => {
  test("BET -> WIN -> LOSS: saldo, lancamentos e eventos", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = await app.process.execute(command(wallet, "BET", "25.00", { externalTransactionId: "bet-1" }), ctx());
    expect(bet.idempotentReplay).toBe(false);
    expect(bet.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.transaction.observedBalance?.toJSON().amount).toBe("75.00");

    const win = await app.process.execute(
      command(wallet, "WIN", "60.00", { referenceExternalTransactionId: "bet-1" }),
      ctx(),
    );
    expect(win.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(win.transaction.observedBalance?.toJSON().amount).toBe("135.00");

    const loss = await app.process.execute(command(wallet, "LOSS", "10.00"), ctx());
    expect(loss.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("135.00");

    const current = await app.queries.getWallet(wallet.id);
    expect(current.version).toBe(3); // abertura, BET, WIN; LOSS nao muda versao
    const types = await outboxTypes(wallet.id);
    expect(types.filter((t) => t === "WagerTransactionProcessed").length).toBe(4); // OPENING, BET, WIN, LOSS
    expect(types.filter((t) => t === "WalletBalanceChanged").length).toBe(3);
  });

  test("REFUND e ROLLBACK revertem uma vez; a segunda reversao e rejeitada", async () => {
    const wallet = await openWallet(app, "100.00");
    await app.process.execute(command(wallet, "BET", "40.00", { externalTransactionId: "b" }), ctx());
    const refund = await app.process.execute(command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: "b" }), ctx());
    expect(refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    const rollback = await app.process.execute(
      command(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: "b" }),
      ctx(),
    );
    expect(rollback.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("100.00");
  });

  test("ROLLBACK de WIN ja gasto: REVERSAL_WOULD_OVERDRAW, auditavel e com evento", async () => {
    const wallet = await openWallet(app, "0.00");
    await app.process.execute(command(wallet, "WIN", "50.00", { externalTransactionId: "w" }), ctx());
    await app.process.execute(command(wallet, "BET", "45.00"), ctx());
    const rollback = await app.process.execute(command(wallet, "ROLLBACK", "50.00", { referenceExternalTransactionId: "w" }), ctx());
    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.transaction.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    const stored = await app.queries.getTransaction(rollback.transaction.id);
    expect(stored.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionRejected");
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("5.00");
  });

  test("rejeicao nao move saldo nem gera lancamento, mas gera evento", async () => {
    const wallet = await openWallet(app, "10.00");
    const outcome = await app.process.execute(command(wallet, "BET", "10.01"), ctx());
    expect(outcome.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    const [{ count }] = await db.sql`select count(*)::int as count from wallet_ledger_entries where transaction_id = ${outcome.transaction.id}`;
    expect(count).toBe(0);
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionRejected");
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("10.00");
  });

  test("moeda diferente da wallet: REJECTED, e o saldo observado volta na moeda da wallet", async () => {
    const wallet = await openWallet(app, "10.00");
    const usd = command(wallet, "BET", "1.00", { money: { amount: "1.00", currency: "USD" } });
    const outcome = await app.process.execute(usd, ctx());
    expect(outcome.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    const replay = await app.process.execute(usd, ctx());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.observedBalance?.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("wallet inexistente: erro, nada gravado", async () => {
    const ghost = { id: "0192f291-27dd-7d3f-8071-5f8685deef37", playerId: "p" };
    await expectAsync(app.process.execute(command(ghost, "BET", "1.00"), ctx())).rejects.toThrow(WalletNotFoundError);
  });
});

describe("idempotencia", () => {
  test("replay devolve o resultado original, inclusive o saldo daquele momento", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    const first = await app.process.execute(bet, ctx());
    await app.process.execute(command(wallet, "WIN", "500.00"), ctx());
    const replay = await app.process.execute(bet, ctx());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.observedBalance?.toJSON().amount).toBe("70.00");
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("570.00");
    expect(app.metrics.count("wager_duplicates_total", { source: "http" })).toBeGreaterThan(0);
  });

  test("replay de rejeicao continua rejeicao", async () => {
    const wallet = await openWallet(app, "1.00");
    const bet = command(wallet, "BET", "5.00");
    await app.process.execute(bet, ctx());
    await app.process.execute(command(wallet, "WIN", "100.00"), ctx());
    const replay = await app.process.execute(bet, ctx());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("mesma key com payload diferente: conflito, nunca replay", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await app.process.execute(bet, ctx());
    await expectAsync(app.process.execute({ ...bet, money: { amount: "30.01", currency: "BRL" } }, ctx())).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expectAsync(app.process.execute({ ...bet, roundId: "outra" }, ctx())).rejects.toThrow(IdempotencyConflictError);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });

  test("mesma operacao do provedor com outra key: conflito", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await app.process.execute(bet, ctx());
    await expectAsync(app.process.execute({ ...bet, idempotencyKey: "outra-chave" }, ctx())).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  test("a idempotencia e persistente: outro processo (novo runner) ve o replay", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await app.process.execute(bet, ctx());
    const otherInstance = buildApplication(db);
    const replay = await otherInstance.process.execute(bet, ctx());
    expect(replay.idempotentReplay).toBe(true);
  });
});

describe("inbox", () => {
  const inbox = (messageId: string, payloadHash = "a".repeat(64)) => ({
    consumerName: "wager-consumer",
    messageId,
    payloadHash,
  });

  test("grava a inbox no mesmo commit e reconhece a redelivery", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    const first = await app.process.execute(bet, ctx({ inbox: inbox("msg-1") }));
    const [row] = await db.sql`select transaction_id, processed_at is not null as processed from inbox_messages where message_id = 'msg-1'`;
    expect(row).toEqual({ transaction_id: first.transaction.id, processed: true });

    const redelivery = await app.process.execute(bet, ctx({ inbox: inbox("msg-1") }));
    expect(redelivery.idempotentReplay).toBe(true);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });

  test("mesmo messageId com conteudo diferente nao e redelivery", async () => {
    const wallet = await openWallet(app, "100.00");
    await app.process.execute(command(wallet, "BET", "1.00"), ctx({ inbox: inbox("msg-2") }));
    await expectAsync(
      app.process.execute(command(wallet, "BET", "2.00"), ctx({ inbox: inbox("msg-2", "b".repeat(64)) })),
    ).rejects.toThrow(InboxConflictError);
  });
});

describe("referencia fora de ordem", () => {
  test("REFUND antes da BET fica PENDING_REFERENCE; a chegada da BET antecipa a reavaliacao", async () => {
    const wallet = await openWallet(app, "100.00");
    const refund = await app.process.execute(
      command(wallet, "REFUND", "30.00", { referenceExternalTransactionId: "bet-atrasada" }),
      ctx(),
    );
    expect(refund.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    const [before] = await db.sql`select next_reference_check_at from wager_transactions where id = ${refund.transaction.id}`;
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionPendingReference");

    await app.process.execute(command(wallet, "BET", "30.00", { externalTransactionId: "bet-atrasada" }), ctx());
    const [after] = await db.sql`select next_reference_check_at from wager_transactions where id = ${refund.transaction.id}`;
    expect(new Date(after.next_reference_check_at).getTime()).toBeLessThan(new Date(before.next_reference_check_at).getTime());
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });
});

describe("reconciliacao", () => {
  test("consistente: diferenca zero e numero de lancamentos", async () => {
    const wallet = await openWallet(app, "100.00");
    await app.process.execute(command(wallet, "BET", "12.34"), ctx());
    const report = await app.reconcile.execute(wallet.id);
    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "87.66", currency: "BRL" },
      calculatedBalance: { amount: "87.66", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergencia (forcada desligando as triggers) e sinalizada, logada e contada, nunca corrigida", async () => {
    const wallet = await openWallet(app, "100.00");
    // So um superusuario consegue isto: e exatamente o cenario que a reconciliacao existe para pegar.
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = 90 where id = ${wallet.id}`;
    });
    const report = await app.reconcile.execute(wallet.id);
    expect(report.consistent).toBe(false);
    expect(report.difference).toEqual({ amount: "-10.00", currency: "BRL" });
    expect(app.metrics.count("reconciliation_divergences_total")).toBe(1);
    expect(app.logger.lines.some((l) => l.level === "error" && l.fields.walletId === wallet.id)).toBe(true);
    const [row] = await db.sql`select balance::text as balance from wallets where id = ${wallet.id}`;
    expect(row.balance).toBe("90.00");
  });
});
