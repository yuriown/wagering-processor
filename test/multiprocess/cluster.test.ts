import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { WagerCommand } from "../../src/application/wager-command";
import { WagerRequestProducer } from "../../src/interfaces/sqs/wager-request-producer";
import { expectLedgerConsistent } from "../support/application";
import { type Instance, type InstanceEnv, http, startInstance, waitFor } from "../support/cluster";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { type TestQueues, createTestQueues, drain, queueDepth } from "../support/queues";

/**
 * Varias instancias da aplicacao como PROCESSOS separados (bun src/main.ts), dividindo
 * so Postgres e SQS. Nada de memoria compartilhada: e o cenario de producao com N replicas.
 */
setDefaultTimeout(120_000);

let db: TestDatabase;
let queues: TestQueues;
let instances: Instance[] = [];
const extraInstances: Instance[] = [];

const envFor = (q: TestQueues, workers?: string, extra?: Record<string, string>): InstanceEnv => ({
  databaseUrl: db.url,
  queueName: q.queueName,
  dlqName: q.dlqName,
  eventsQueueName: q.eventsName,
  maxReceiveCount: q.maxReceiveCount,
  ...(workers === undefined ? {} : { workers }),
  ...(extra === undefined ? {} : { extra }),
});

async function startCluster(prefix: string): Promise<Instance[]> {
  return Promise.all([1, 2, 3].map((n) => startInstance(`${prefix}-${n}`, envFor(queues))));
}

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 10, maxReceiveCount: 5 });
  instances = await startCluster("instancia");
});

afterAll(async () => {
  await Promise.all([...instances, ...extraInstances].map((i) => i.kill().catch(() => undefined)));
  await queues?.drop();
  await db?.drop();
});

async function createWallet(base: string, amount: string) {
  const playerId = crypto.randomUUID();
  const { status, body } = await http(base, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(status).toBe(201);
  return { id: body.id as string, playerId };
}

function wager(wallet: { id: string; playerId: string }, kind: string, amount: string, externalTransactionId = `tx-${crypto.randomUUID()}`): WagerCommand {
  return {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: kind as WagerCommand["kind"],
    money: { amount, currency: "BRL" },
  };
}

const post = (instance: Instance, command: WagerCommand) =>
  http(instance.url, "POST", "/wagering/transactions", command, { "Idempotency-Key": command.idempotencyKey });

async function count(sql: string, walletId: string): Promise<number> {
  const [row] = await db.sql.unsafe(sql, [walletId]);
  return row.count;
}
const debits = (walletId: string) =>
  count("select count(*)::int as count from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'", walletId);
const providerTransactions = (walletId: string) =>
  count("select count(*)::int as count from wager_transactions where wallet_id = $1 and kind <> 'OPENING'", walletId);

describe("3 instancias via HTTP", () => {
  test("a mesma aposta 50 vezes espalhada pelas 3 instancias: um unico debito", async () => {
    const wallet = await createWallet(instances[0]!.url, "100.00");
    const bet = wager(wallet, "BET", "10.00");
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => post(instances[i % 3]!, bet)));

    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 200).length).toBe(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debits(wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("90.00");
  });

  test("cenario da secao 8 com cada aposta numa instancia diferente", async () => {
    const wallet = await createWallet(instances[0]!.url, "100.00");
    const [a, b] = await Promise.all([post(instances[1]!, wager(wallet, "BET", "80.00")), post(instances[2]!, wager(wallet, "BET", "80.00"))]);
    expect([a!.status, b!.status].sort()).toEqual([201, 422]);
    expect([a!.body.failureCode, b!.body.failureCode]).toContain("INSUFFICIENT_FUNDS");
    expect(await debits(wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("20.00");
  });

  test("wallet quente: 90 operacoes simultaneas nas 3 instancias, sem saldo negativo nem buraco no ledger", async () => {
    const wallet = await createWallet(instances[0]!.url, "50.00");
    const responses = await Promise.all(
      Array.from({ length: 90 }, (_, i) => post(instances[i % 3]!, wager(wallet, i % 3 === 0 ? "WIN" : "BET", i % 3 === 0 ? "7.00" : "9.00"))),
    );
    expect(responses.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    const final = await expectLedgerConsistent(db.sql, wallet.id);
    expect(final.startsWith("-")).toBe(false);
    const [chain] = await db.sql`
      select count(*)::int as entries, max(wallet_version) - min(wallet_version) + 1 as span
        from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(chain.span).toBe(chain.entries);
    expect(chain.entries).toBe(responses.filter((r) => r.status === 201).length + 1);
  });
});

describe("3 instancias consumindo a mesma fila", () => {
  test("10 wallets x 20 mensagens + 20 redeliveries: cada efeito uma vez, todos os eventos publicados", async () => {
    const producer = new WagerRequestProducer(queues.sqs, queues.queueUrl);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(instances[0]!.url, "1000.00")));
    const sent: { command: WagerCommand; messageId: string }[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 20; i++) {
        const command = wager(wallet, "BET", "1.00");
        sent.push({ command, messageId: await producer.send(command) });
      }
    }
    // Redeliveries: mesmo messageId, outro dedup id -> o SQS entrega de novo; a inbox segura.
    for (const { command, messageId } of sent.slice(0, 20)) {
      await producer.send(command, { messageId, deduplicationId: `${messageId}-de-novo` });
    }

    await waitFor("fila vazia", async () => {
      const depth = await queueDepth(queues.sqs, queues.queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    });
    for (const wallet of wallets) {
      expect(await providerTransactions(wallet.id)).toBe(20);
      expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("980.00");
    }
    const [inbox] = await db.sql`select count(*)::int as count from inbox_messages`;
    expect(inbox.count).toBe(200);
    expect(await drain(queues.sqs, queues.dlqUrl)).toEqual([]);

    // As 3 instancias publicam a outbox ao mesmo tempo.
    await waitFor("outbox publicada", async () => {
      const [row] = await db.sql`select count(*)::int as count from outbox_messages where published_at is null`;
      return row.count === 0;
    });
    const [{ total }] = await db.sql`select count(*)::int as total from outbox_messages`;
    const events = await drain(queues.sqs, queues.eventsUrl);
    expect(new Set(events.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(total);
  });
});

describe("falhas de processo", () => {
  test("worker morto (SIGKILL) depois do commit e antes do ack: a redelivery vira replay", async () => {
    const own = await createTestQueues({ visibilityTimeoutSeconds: 2, maxReceiveCount: 5 });
    try {
      const wallet = await createWallet(instances[0]!.url, "100.00");
      const suicida = await startInstance("suicida", envFor(own, "consumer", { FAULT_INJECTION: "crash-after-commit" }));
      extraInstances.push(suicida);
      await new WagerRequestProducer(own.sqs, own.queueUrl).send(wager(wallet, "BET", "30.00"));

      const exitCode = await suicida.exited;
      expect(exitCode).not.toBe(0); // morreu, nao saiu
      // O commit aconteceu; o ack nao.
      expect(await providerTransactions(wallet.id)).toBe(1);
      expect((await queueDepth(own.sqs, own.queueUrl)).inFlight).toBe(1);

      const sobrevivente = await startInstance("sobrevivente", envFor(own, "consumer"));
      extraInstances.push(sobrevivente);
      await waitFor("mensagem confirmada pelo sobrevivente", async () => {
        const depth = await queueDepth(own.sqs, own.queueUrl);
        return depth.visible === 0 && depth.inFlight === 0;
      });
      expect(await providerTransactions(wallet.id)).toBe(1);
      expect(await debits(wallet.id)).toBe(1);
      expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
      expect(await drain(own.sqs, own.dlqUrl)).toEqual([]);
      await sobrevivente.kill();
    } finally {
      await own.drop();
    }
  });

  test("reinicio: as 3 instancias morrem no meio do fluxo, voltam, e o estado final e consistente", async () => {
    const producer = new WagerRequestProducer(queues.sqs, queues.queueUrl);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(instances[0]!.url, "500.00")));
    for (let i = 0; i < 30; i++) {
      for (const wallet of wallets) await producer.send(wager(wallet, i % 5 === 0 ? "WIN" : "BET", i % 5 === 0 ? "3.00" : "2.00"));
    }
    const processed = async () => {
      const [row] = await db.sql`select count(*)::int as count from wager_transactions
                                  where wallet_id in ${db.sql(wallets.map((w) => w.id))} and kind <> 'OPENING'`;
      return row.count as number;
    };
    await waitFor("parte do fluxo processada", async () => (await processed()) >= 20, 60_000, 20);

    // Queda total, sem shutdown gracioso.
    await Promise.all(instances.map((i) => i.kill()));
    const before = await processed();
    expect(before).toBeLessThan(150);

    instances = await startCluster("reiniciada");
    await waitFor("todas as mensagens processadas", async () => (await processed()) === 150);
    await waitFor("fila vazia", async () => {
      const depth = await queueDepth(queues.sqs, queues.queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    });
    await waitFor("outbox publicada", async () => {
      const [row] = await db.sql`select count(*)::int as count from outbox_messages where published_at is null`;
      return row.count === 0;
    });

    for (const wallet of wallets) {
      // 6 WIN de 3.00 e 24 BET de 2.00 por wallet: 500 + 18 - 48 = 470.
      expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("470.00");
      const recon = await http(instances[1]!.url, "POST", `/wallets/${wallet.id}/reconciliation`);
      expect(recon.body.consistent).toBe(true);
      expect(recon.body.checkedEntries).toBe(31);
    }
    expect(await drain(queues.sqs, queues.dlqUrl)).toEqual([]);
    await drain(queues.sqs, queues.eventsUrl);
  });

  // No Windows o SIGTERM vira TerminateProcess (morte imediata); o desligamento gracioso so e testavel em POSIX (CI).
  test.skipIf(process.platform === "win32")("SIGTERM: a instancia para os workers e fecha conexoes antes de sair", async () => {
    const instance = await startInstance("desligavel", envFor(queues));
    extraInstances.push(instance);
    const started = performance.now();
    // O Nest re-emite o sinal depois do shutdown, entao o codigo de saida e o de SIGTERM;
    // a prova do desligamento gracioso e o que o processo fez antes de sair.
    await instance.terminate();
    expect(performance.now() - started).toBeLessThan(15_000);
    const logs = instance.logs();
    expect(logs).toContain('"message":"parando workers"');
    expect(logs).toContain('"message":"workers parados"');
    expect(logs).not.toContain('"level":"error"');
  });
});
