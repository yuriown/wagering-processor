import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { loadConfig } from "../../src/config";
import { createHttpApp } from "../../src/http-app";
import { JsonLogger, type LogSink } from "../../src/infrastructure/observability/json-logger";
import { type TestDatabase, createTestDatabase } from "../support/database";
import { sample } from "../support/prometheus";

/** Observabilidade de ponta a ponta: o que uma requisicao real deixa em log e em /metrics. */
let db: TestDatabase;
let app: INestApplication;
let base: string;
const lines: Record<string, unknown>[] = [];
const originalSink: LogSink = JsonLogger.sink;

beforeAll(async () => {
  JsonLogger.sink = (line) => lines.push(JSON.parse(line));
  db = await createTestDatabase();
  app = await createHttpApp({ ...loadConfig(), databaseUrl: db.url, workers: [], instanceId: "obs-1" }, { logger: false });
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
  JsonLogger.sink = originalSink;
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("observabilidade", () => {
  let walletId: string;
  let transactionId: string;

  beforeAll(async () => {
    const playerId = crypto.randomUUID();
    const created = await fetch(`${base}/wallets`, json({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }));
    const wallet = (await created.json()) as { id: string };
    walletId = wallet.id;
    const bet = {
      providerId: "provider-obs",
      externalTransactionId: "obs-1",
      playerId,
      walletId,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const headers = { "Idempotency-Key": "provider-obs:obs-1", "x-correlation-id": "corr-observado" };
    const submitted = await fetch(`${base}/wagering/transactions`, json(bet, headers));
    transactionId = ((await submitted.json()) as { transactionId: string }).transactionId;
    await fetch(`${base}/wagering/transactions`, json(bet, headers)); // replay
  });

  test("linha de acesso JSON com correlationId, providerId, walletId e transactionId", () => {
    const access = lines.filter((l) => l.message === "http" && l.route === "/wagering/transactions");
    expect(access.length).toBe(2);
    expect(access[0]).toMatchObject({
      level: "info",
      correlationId: "corr-observado",
      providerId: "provider-obs",
      walletId,
      transactionId,
      method: "POST",
      status: 201,
    });
    expect(access[1]).toMatchObject({ status: 200, transactionId });
  });

  test("nenhum log carrega valor financeiro", () => {
    const all = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(all).not.toContain("25.00");
    expect(all).not.toContain("975.00");
    expect(all).not.toContain("1000.00");
  });

  test("/metrics expoe o que o enunciado pede, sem autenticacao", async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    const instance = { instance_id: "obs-1" };
    // transacoes por status
    expect(sample(body, "wager_transactions_total", { kind: "BET", status: "PROCESSED", ...instance })).toBe(1);
    // duplicatas detectadas
    expect(sample(body, "wager_duplicates_total", { source: "http", ...instance })).toBe(1);
    // latencia de processamento (primeira vez e replay)
    expect(sample(body, "wager_processing_seconds_count", { source: "http", status: "PROCESSED", ...instance })).toBe(1);
    expect(sample(body, "wager_processing_seconds_count", { source: "http", status: "REPLAY", ...instance })).toBe(1);
    // conflitos de lock: espera medida e timeouts contados
    expect(sample(body, "wallet_lock_wait_seconds_count", instance)).toBe(1);
    expect(sample(body, "wallet_lock_timeouts_total", instance)).toBe(0);
    // retries e DLQ (contador e profundidade real da DLQ)
    expect(sample(body, "sqs_retries_total", instance)).toBe(0);
    expect(sample(body, "sqs_dlq_messages", instance)).toBeGreaterThanOrEqual(0);
    expect(body).toContain("# TYPE sqs_dlq_total counter");
    // outbox lag real: nenhum relay rodou, ha eventos pendentes ha algum tempo
    expect(sample(body, "outbox_pending_events", instance)).toBe(4);
    expect(sample(body, "outbox_lag_seconds", instance)).toBeGreaterThan(0);
    expect(
      sample(body, "http_requests_total", { method: "POST", route: "/wagering/transactions", status: "201", ...instance }),
    ).toBe(1);
  });
});
