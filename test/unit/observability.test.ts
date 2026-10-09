import { afterEach, describe, expect, test } from "bun:test";
import { annotateLogContext, withLogContext, withTrackedLogContext } from "../../src/application/log-context";
import { JsonLogger, type LogSink } from "../../src/infrastructure/observability/json-logger";
import { PrometheusMetrics } from "../../src/infrastructure/observability/prometheus-metrics";
import { sample } from "../support/prometheus";

const original: LogSink = JsonLogger.sink;
afterEach(() => {
  JsonLogger.sink = original;
});

function capture(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  JsonLogger.sink = (line) => lines.push(JSON.parse(line));
  return lines;
}

describe("logs estruturados", () => {
  test("cada linha e JSON com nivel, contexto e os ids de correlacao do contexto corrente", async () => {
    const lines = capture();
    const logger = new JsonLogger("teste");
    await withTrackedLogContext({ correlationId: "corr-1", messageId: "msg-1" }, async () => {
      annotateLogContext({ walletId: "w-1", providerId: "provider-a" });
      await Promise.resolve();
      annotateLogContext({ transactionId: "tx-1" });
      logger.info("processado", { result: "PROCESSED" });
    });
    expect(lines[0]).toMatchObject({
      level: "info",
      context: "teste",
      message: "processado",
      correlationId: "corr-1",
      messageId: "msg-1",
      walletId: "w-1",
      providerId: "provider-a",
      transactionId: "tx-1",
      result: "PROCESSED",
    });
    expect(typeof lines[0]!.time).toBe("string");
  });

  test("fora de um contexto nao ha ids; contextos aninhados herdam", () => {
    const lines = capture();
    const logger = new JsonLogger("teste");
    logger.warn("solto");
    withLogContext({ correlationId: "c" }, () => withLogContext({ walletId: "w" }, () => logger.error("aninhado")));
    expect(lines[0]!.correlationId).toBeUndefined();
    expect(lines[1]).toMatchObject({ correlationId: "c", walletId: "w", level: "error" });
  });

  test("valores financeiros e payloads nunca saem, mesmo se passados por engano", () => {
    const lines = capture();
    new JsonLogger("teste").info("cuidado", {
      money: { amount: "25.00", currency: "BRL" },
      amount: "25.00",
      balance: "975.00",
      payload: { secret: true },
      Authorization: "Bearer x",
      walletId: "w-1",
    });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain("25.00");
    expect(line).not.toContain("975.00");
    expect(line).not.toContain("Bearer");
    expect(lines[0]!.walletId).toBe("w-1");
  });
});

describe("metricas Prometheus", () => {
  test("contadores e histogramas do catalogo aparecem com os rotulos", async () => {
    const metrics = new PrometheusMetrics({ defaultMetrics: false, instanceId: "i-1" });
    metrics.increment("wager_transactions_total", { kind: "BET", status: "PROCESSED" });
    metrics.increment("wager_transactions_total", { kind: "BET", status: "PROCESSED" });
    metrics.observe("wallet_lock_wait_seconds", 0.003);
    const { body, contentType } = await metrics.render();
    expect(contentType).toContain("text/plain");
    expect(sample(body, "wager_transactions_total", { kind: "BET", status: "PROCESSED", instance_id: "i-1" })).toBe(2);
    expect(sample(body, "wallet_lock_wait_seconds_count", { instance_id: "i-1" })).toBe(1);
  });

  test("gauge lido na hora do scrape; falha da fonte vira NaN sem derrubar o scrape", async () => {
    const metrics = new PrometheusMetrics({ defaultMetrics: false });
    let value = 3;
    metrics.addGauge({ name: "outbox_pending_events", help: "x", read: async () => value });
    metrics.addGauge({ name: "sqs_dlq_messages", help: "x", read: async () => Promise.reject(new Error("fora")) });
    expect((await metrics.render()).body).toContain("outbox_pending_events 3");
    value = 0;
    const body = (await metrics.render()).body;
    expect(body).toContain("outbox_pending_events 0");
    expect(body.toLowerCase()).toContain("sqs_dlq_messages nan");
  });
});
