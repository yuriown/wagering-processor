import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TransientInfrastructureError } from "../../src/application/errors";
import type { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { QueueUrls } from "../../src/infrastructure/messaging/queue-urls";
import { type ConsumerHooks, SimulatedCrash, WagerTransactionConsumer } from "../../src/interfaces/sqs/wager-consumer";
import { WagerRequestProducer } from "../../src/interfaces/sqs/wager-request-producer";
import { type TestApplication, buildApplication, command, expectLedgerConsistent, openWallet } from "../support/application";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { type TestQueues, createTestQueues, drain, queueDepth } from "../support/queues";

/** Consumidor contra MiniStack e Postgres reais. */
let db: TestDatabase;
let app: TestApplication;
let queues: TestQueues;
let producer: WagerRequestProducer;

beforeAll(async () => {
  db = await createTestDatabase();
  app = buildApplication(db);
  queues = await createTestQueues({ visibilityTimeoutSeconds: 2, maxReceiveCount: 3 });
  producer = new WagerRequestProducer(queues.sqs, queues.queueUrl);
});

afterAll(async () => {
  await queues?.drop();
  await db?.drop();
});

function consumer(options: { hooks?: ConsumerHooks; process?: Pick<ProcessWagerTransaction, "execute"> } = {}) {
  return new WagerTransactionConsumer(
    queues.sqs,
    new QueueUrls(queues.sqs),
    (options.process ?? app.process) as ProcessWagerTransaction,
    app.logger,
    app.metrics,
    {
      consumerName: "wager-transactions-consumer",
      queueName: queues.queueName,
      dlqName: queues.dlqName,
      maxMessages: 10,
      waitTimeSeconds: 1,
      maxReceiveCount: queues.maxReceiveCount,
      retryBaseSeconds: 1,
      retryMaxSeconds: 1,
    },
    options.hooks ?? {},
  );
}

async function transactionsOf(walletId: string): Promise<{ status: string; failure_code: string | null }[]> {
  return db.sql`select status, failure_code from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING'`;
}

/** Garante filas vazias entre testes (o que sobrar de um nao contamina o outro). */
async function expectQueuesEmpty() {
  expect(await queueDepth(queues.sqs, queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
}

describe("consumidor SQS", () => {
  test("processa com o mesmo caso de uso do HTTP, grava a inbox e so entao confirma", async () => {
    const wallet = await openWallet(app, "100.00");
    const messageId = await producer.send(command(wallet, "BET", "30.00"));
    expect(await consumer().pollOnce()).toBe(1);

    expect(await transactionsOf(wallet.id)).toEqual([{ status: "PROCESSED", failure_code: null }]);
    const [inbox] = await db.sql`select consumer_name, processed_at is not null as processed from inbox_messages where message_id = ${messageId}`;
    expect(inbox).toEqual({ consumer_name: "wager-transactions-consumer", processed: true });
    await expectQueuesEmpty();
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });

  test("a mesma mensagem entregue duas vezes: um efeito, duas confirmacoes", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = command(wallet, "BET", "30.00");
    const messageId = `msg-${crypto.randomUUID()}`;
    // Deduplication ids diferentes: o SQS entrega as duas; quem segura e a inbox.
    await producer.send(bet, { messageId, deduplicationId: `${messageId}-a` });
    await producer.send(bet, { messageId, deduplicationId: `${messageId}-b` });
    const c = consumer();
    let received = 0;
    while (received < 2) received += await c.pollOnce();

    expect((await transactionsOf(wallet.id)).length).toBe(1);
    await expectQueuesEmpty();
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });

  test("worker morto depois do commit e antes do ack: a redelivery vira replay, sem debito duplo", async () => {
    const wallet = await openWallet(app, "100.00");
    await producer.send(command(wallet, "BET", "30.00"));
    let crashes = 0;
    const crashing = consumer({
      hooks: {
        afterCommit: () => {
          crashes += 1;
          throw new SimulatedCrash("processo morreu antes do ack");
        },
      },
    });
    expect(await crashing.pollOnce()).toBe(1);
    expect(crashes).toBe(1);
    expect((await queueDepth(queues.sqs, queues.queueUrl)).inFlight).toBe(1); // sem ack

    await Bun.sleep(2_200); // visibilidade vence; o SQS reentrega
    const survivor = consumer();
    let received = 0;
    for (let i = 0; i < 5 && received === 0; i++) received = await survivor.pollOnce();
    expect(received).toBe(1);

    expect((await transactionsOf(wallet.id)).length).toBe(1);
    await expectQueuesEmpty();
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });

  test("regra de negocio (wallet inexistente) e terminal: ack, sem DLQ", async () => {
    const ghost = { id: "0192f291-27dd-7d3f-8071-5f8685deef37", playerId: "p" };
    await producer.send(command(ghost, "BET", "1.00"));
    expect(await consumer().pollOnce()).toBe(1);
    await expectQueuesEmpty();
    expect(await drain(queues.sqs, queues.dlqUrl)).toEqual([]);
  });

  test("mensagem invalida e permanente: DLQ na hora, sem gastar tentativas", async () => {
    await producer.sendRaw("{nao e json", "grupo-invalido", crypto.randomUUID());
    await producer.sendRaw(JSON.stringify({ messageId: "m", type: "OutraCoisa", data: {} }), "grupo-invalido", crypto.randomUUID());
    let received = 0;
    const c = consumer();
    while (received < 2) received += await c.pollOnce();
    await expectQueuesEmpty();
    const dead = await drain(queues.sqs, queues.dlqUrl);
    expect(dead.length).toBe(2);
    expect(dead.every((m) => m.MessageAttributes?.failureReason?.StringValue === "ValidationError")).toBe(true);
  });

  test("falha transitoria: volta com backoff e passa na tentativa seguinte", async () => {
    const wallet = await openWallet(app, "100.00");
    await producer.send(command(wallet, "BET", "30.00"));
    let calls = 0;
    const flaky = {
      execute: (...args: Parameters<ProcessWagerTransaction["execute"]>) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TransientInfrastructureError("banco fora", "connection"));
        return app.process.execute(...args);
      },
    };
    const c = consumer({ process: flaky });
    expect(await c.pollOnce()).toBe(1);
    expect((await transactionsOf(wallet.id)).length).toBe(0);

    await Bun.sleep(1_200); // backoff de 1 s
    let received = 0;
    for (let i = 0; i < 5 && received === 0; i++) received = await c.pollOnce();
    expect(calls).toBe(2);
    expect((await transactionsOf(wallet.id)).length).toBe(1);
    await expectQueuesEmpty();
  });

  test("falha transitoria que nao passa: depois de maxReceiveCount o redrive leva para a DLQ", async () => {
    const wallet = await openWallet(app, "100.00");
    await producer.send(command(wallet, "BET", "30.00"));
    let calls = 0;
    const broken = {
      execute: () => {
        calls += 1;
        return Promise.reject(new TransientInfrastructureError("banco fora", "connection"));
      },
    };
    const c = consumer({ process: broken });
    for (let i = 0; i < 12 && calls < queues.maxReceiveCount; i++) {
      await c.pollOnce();
      await Bun.sleep(1_100);
    }
    expect(calls).toBe(queues.maxReceiveCount);
    // A proxima leitura dispara o redrive.
    await c.pollOnce();
    const dead = await drain(queues.sqs, queues.dlqUrl);
    expect(dead.length).toBe(1);
    expect(calls).toBe(queues.maxReceiveCount);
    await expectQueuesEmpty();
    expect((await transactionsOf(wallet.id)).length).toBe(0);
  });

  test("SIGTERM: a mensagem em andamento termina e confirma; as que nao comecaram voltam para a fila", async () => {
    const wallet = await openWallet(app, "100.00");
    // Mesmo grupo (wallet): processadas em sequencia, entao a segunda ainda nao comecou quando o stop chega.
    await producer.send(command(wallet, "BET", "10.00"));
    await producer.send(command(wallet, "BET", "20.00"));
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const c = consumer({
      hooks: {
        afterCommit: async () => {
          started();
          await slow;
        },
      },
    });

    const polling = c.pollOnce();
    await firstStarted;
    const stopping = c.stop();
    release();
    await Promise.all([polling, stopping]);

    const txs = await transactionsOf(wallet.id);
    expect(txs.length).toBeGreaterThanOrEqual(1);
    // O que comecou foi confirmado; o que nao comecou esta visivel de novo, sem esperar o timeout.
    const depth = await queueDepth(queues.sqs, queues.queueUrl);
    expect(depth.inFlight).toBe(0);
    expect(depth.visible).toBe(2 - txs.length);

    // Outra instancia pega o resto.
    let received = 0;
    const next = consumer();
    for (let i = 0; i < 5 && received < depth.visible; i++) received += await next.pollOnce();
    expect((await transactionsOf(wallet.id)).length).toBe(2);
    await expectQueuesEmpty();
    expect(await expectLedgerConsistent(db.sql, wallet.id)).toBe("70.00");
  });
});
