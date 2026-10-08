import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IdempotencyConflictError, TransientInfrastructureError } from "../../src/application/errors";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { type TestApplication, buildApplication, command, ctx, expectLedgerConsistent, openWallet } from "../support/application";
import { type TestDatabase, createTestDatabase } from "../support/database";

/**
 * Paralelismo real dentro de um processo: cada chamada usa a propria conexao do
 * pool e a propria transacao no Postgres. (Varias instancias em processos
 * separados ficam na suite de concorrencia multi-processo.)
 */
let db: TestDatabase;
let app: TestApplication;

beforeAll(async () => {
  db = await createTestDatabase();
  app = buildApplication(db);
});

afterAll(async () => {
  await db?.drop();
});

async function debitEntries(walletId: string): Promise<number> {
  const [{ count }] = await db.sql`
    select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return count;
}

describe("concorrencia na mesma wallet", () => {
  test("a mesma aposta 50 vezes em paralelo: um unico debito", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "10.00");
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => app.process.execute(bet, ctx())));

    expect(new Set(outcomes.map((o) => o.transaction.id)).size).toBe(1);
    expect(outcomes.filter((o) => !o.idempotentReplay).length).toBe(1);
    expect(outcomes.every((o) => o.transaction.observedBalance?.toJSON().amount === "90.00")).toBe(true);
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("90.00");
  });

  test("cenario da secao 8: 100.00 e duas apostas de 80.00 simultaneas", async () => {
    const wallet = await openWallet(app, "100.00");
    const [a, b] = await Promise.all([
      app.process.execute(command(wallet, "BET", "80.00"), ctx()),
      app.process.execute(command(wallet, "BET", "80.00"), ctx()),
    ]);
    const statuses = [a!.transaction.status, b!.transaction.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const rejected = [a!, b!].find((o) => o.transaction.status === WagerTransactionStatus.Rejected)!;
    expect(rejected.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("20.00");

    // Nenhum retry duplica o debito.
    await Promise.all([a, b].map((o) => app.process.execute(command(wallet, "BET", "80.00", {
      externalTransactionId: o!.transaction.externalTransactionId,
    }), ctx())));
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("20.00");
  });

  test("wallet quente: 100 operacoes misturadas em paralelo nunca deixam saldo negativo nem lancamento duplicado", async () => {
    const wallet = await openWallet(app, "50.00");
    const operations = Array.from({ length: 100 }, (_, i) =>
      i % 3 === 0 ? command(wallet, "WIN", "7.00") : command(wallet, "BET", "9.00"),
    );
    const outcomes = await Promise.all(operations.map((op) => app.process.execute(op, ctx())));

    const processed = outcomes.filter((o) => o.transaction.status === WagerTransactionStatus.Processed);
    const rejected = outcomes.filter((o) => o.transaction.status === WagerTransactionStatus.Rejected);
    expect(processed.length + rejected.length).toBe(100);
    expect(rejected.every((o) => o.transaction.failureCode === FailureCode.InsufficientFunds)).toBe(true);

    const final = await expectLedgerConsistent(db.sql, wallet.id);
    expect(final.startsWith("-")).toBe(false);
    const [chain] = await db.sql`
      select count(*)::int as entries, min(wallet_version) as first, max(wallet_version) as last
        from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(chain.entries).toBe(processed.length + 1); // + abertura
    expect(chain.last - chain.first + 1).toBe(chain.entries); // versoes sem buraco
  });

  test("mesma key em wallets diferentes ao mesmo tempo: uma vence, a outra recebe conflito", async () => {
    const [w1, w2] = await Promise.all([openWallet(app, "100.00"), openWallet(app, "100.00")]);
    const shared = { externalTransactionId: "corrida", idempotencyKey: "provider-a:corrida" };
    const results = await Promise.allSettled([
      app.process.execute(command(w1, "BET", "10.00", shared), ctx()),
      app.process.execute(command(w2, "BET", "10.00", shared), ctx()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(IdempotencyConflictError);
    const balances = [await expectLedgerConsistent(db.sql, w1.id), await expectLedgerConsistent(db.sql, w2.id)];
    expect(balances.sort()).toEqual(["100.00", "90.00"]);
  });
});

describe("wallets diferentes em paralelo", () => {
  test("20 wallets x 10 apostas simultaneas: todas consistentes", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(app, "100.00")));
    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 10 }, () => app.process.execute(command(wallet, "BET", "10.00"), ctx()))),
    );
    for (const wallet of wallets) {
      expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("0.00");
    }
  });

  test("lock e por wallet: uma wallet travada nao bloqueia as outras", async () => {
    const [busy, free] = await Promise.all([openWallet(app, "100.00"), openWallet(app, "100.00")]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = db.sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${busy.id} for update`;
      await held;
    });
    await Bun.sleep(50);

    try {
      const started = performance.now();
      await app.process.execute(command(free, "BET", "1.00"), ctx());
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      release();
      await holder;
    }
  });
});

test("lock que nao sai a tempo vira erro transitorio (503 na borda), sem efeito parcial", async () => {
  const impatient = buildApplication(db, { lockTimeoutMs: 200 });
  const wallet = await openWallet(app, "100.00");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = db.sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${wallet.id} for update`;
    await held;
  });
  await Bun.sleep(50);

  const bet = command(wallet, "BET", "10.00");
  try {
    const error = await impatient.process.execute(bet, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).reason).toBe("lock_timeout");
  } finally {
    // Sempre soltar o lock: senao o banco de teste nao consegue ser apagado no afterAll.
    release();
    await holder;
  }
  // Reenviar depois funciona e aplica uma vez so.
  const retry = await impatient.process.execute(bet, ctx());
  expect(retry.idempotentReplay).toBe(false);
  expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("90.00");
});
